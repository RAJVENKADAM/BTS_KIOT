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

function loadIdempotency() {
  let keyNumber = 0;
  const context = {
    Date,
    Math,
    Map,
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
