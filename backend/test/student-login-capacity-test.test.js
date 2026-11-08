"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  ACCOUNT_COUNT,
  runLoginCapacityTest,
  validateAccounts,
  validateTarget,
} = require("../load-tests/student-login-capacity-test");

const accounts = Array.from({ length: ACCOUNT_COUNT }, (_, index) => ({
  email: `test-account-${index}@example.invalid`,
  password: `synthetic-password-${index}`,
}));

function response(status, data = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => data,
  };
}

test("validates exactly 50 unique account entries", () => {
  assert.equal(validateAccounts(accounts), accounts);
  assert.throws(
    () => validateAccounts(accounts.slice(0, -1)),
    /exactly 50 accounts/,
  );
  const duplicates = accounts.map((account) => ({ ...account }));
  duplicates[49].email = duplicates[0].email.toUpperCase();
  assert.throws(() => validateAccounts(duplicates), /must be unique/);
});

test("starts all 50 requests together and accepts only active student login responses", async () => {
  let releaseResponses;
  const responseGate = new Promise((resolve) => {
    releaseResponses = resolve;
  });
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  let requestCount = 0;

  const run = runLoginCapacityTest({
    baseUrl: "http://127.0.0.1:5000",
    accounts,
    fetchImpl: async () => {
      requestCount += 1;
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      await responseGate;
      activeRequests -= 1;
      return response(200, {
        token: "synthetic-token",
        user: { role: "student", is_active: true },
      });
    },
  });

  while (requestCount < ACCOUNT_COUNT) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(requestCount, ACCOUNT_COUNT);
  assert.equal(maximumActiveRequests, ACCOUNT_COUNT);
  releaseResponses();

  const metrics = await run;
  assert.equal(metrics.successes, ACCOUNT_COUNT);
  assert.equal(metrics.failures, 0);
  assert.equal(metrics.httpStatuses.get("200"), ACCOUNT_COUNT);
  assert.ok(metrics.requestStartSpreadMs >= 0);
});

test("classifies HTTP failures, network errors, timeouts, and inactive/non-student results", async () => {
  const outcomes = [
    () => response(401),
    () => response(403),
    () => response(429),
    () => response(503),
    () => {
      const error = new Error("synthetic network error");
      throw error;
    },
    () => {
      const error = new Error("synthetic timeout");
      error.name = "AbortError";
      throw error;
    },
    () =>
      response(200, {
        token: "synthetic-token",
        user: { role: "student", is_active: false },
      }),
    () =>
      response(200, {
        token: "synthetic-token",
        user: { role: "primary_admin", is_active: true },
      }),
  ];
  let nextOutcome = 0;
  const metrics = await runLoginCapacityTest({
    baseUrl: "http://127.0.0.1:5000",
    accounts,
    fetchImpl: async () => {
      const outcome = outcomes[nextOutcome];
      nextOutcome += 1;
      if (outcome) return outcome();
      return response(200, {
        token: "synthetic-token",
        user: { role: "student", is_active: true },
      });
    },
  });

  assert.equal(metrics.successes, ACCOUNT_COUNT - outcomes.length);
  assert.equal(metrics.failureCategories.get("HTTP 401"), 1);
  assert.equal(metrics.failureCategories.get("HTTP 403"), 1);
  assert.equal(metrics.failureCategories.get("HTTP 429"), 1);
  assert.equal(metrics.failureCategories.get("HTTP 5xx"), 1);
  assert.equal(metrics.failureCategories.get("network error"), 1);
  assert.equal(metrics.failureCategories.get("timeout"), 1);
  assert.equal(
    metrics.failureCategories.get("account not confirmed as active student"),
    2,
  );
});

test("production target is blocked regardless of scheme, case, trailing dot, port, or confirmation", () => {
  const productionVariants = [
    "https://bts-kiot.onrender.com",
    "https://bts-kiot.onrender.com.",
    "https://BTS-KIOT.ONRENDER.COM",
    "http://bts-kiot.onrender.com",
    "https://bts-kiot.onrender.com:444",
    "https://BTS-KIOT.ONRENDER.COM.:8443",
  ];
  for (const target of productionVariants) {
    assert.throws(
      () => validateTarget({
        BTMS_LOGIN_CAPACITY_BASE_URL: target,
        BTMS_CAPACITY_STAGING_HOSTS: "bts-kiot.onrender.com",
        BTMS_CAPACITY_CONFIRM_STAGING: "YES",
        BTMS_CAPACITY_PRODUCTION_CONFIRMATION:
          "I_APPROVE_50_STUDENT_LOGIN_TEST_ON_PRODUCTION",
      }),
      /production host is permanently blocked/,
      target,
    );
  }
});

test("only supported local loopback targets may use HTTP", () => {
  for (const target of [
    "http://localhost:5000",
    "http://127.0.0.1:5000",
    "http://127.12.34.56:5000",
    "http://[::1]:5000",
  ]) {
    assert.equal(validateTarget({ BTMS_LOGIN_CAPACITY_BASE_URL: target }), target);
  }
  for (const target of [
    "http://localhost:5001",
    "http://192.0.2.1:5000",
    "http://staging.example.invalid",
  ]) {
    assert.throws(
      () => validateTarget({
        BTMS_LOGIN_CAPACITY_BASE_URL: target,
        BTMS_CAPACITY_STAGING_HOSTS: "staging.example.invalid",
        BTMS_CAPACITY_CONFIRM_STAGING: "YES",
      }),
    );
  }
});

test("remote HTTPS staging requires an exact allowlist entry and confirmation", () => {
  const env = {
    BTMS_LOGIN_CAPACITY_BASE_URL: "https://staging.example.invalid",
    BTMS_CAPACITY_STAGING_HOSTS: "staging.example.invalid",
    BTMS_CAPACITY_CONFIRM_STAGING: "YES",
  };
  assert.equal(validateTarget(env), "https://staging.example.invalid");
  assert.throws(
    () => validateTarget({
      BTMS_LOGIN_CAPACITY_BASE_URL: "https://not-allowlisted.example.invalid",
      BTMS_CAPACITY_CONFIRM_STAGING: "YES",
    }),
    /not in BTMS_CAPACITY_STAGING_HOSTS/,
  );
  assert.throws(
    () => validateTarget({
      ...env,
      BTMS_CAPACITY_CONFIRM_STAGING: "",
    }),
    /require BTMS_CAPACITY_CONFIRM_STAGING=YES/,
  );
  assert.throws(
    () => validateTarget({
      ...env,
      BTMS_LOGIN_CAPACITY_BASE_URL: "https://staging.example.invalid:8443",
    }),
    /default port/,
  );
});

test("rejects malformed, credentialed, pathful, and unsupported target URLs", () => {
  for (const target of [
    "not-a-url",
    "https://user:password@staging.example.invalid",
    "https://staging.example.invalid/path",
    "https://staging.example.invalid/?query=1",
    "ftp://staging.example.invalid",
  ]) {
    assert.throws(
      () => validateTarget({
        BTMS_LOGIN_CAPACITY_BASE_URL: target,
        BTMS_CAPACITY_STAGING_HOSTS: "staging.example.invalid",
        BTMS_CAPACITY_CONFIRM_STAGING: "YES",
      }),
      undefined,
      target,
    );
  }
});

test("programmatic runner rejects production before calling fetch", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    () => runLoginCapacityTest({
      baseUrl: "https://bts-kiot.onrender.com.",
      accounts,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("Network requests must not occur.");
      },
    }),
    /production host is permanently blocked/,
  );
  assert.equal(fetchCalls, 0);
});

test("login runner rejects unsafe request timeouts before calling fetch", async () => {
  let fetchCalls = 0;
  for (const timeoutMs of [0, -1, NaN, Infinity, 120_001]) {
    await assert.rejects(
      () => runLoginCapacityTest({
        baseUrl: "http://127.0.0.1:5000",
        accounts,
        timeoutMs,
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error("Network requests must not occur.");
        },
      }),
    );
  }
  assert.equal(fetchCalls, 0);
});
