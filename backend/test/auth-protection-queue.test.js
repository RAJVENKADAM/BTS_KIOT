"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  createWorkLimiter,
  readIntegerEnv,
} = require("../src/utils/authProtection");

test("work limiter bounds concurrent and queued operations", async () => {
  const limiter = createWorkLimiter({
    maxActive: 1,
    maxQueued: 1,
    maxWaitMs: 1000,
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = limiter.run(() => gate);
  const second = limiter.run(async () => "queued");

  assert.deepEqual(limiter.getStatus(), { active: 1, queued: 1 });
  await assert.rejects(
    limiter.run(async () => "overflow"),
    (error) => error.status === 503 && error.code === "AUTH_BUSY",
  );
  release("active");
  assert.equal(await first, "active");
  assert.equal(await second, "queued");
  assert.deepEqual(limiter.getStatus(), { active: 0, queued: 0 });
});

test("queued work expires after its configured maximum wait", async () => {
  const limiter = createWorkLimiter({
    maxActive: 1,
    maxQueued: 1,
    maxWaitMs: 15,
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const active = limiter.run(() => gate);
  const queued = limiter.run(async () => "must not run");

  await assert.rejects(
    queued,
    (error) => error.status === 503 && error.code === "AUTH_BUSY",
  );
  assert.deepEqual(limiter.getStatus(), { active: 1, queued: 0 });
  release("complete");
  assert.equal(await active, "complete");
  assert.deepEqual(limiter.getStatus(), { active: 0, queued: 0 });
});

test("queue configuration rejects invalid, non-integer, and out-of-range values", () => {
  const original = process.env.TEST_QUEUE_LIMIT;
  try {
    delete process.env.TEST_QUEUE_LIMIT;
    assert.equal(readIntegerEnv("TEST_QUEUE_LIMIT", 4, { max: 8 }), 4);
    process.env.TEST_QUEUE_LIMIT = "0";
    assert.throws(
      () => readIntegerEnv("TEST_QUEUE_LIMIT", 4, { max: 8 }),
      /between 1 and 8/,
    );
    process.env.TEST_QUEUE_LIMIT = "1.5";
    assert.throws(
      () => readIntegerEnv("TEST_QUEUE_LIMIT", 4, { max: 8 }),
      /must be an integer/,
    );
    process.env.TEST_QUEUE_LIMIT = "9";
    assert.throws(
      () => readIntegerEnv("TEST_QUEUE_LIMIT", 4, { max: 8 }),
      /between 1 and 8/,
    );
  } finally {
    if (original === undefined) delete process.env.TEST_QUEUE_LIMIT;
    else process.env.TEST_QUEUE_LIMIT = original;
  }
});
