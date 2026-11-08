"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  INDEX_NAME,
  createLoginAttemptLimiter,
} = require("../src/utils/loginAttemptLimiter");

function createFakeMongo({
  indexes = true,
  transactionError = null,
  listIndexesError = null,
  upsertError = null,
  findOneError = null,
  startSessionError = null,
  transactionOperation = null,
  abortError = null,
} = {}) {
  let documents = new Map();
  let transactionTail = Promise.resolve();
  let abortCount = 0;
  const indexList = indexes
    ? [
        { name: "_id_", key: { _id: 1 } },
        {
          name: INDEX_NAME,
          key: { expiresAt: 1 },
          expireAfterSeconds: 0,
        },
      ]
    : [{ name: "_id_", key: { _id: 1 } }];

  const collection = {
    listIndexes: () => ({
      toArray: async () => {
        if (listIndexesError) throw listIndexesError;
        return indexList;
      },
    }),
    updateOne: async ({ _id }, update, { upsert } = {}) => {
      if (upsertError) throw upsertError;
      if (!documents.has(_id) && upsert) {
        documents.set(_id, structuredClone(update.$setOnInsert));
      }
      return { acknowledged: true };
    },
    findOne: async ({ _id }, { session } = {}) => {
      if (findOneError) throw findOneError;
      const source = session?.documents || documents;
      const document = source.get(_id);
      return document ? structuredClone(document) : null;
    },
    replaceOne: async ({ _id }, replacement, { session } = {}) => {
      (session?.documents || documents).set(_id, structuredClone(replacement));
      return { acknowledged: true };
    },
    deleteOne: async ({ _id }, { session } = {}) => {
      (session?.documents || documents).delete(_id);
      return { acknowledged: true };
    },
  };
  const mongo = {
    connection: { readyState: 1 },
    startSession: async () => {
      if (startSessionError) throw startSessionError;
      return {
        documents: null,
        withTransaction: async function (operation) {
          if (transactionError) throw transactionError;
          if (transactionOperation) {
            return transactionOperation(operation, this);
          }
          let release;
          const previous = transactionTail;
          transactionTail = new Promise((resolve) => {
            release = resolve;
          });
          await previous;
          this.documents = new Map(
            [...documents].map(([key, value]) => [key, structuredClone(value)]),
          );
          try {
            const result = await operation(this);
            documents = this.documents;
            return result;
          } catch (error) {
            await this.abortTransaction();
            throw error;
          } finally {
            this.documents = null;
            release();
          }
        },
        abortTransaction: async () => {
          abortCount += 1;
          if (abortError) throw abortError;
        },
        endSession: async () => {},
      };
    },
  };

  return {
    collection,
    mongo,
    documents: () => documents,
    getAbortCount: () => abortCount,
  };
}

function createLimiter(fake, options = {}) {
  return createLoginAttemptLimiter({
    mongoose: fake.mongo,
    collection: fake.collection,
    secretProvider: () => "unit-test-only-stable-secret",
    now: options.now || (() => 1_000_000),
    windowMs: options.windowMs || 900_000,
    accountLimit: options.accountLimit || 10,
    pendingReservationTtlMs: options.pendingReservationTtlMs || 120_000,
    transactionTimeoutMs: options.transactionTimeoutMs ?? 100,
    indexCheckIntervalMs: 60_000,
  });
}

test("account failures are shared atomically across limiter instances and source IPs", async () => {
  const fake = createFakeMongo();
  const options = { accountLimit: 2 };
  const firstInstance = createLimiter(fake, options);
  const secondInstance = createLimiter(fake, options);
  const results = await Promise.all([
    firstInstance.reserveLoginAttempt("student@example.edu", { ip: "192.0.2.1" }),
    secondInstance.reserveLoginAttempt("student@example.edu", { ip: "192.0.2.2" }),
    firstInstance.reserveLoginAttempt("student@example.edu", { ip: "192.0.2.3" }),
  ]);

  assert.equal(results.filter((result) => result.allowed).length, 2);
  assert.equal(results.find((result) => !result.allowed).source, "account");
  assert.equal(fake.documents().size, 1);
});

test("concurrent failed reservations for one account cannot exceed the account budget", async () => {
  const fake = createFakeMongo();
  const limiter = createLimiter(fake, {
    accountLimit: 2,
  });
  const reservations = await Promise.all([
    limiter.reserveLoginAttempt("race@example.edu", { ip: "192.0.2.1" }),
    limiter.reserveLoginAttempt("race@example.edu", { ip: "192.0.2.2" }),
    limiter.reserveLoginAttempt("race@example.edu", { ip: "192.0.2.3" }),
  ]);
  assert.equal(reservations.filter(({ allowed }) => allowed).length, 2);
  for (const [index, reservation] of reservations.entries()) {
    if (!reservation.allowed) continue;
    await limiter.markLoginAttemptFailed(
      "race@example.edu",
      reservation.reservationId,
      `192.0.2.${index + 1}`,
    );
  }
  const afterFailures = await limiter.reserveLoginAttempt(
    "race@example.edu",
    { ip: "192.0.2.4" },
  );
  assert.equal(afterFailures.allowed, false);
  assert.equal(afterFailures.source, "account");
});

test("50 distinct accounts sharing a campus IP are not throttled", async () => {
  const fake = createFakeMongo();
  const limiter = createLimiter(fake, {
    accountLimit: 10,
  });
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      limiter.reserveLoginAttempt(`student-${index}@example.edu`, {
        ip: "198.51.100.8",
      }),
    ),
  );
  assert.equal(results.filter((result) => result.allowed).length, 50);
  assert.ok(results.every((result) => result.source === "account"));
  assert.equal(fake.documents().size, 50);
  assert.ok([...fake.documents().keys()].every((key) => key.startsWith("account:")));
});

test("account threshold applies across IPs and retry delay expires with the window", async () => {
  let timestamp = 2_000_000;
  const fake = createFakeMongo();
  const limiter = createLoginAttemptLimiter({
    mongoose: fake.mongo,
    collection: fake.collection,
    secretProvider: () => "unit-test-only-stable-secret",
    now: () => timestamp,
    windowMs: 10_000,
    accountLimit: 2,
    transactionTimeoutMs: 100,
  });

  const first = await limiter.reserveLoginAttempt("person@example.edu", {
    ip: "192.0.2.1",
  });
  const second = await limiter.reserveLoginAttempt("person@example.edu", {
    ip: "192.0.2.2",
  });
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  await limiter.markLoginAttemptFailed(
    "person@example.edu",
    first.reservationId,
    "192.0.2.1",
  );
  await limiter.markLoginAttemptFailed(
    "person@example.edu",
    second.reservationId,
    "192.0.2.2",
  );
  const blocked = await limiter.reserveLoginAttempt("person@example.edu", {
    ip: "192.0.2.3",
  });
  assert.deepEqual(
    { allowed: blocked.allowed, source: blocked.source, retryAfter: blocked.retryAfter },
    { allowed: false, source: "account", retryAfter: 10 },
  );

  timestamp += 10_000;
  const afterExpiry = await limiter.reserveLoginAttempt("person@example.edu", {
    ip: "192.0.2.3",
  });
  assert.equal(afterExpiry.allowed, true);
});

test("successful login truly clears account failures but retains in-flight reservations", async () => {
  const fake = createFakeMongo();
  const limiter = createLimiter(fake, { accountLimit: 3 });
  const failed = await limiter.reserveLoginAttempt("person@example.edu", {
    ip: "192.0.2.1",
  });
  await limiter.markLoginAttemptFailed(
    "person@example.edu",
    failed.reservationId,
    "192.0.2.1",
  );
  const pendingDevice = await limiter.reserveLoginAttempt("person@example.edu", {
    ip: "192.0.2.2",
  });
  const successful = await limiter.reserveLoginAttempt("person@example.edu", {
    ip: "192.0.2.3",
  });
  await limiter.completeLoginAttempt(
    "person@example.edu",
    successful.reservationId,
    "192.0.2.3",
  );

  const nextAccountAttempt = await limiter.reserveLoginAttempt(
    "person@example.edu",
    { ip: "192.0.2.3" },
  );
  assert.equal(nextAccountAttempt.allowed, true);

  const blockedIpAttempt = await limiter.reserveLoginAttempt(
    "another@example.edu",
    { ip: "192.0.2.1" },
  );
  assert.equal(blockedIpAttempt.allowed, true);

  const firstAccountAttempt = nextAccountAttempt;
  const secondAccountAttempt = await limiter.reserveLoginAttempt(
    "person@example.edu",
    { ip: "192.0.2.5" },
  );
  assert.equal(firstAccountAttempt.allowed, true);
  assert.equal(secondAccountAttempt.allowed, true);
  const thirdAccountAttempt = await limiter.reserveLoginAttempt(
    "person@example.edu",
    { ip: "192.0.2.6" },
  );
  assert.equal(thirdAccountAttempt.allowed, false);
  assert.equal(thirdAccountAttempt.source, "account");
  await limiter.releaseLoginAttempt(
    "person@example.edu",
    pendingDevice.reservationId,
    "192.0.2.2",
  );
});

test("multiple active devices for one account reserve independently", async () => {
  const limiter = createLimiter(createFakeMongo(), {
    accountLimit: 3,
  });
  const attempts = await Promise.all(
    ["192.0.2.1", "192.0.2.2", "192.0.2.3"].map((ip) =>
      limiter.reserveLoginAttempt("shared@example.edu", { ip }),
    ),
  );
  assert.equal(attempts.filter(({ allowed }) => allowed).length, 3);
});

test("missing TTL index, disconnected MongoDB, and unsupported transactions fail closed", async () => {
  const missingIndex = createLimiter(createFakeMongo({ indexes: false }));
  await assert.rejects(
    missingIndex.reserveLoginAttempt("person@example.edu", { ip: "192.0.2.1" }),
    (error) =>
      error.status === 503 && error.code === "LOGIN_LIMITER_UNAVAILABLE",
  );

  const disconnectedFake = createFakeMongo();
  disconnectedFake.mongo.connection.readyState = 0;
  const disconnected = createLimiter(disconnectedFake);
  await assert.rejects(
    disconnected.reserveLoginAttempt("person@example.edu", { ip: "192.0.2.1" }),
    (error) =>
      error.status === 503 && error.code === "LOGIN_LIMITER_UNAVAILABLE",
  );

  const unsupported = createLimiter(
    createFakeMongo({
      transactionError: new Error("Transaction numbers are only allowed"),
    }),
  );
  await assert.rejects(
    unsupported.reserveLoginAttempt("person@example.edu", { ip: "192.0.2.1" }),
    (error) =>
      error.status === 503 &&
      error.code === "LOGIN_LIMITER_UNAVAILABLE" &&
      error.failureStage === "LOGIN_LIMITER_TRANSACTION_FAILED" &&
      error.cause.message === "Transaction numbers are only allowed",
  );
});

test("TTL verification rejects missing, extra-key, and incorrect-expiration indexes", async (t) => {
  const invalidIndexes = [
    { name: INDEX_NAME, key: { expiresAt: 1 } },
    {
      name: INDEX_NAME,
      key: { expiresAt: 1, account: 1 },
      expireAfterSeconds: 0,
    },
    {
      name: INDEX_NAME,
      key: { expiresAt: 1 },
      expireAfterSeconds: 60,
    },
  ];
  for (const [index, ttlIndex] of invalidIndexes.entries()) {
    await t.test(`invalid index ${index + 1}`, async () => {
      const fake = createFakeMongo();
      fake.collection.listIndexes = () => ({
        toArray: async () => [{ name: "_id_", key: { _id: 1 } }, ttlIndex],
      });
      const limiter = createLimiter(fake);
      await assert.rejects(
        limiter.reserveLoginAttempt("index@example.edu"),
        (error) =>
          error.failureStage === "LOGIN_LIMITER_INDEX_CHECK_FAILED" &&
          error.cause.code === "LOGIN_LIMITER_TTL_INDEX_INVALID",
      );
    });
  }
});

test("index inspection failure preserves MongoDB error metadata and fails closed", async () => {
  const mongoError = Object.assign(
    new Error("not authorized to list indexes"),
    { code: 13, codeName: "Unauthorized" },
  );
  const limiter = createLimiter(createFakeMongo({ listIndexesError: mongoError }));
  await assert.rejects(
    limiter.reserveLoginAttempt("index-failure@example.edu"),
    (error) =>
      error.status === 503 &&
      error.failureStage === "LOGIN_LIMITER_INDEX_CHECK_FAILED" &&
      error.cause === mongoError &&
      error.cause.code === 13 &&
      error.cause.codeName === "Unauthorized",
  );
});

test("bucket upsert failures preserve cause and stage", async () => {
  const mongoError = Object.assign(new Error("bucket write denied"), {
    code: 13,
    codeName: "Unauthorized",
  });
  const limiter = createLimiter(createFakeMongo({ upsertError: mongoError }));
  await assert.rejects(
    limiter.reserveLoginAttempt("upsert-failure@example.edu"),
    (error) =>
      error.status === 503 &&
      error.failureStage === "LOGIN_LIMITER_BUCKET_UPSERT_FAILED" &&
      error.cause === mongoError,
  );
});

test("transaction start failures are diagnosed as transaction failures", async () => {
  const mongoError = Object.assign(new Error("session start rejected"), {
    code: 20,
    codeName: "IllegalOperation",
  });
  const limiter = createLimiter(
    createFakeMongo({ startSessionError: mongoError }),
  );
  await assert.rejects(
    limiter.reserveLoginAttempt("session-failure@example.edu"),
    (error) =>
      error.failureStage === "LOGIN_LIMITER_TRANSACTION_FAILED" &&
      error.cause === mongoError &&
      error.cause.codeName === "IllegalOperation",
  );
});

test("transaction permission rejection retains its cause and metadata", async () => {
  const mongoError = Object.assign(
    new Error("not authorized to execute transaction"),
    { code: 13, codeName: "Unauthorized", errorLabels: ["TransientTransactionError"] },
  );
  const limiter = createLimiter(createFakeMongo({ transactionError: mongoError }));
  await assert.rejects(
    limiter.reserveLoginAttempt("transaction-permission@example.edu"),
    (error) =>
      error.failureStage === "LOGIN_LIMITER_TRANSACTION_FAILED" &&
      error.cause === mongoError &&
      error.cause.code === 13 &&
      error.cause.errorLabels.includes("TransientTransactionError"),
  );
});

test("transaction operation failure aborts and preserves the original error", async () => {
  const mongoError = Object.assign(new Error("bucket read failed"), {
    code: 91,
    codeName: "ShutdownInProgress",
  });
  const fake = createFakeMongo({ findOneError: mongoError });
  const limiter = createLimiter(fake);
  await assert.rejects(
    limiter.reserveLoginAttempt("transaction-abort@example.edu"),
    (error) =>
      error.status === 503 &&
      error.failureStage === "LOGIN_LIMITER_TRANSACTION_FAILED" &&
      error.cause === mongoError,
  );
  assert.equal(fake.getAbortCount(), 1);
});

test("transaction timeout fails closed and aborts the MongoDB session", async () => {
  const fake = createFakeMongo({
    transactionOperation: () => new Promise(() => {}),
  });
  const limiter = createLimiter(fake, { transactionTimeoutMs: 5 });
  await assert.rejects(
    limiter.reserveLoginAttempt("transaction-timeout@example.edu"),
    (error) =>
      error.status === 503 &&
      error.failureStage === "LOGIN_LIMITER_TRANSACTION_TIMEOUT" &&
      error.cause.code === "LOGIN_LIMITER_TRANSACTION_TIMEOUT",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.getAbortCount(), 1);
});

test("timeout abort failures are safely diagnosed without changing the 503", async () => {
  const originalError = console.error;
  const entries = [];
  console.error = (...args) => entries.push(args);
  const abortError = Object.assign(new Error("abort failed"), {
    code: 91,
    codeName: "ShutdownInProgress",
  });
  try {
    const fake = createFakeMongo({
      transactionOperation: () => new Promise(() => {}),
      abortError,
    });
    const limiter = createLimiter(fake, { transactionTimeoutMs: 5 });
    await assert.rejects(
      limiter.reserveLoginAttempt("abort-failure@example.edu"),
      (error) =>
        error.status === 503 &&
        error.failureStage === "LOGIN_LIMITER_TRANSACTION_TIMEOUT",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      entries.some(
        ([, details]) =>
          details.stage === "LOGIN_LIMITER_TRANSACTION_ABORT_FAILED" &&
          details.code === 91 &&
          details.codeName === "ShutdownInProgress",
      ),
    );
  } finally {
    console.error = originalError;
  }
});

test("limiter diagnostics redact MongoDB URIs and account identifiers", async () => {
  const originalError = console.error;
  const originalUri = process.env.MONGODB_URI;
  const originalSecret = process.env.JWT_SECRET;
  const uri = "mongodb+srv://operator:password@private.example.test/db";
  const secret = "limiter-diagnostic-secret";
  const email = "private.student@example.edu";
  const entries = [];
  process.env.MONGODB_URI = uri;
  process.env.JWT_SECRET = secret;
  console.error = (...args) => entries.push(args);
  try {
    const mongoError = Object.assign(
      new Error(`denied ${uri} for ${email}; secret=${secret}`),
      { code: 13, codeName: "Unauthorized", errorLabels: ["TransientTransactionError"] },
    );
    const limiter = createLimiter(
      createFakeMongo({ listIndexesError: mongoError }),
    );
    await assert.rejects(limiter.reserveLoginAttempt(email));
  } finally {
    console.error = originalError;
    if (originalUri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = originalUri;
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  }
  const serialized = JSON.stringify(entries);
  assert.match(serialized, /LOGIN_LIMITER_INDEX_CHECK_FAILED/);
  assert.match(serialized, /Unauthorized/);
  assert.equal(serialized.includes(uri), false);
  assert.equal(serialized.includes("password"), false);
  assert.equal(serialized.includes(email), false);
  assert.equal(serialized.includes(secret), false);
});

test("single-instance login limiting succeeds without Redis configuration", async () => {
  const previousMode = process.env.SOCKET_IO_MODE;
  const previousRedisUrl = process.env.REDIS_URL;
  const previousSocketRedisUrl = process.env.SOCKET_IO_REDIS_URL;
  process.env.SOCKET_IO_MODE = "single-instance";
  delete process.env.REDIS_URL;
  delete process.env.SOCKET_IO_REDIS_URL;
  try {
    const limiter = createLimiter(createFakeMongo());
    const result = await limiter.reserveLoginAttempt("no-redis@example.edu");
    assert.equal(result.allowed, true);
    assert.equal(result.source, "account");
  } finally {
    if (previousMode === undefined) delete process.env.SOCKET_IO_MODE;
    else process.env.SOCKET_IO_MODE = previousMode;
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedisUrl;
    if (previousSocketRedisUrl === undefined) {
      delete process.env.SOCKET_IO_REDIS_URL;
    } else {
      process.env.SOCKET_IO_REDIS_URL = previousSocketRedisUrl;
    }
  }
});

test("pending reservations expire and report the correct retry delay", async () => {
  let timestamp = 10_000;
  const fake = createFakeMongo();
  const limiter = createLoginAttemptLimiter({
    mongoose: fake.mongo,
    collection: fake.collection,
    secretProvider: () => "unit-test-only-stable-secret",
    now: () => timestamp,
    windowMs: 10_000,
    accountLimit: 1,
    pendingReservationTtlMs: 1_000,
    transactionTimeoutMs: 100,
  });
  const first = await limiter.reserveLoginAttempt("pending@example.edu", {
    ip: "192.0.2.1",
  });
  assert.equal(first.allowed, true);
  const blocked = await limiter.reserveLoginAttempt("pending@example.edu", {
    ip: "192.0.2.1",
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfter, 1);
  timestamp += 1_001;
  const afterPendingExpiry = await limiter.reserveLoginAttempt(
    "pending@example.edu",
    { ip: "192.0.2.1" },
  );
  assert.equal(afterPendingExpiry.allowed, true);
});

test("failed attempts expire at the configured account window", async () => {
  let timestamp = 20_000;
  const fake = createFakeMongo();
  const limiter = createLoginAttemptLimiter({
    mongoose: fake.mongo,
    collection: fake.collection,
    secretProvider: () => "unit-test-only-stable-secret",
    now: () => timestamp,
    windowMs: 1_000,
    accountLimit: 1,
    pendingReservationTtlMs: 200,
    transactionTimeoutMs: 100,
  });
  const failed = await limiter.reserveLoginAttempt("failed@example.edu", {
    ip: "192.0.2.1",
  });
  await limiter.markLoginAttemptFailed(
    "failed@example.edu",
    failed.reservationId,
    "192.0.2.1",
  );
  timestamp += 1_001;
  const afterFailureExpiry = await limiter.reserveLoginAttempt(
    "failed@example.edu",
    { ip: "192.0.2.2" },
  );
  assert.equal(afterFailureExpiry.allowed, true);
});
