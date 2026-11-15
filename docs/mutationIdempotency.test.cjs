"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(
  path.join(__dirname, "mutationIdempotency.js"),
  "utf8",
);

class FormDataDouble {
  constructor(entries) {
    this.values = entries;
  }

  entries() {
    return this.values[Symbol.iterator]();
  }
}

function loadIdempotency() {
  let keyNumber = 0;
  const context = {
    Date,
    Math,
    Map,
    FormData: FormDataDouble,
    crypto: {
      randomUUID: () => `00000000-0000-4000-8000-${String(++keyNumber).padStart(12, "0")}`,
    },
  };
  vm.runInNewContext(source, context);
  return context.BTMS_IDEMPOTENCY;
}

test("plan-mapping request keys are reused for retries and renewed for new operations", () => {
  const idempotency = loadIdempotency();
  const body = JSON.stringify({ planName: "PLAN B", clusterName: "Cluster 1" });
  const keys = idempotency.createKeyStore();

  const firstKey = keys.get(body);
  assert.equal(keys.get(body), firstKey);
  assert.notEqual(keys.get(JSON.stringify({ planName: "PLAN B" })), firstKey);

  keys.complete(body);
  assert.notEqual(keys.get(body), firstKey);
  assert.notEqual(idempotency.createKeyStore().get(body), firstKey);
});

test("plan-mapping requests attach the key using the required header name", () => {
  const idempotency = loadIdempotency();
  const headers = new Map();
  idempotency.setHeader(
    { set: (name, value) => headers.set(name.toLowerCase(), value) },
    "00000000-0000-4000-8000-000000000001",
  );

  assert.equal(
    headers.get("idempotency-key"),
    "00000000-0000-4000-8000-000000000001",
  );
});

test("dashboard mutating requests attach stable keys until a successful completion", () => {
  const idempotency = loadIdempotency();
  const keyStore = idempotency.createRequestKeyStore();
  const body = JSON.stringify({ expectedVersion: 4, name: "Bus A" });
  const firstHeaders = new Map();
  const firstSignature = keyStore.prepare(
    { set: (name, value) => firstHeaders.set(name.toLowerCase(), value) },
    "POST",
    "/api/superadmin/users",
    body,
  );
  const retryHeaders = new Map();
  keyStore.prepare(
    { set: (name, value) => retryHeaders.set(name.toLowerCase(), value) },
    "POST",
    "/api/superadmin/users",
    body,
  );

  assert.ok(firstHeaders.get("idempotency-key").length >= 8);
  assert.equal(
    retryHeaders.get("idempotency-key"),
    firstHeaders.get("idempotency-key"),
  );
  keyStore.complete(firstSignature);

  const nextHeaders = new Map();
  keyStore.prepare(
    { set: (name, value) => nextHeaders.set(name.toLowerCase(), value) },
    "POST",
    "/api/superadmin/users",
    body,
  );
  assert.notEqual(
    nextHeaders.get("idempotency-key"),
    firstHeaders.get("idempotency-key"),
  );
});

test("dashboard read requests do not receive mutation keys", () => {
  const idempotency = loadIdempotency();
  const headers = new Map();
  const signature = idempotency.createRequestKeyStore().prepare(
    { set: (name, value) => headers.set(name.toLowerCase(), value) },
    "GET",
    "/api/bus/plan-mappings",
  );

  assert.equal(signature, null);
  assert.equal(headers.has("idempotency-key"), false);
});

test("dashboard upload retries with the same file reuse their idempotency key", () => {
  const idempotency = loadIdempotency();
  const keyStore = idempotency.createRequestKeyStore();
  const file = {
    name: "routes.xlsx",
    size: 1024,
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    lastModified: 100,
  };
  const createForm = () => new FormDataDouble([["file", file]]);
  const firstHeaders = new Map();
  const firstSignature = keyStore.prepare(
    { set: (name, value) => firstHeaders.set(name.toLowerCase(), value) },
    "POST",
    "/api/bus/import-routes",
    createForm(),
  );
  const retryHeaders = new Map();
  keyStore.prepare(
    { set: (name, value) => retryHeaders.set(name.toLowerCase(), value) },
    "POST",
    "/api/bus/import-routes",
    createForm(),
  );

  assert.equal(
    retryHeaders.get("idempotency-key"),
    firstHeaders.get("idempotency-key"),
  );
  keyStore.complete(firstSignature);
});
