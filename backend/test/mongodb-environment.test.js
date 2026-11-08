"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  assertSafeDatabaseTarget,
  buildMongoURI,
  getMongoConnectionOptions,
} = require("../src/config/mongodb");

test("MongoDB URI construction is lazy and does not read environment at import time", () => {
  assert.equal(
    buildMongoURI({
      MONGODB_URI: "mongodb://127.0.0.1:27017/?retryWrites=true",
      DB_NAME: "btms_test",
    }),
    "mongodb://127.0.0.1:27017/btms_test?retryWrites=true",
  );
  assert.throws(() => buildMongoURI({}), /MONGODB_URI is required/);
});

test("unit tests cannot connect to any MongoDB target", () => {
  assert.throws(
    () =>
      assertSafeDatabaseTarget({
        NODE_ENV: "test",
        TEST_ENVIRONMENT: "unit",
        MONGODB_URI: "mongodb://127.0.0.1:27017/btms_test",
      }),
    /disabled for unit tests/,
  );
  assert.throws(
    () =>
      assertSafeDatabaseTarget({
        NODE_ENV: "test",
        TEST_ENVIRONMENT: "local-integration",
        MONGODB_URI: "mongodb+srv://example.invalid/btms_test",
      }),
    /loopback MongoDB/,
  );
});

test("local integration is restricted to loopback and dedicated test database names", () => {
  assert.doesNotThrow(() =>
    assertSafeDatabaseTarget({
      NODE_ENV: "test",
      TEST_ENVIRONMENT: "local-integration",
      MONGODB_URI: "mongodb://localhost:27017/btms_test_phase1",
    }),
  );
  for (const MONGODB_URI of [
    "mongodb://127.0.0.1:27017/bts_db",
    "mongodb://192.168.1.20:27017/btms_test",
    "mongodb://example.invalid:27017/btms_test",
  ]) {
    assert.throws(
      () =>
        assertSafeDatabaseTarget({
          NODE_ENV: "test",
          TEST_ENVIRONMENT: "local-integration",
          MONGODB_URI,
        }),
      /loopback MongoDB and a btms_test database/,
    );
  }
});

test("MongoDB pool wait is bounded and pool settings are validated", () => {
  assert.deepEqual(getMongoConnectionOptions({}), {
    maxPoolSize: 100,
    waitQueueTimeoutMS: 10_000,
  });
  assert.deepEqual(
    getMongoConnectionOptions({
      MONGODB_MAX_POOL_SIZE: "250",
      MONGODB_WAIT_QUEUE_TIMEOUT_MS: "5000",
    }),
    { maxPoolSize: 250, waitQueueTimeoutMS: 5000 },
  );
  assert.throws(
    () => getMongoConnectionOptions({ MONGODB_WAIT_QUEUE_TIMEOUT_MS: "0" }),
    /MONGODB_WAIT_QUEUE_TIMEOUT_MS/,
  );
  assert.throws(
    () => getMongoConnectionOptions({ MONGODB_MAX_POOL_SIZE: "501" }),
    /MONGODB_MAX_POOL_SIZE/,
  );
});
