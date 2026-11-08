"use strict";

const assert = require("node:assert/strict");
const { Int32, Long } = require("mongodb");
const test = require("node:test");
const {
  GPS_WORKER_OWNERSHIP_ID,
  createGpsWorkerOwnershipService,
} = require("../src/services/gpsWorkerOwnership");

function createMemoryOwnershipHarness({
  initialToken = 9n,
  expiresAt = 0,
  now = 0,
  commitFailures = [],
} = {}) {
  let serverNow = now;
  let record = {
    _id: GPS_WORKER_OWNERSHIP_ID,
    token: Long.fromString(initialToken.toString()),
    ownerId: null,
    state: "inactive",
    leaseExpiresAt: new Date(expiresAt),
    writeVersion: Long.ZERO,
    configVersion: Long.ZERO,
    updatedAt: new Date(now),
  };
  let nextOwnerId = 0;
  let commitFailureIndex = 0;
  const activationOptions = [];
  const transactionOptions = [];
  const ownershipReadOptions = [];
  const bsonTypeOf = (value) =>
    value?._bsontype === "Long"
      ? "long"
      : Array.isArray(value)
        ? "array"
        : value instanceof Date
          ? "date"
          : value === null
            ? "null"
            : typeof value === "string"
              ? "string"
              : typeof value === "number"
                ? "double"
                : "missing";
  const matchesCounterExpression = (expression) => {
    if (Array.isArray(expression)) {
      return expression.every(matchesCounterExpression);
    }
    if (!expression || typeof expression !== "object") return true;

    if (Array.isArray(expression.$and)) {
      return expression.$and.every(matchesCounterExpression);
    }
    if (Array.isArray(expression.$or)) {
      return expression.$or.some(matchesCounterExpression);
    }

    if (
      Array.isArray(expression.$eq) &&
      expression.$eq[0] &&
      typeof expression.$eq[0] === "object" &&
      Object.hasOwn(expression.$eq[0], "$type") &&
      typeof expression.$eq[1] === "string"
    ) {
      const field = expression.$eq[0].$type.slice(1);
      return bsonTypeOf(record[field]) === expression.$eq[1];
    }

    if (
      Object.hasOwn(expression, "$type") &&
      typeof expression.$type === "string" &&
      expression.$type.startsWith("$")
    ) {
      return true;
    }

    for (const operator of ["$eq", "$gte", "$lt"]) {
      const operands = expression[operator];
      if (!Array.isArray(operands)) continue;
      const field = operands.find(
        (operand) =>
          typeof operand === "string" &&
          ["$token", "$writeVersion", "$configVersion"].includes(operand),
      );
      const expected = operands.find(
        (operand) => operand?._bsontype === "Long",
      );
      if (!field || !expected) continue;

      const actual = record[field.slice(1)];
      if (actual?._bsontype !== "Long") return false;
      if (operator === "$eq" && !actual.equals(expected)) return false;
      if (operator === "$gte" && actual.lessThan(expected)) return false;
      if (operator === "$lt" && !actual.lessThan(expected)) return false;
    }
    return Object.values(expression).every(matchesCounterExpression);
  };
  const matchesCounterFilter = (filter) =>
    matchesCounterExpression(filter.$expr);

  const collection = {
    async findOneAndUpdate(filter, pipeline, options) {
      activationOptions.push(options);
      assert.equal(filter._id, GPS_WORKER_OWNERSHIP_ID);
      assert.ok(filter.$expr);
      if (!matchesCounterFilter(filter)) return null;
      if (!record.token.lessThan(Long.MAX_VALUE)) return null;
      const claimable =
        record.state === "inactive" ||
        record.leaseExpiresAt.getTime() <= serverNow;
      if (!claimable) return null;
      const update = pipeline[0].$set;
      record = {
        ...record,
        token: record.token.add(Long.ONE),
        ownerId: update.ownerId,
        state: update.state,
        leaseExpiresAt: new Date(serverNow + update.leaseExpiresAt.$dateAdd.amount),
        updatedAt: new Date(serverNow),
      };
      return { ...record };
    },
    async findOne(filter, options = {}) {
      assert.equal(filter._id, GPS_WORKER_OWNERSHIP_ID);
      ownershipReadOptions.push(options);
      return record ? { ...record } : null;
    },
    async updateOne(filter, pipeline, options = {}) {
      if (options.session) {
        if (filter.ownerId === undefined) {
          if (!matchesCounterFilter(filter)) return { matchedCount: 0, modifiedCount: 0 };
          record = {
            ...record,
            configVersion: record.configVersion.add(Long.ONE),
            writeVersion: record.writeVersion.add(Long.ONE),
            updatedAt: new Date(serverNow),
          };
          return { matchedCount: 1, modifiedCount: 1 };
        }
        if (
          filter.ownerId !== record.ownerId ||
          !matchesCounterFilter(filter) ||
          record.state !== "active" ||
          record.leaseExpiresAt.getTime() <= serverNow
        ) {
          return { matchedCount: 0, modifiedCount: 0 };
        }
        record = {
          ...record,
          writeVersion: record.writeVersion.add(Long.ONE),
          updatedAt: new Date(serverNow),
        };
        return { matchedCount: 1, modifiedCount: 1 };
      }

      if (filter.state === "active") {
        if (
          filter.ownerId !== record.ownerId ||
          !matchesCounterFilter(filter) ||
          record.state !== "active" ||
          record.leaseExpiresAt.getTime() <= serverNow
        ) {
          return { matchedCount: 0, modifiedCount: 0 };
        }
        const leaseExpiresAt = pipeline[0].$set.leaseExpiresAt;
        if (leaseExpiresAt?.$dateAdd) {
          record.leaseExpiresAt = new Date(
            serverNow + leaseExpiresAt.$dateAdd.amount,
          );
        } else {
          record.state = "inactive";
          record.ownerId = null;
          record.leaseExpiresAt = new Date(serverNow);
        }
        record.updatedAt = new Date(serverNow);
        return { matchedCount: 1, modifiedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    },
  };
  const connection = {
    async startSession() {
      return {
        active: false,
        startTransaction() {
          transactionOptions.push(arguments[0]);
          this.active = true;
        },
        inTransaction() {
          return this.active;
        },
        async abortTransaction() {
          this.active = false;
        },
        async commitTransaction() {
          const failure = commitFailures[commitFailureIndex++];
          if (failure) throw failure;
          this.active = false;
        },
        async endSession() {
          this.active = false;
        },
      };
    },
  };
  return {
    service: createGpsWorkerOwnershipService({
      collection,
      connection,
      ownerIdFactory: () => `worker-${++nextOwnerId}`,
      maxTransactionAttempts: 3,
      maxCommitAttempts: 3,
    }),
    collection,
    activationOptions,
    transactionOptions,
    ownershipReadOptions,
    getRecord: () => ({ ...record }),
    setCounter(field, value) {
      if (value === undefined) {
        const { [field]: omitted, ...rest } = record;
        record = rest;
      } else {
        record = { ...record, [field]: value };
      }
    },
    advance(ms) {
      serverNow += ms;
    },
  };
}

function transientError(label) {
  const error = new Error(label);
  error.hasErrorLabel = (candidate) => candidate === label;
  return error;
}

function fakeGpsModel(record, writeLog) {
  return {
    async updateOne(filter, update, options) {
      writeLog.push({ filter, update, options });
      record.value = update.$set.value;
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
}

test("MongoDB ownership claim allocates increasing tokens and only one simultaneous claimant wins", async () => {
  const harness = createMemoryOwnershipHarness();
  const [first, second] = await Promise.all([
    harness.service.activate({ ttlMs: 10_000 }),
    harness.service.activate({ ttlMs: 10_000 }),
  ]);
  assert.equal(first.fencingToken, 10n);
  assert.equal(second, null);
  assert.equal(harness.getRecord().ownerId, first.ownerId);
  assert.deepEqual(harness.activationOptions[0].writeConcern, { w: "majority" });
  assert.equal(harness.activationOptions[0].promoteLongs, false);
  await first.runTransaction(async () => {});
  assert.deepEqual(harness.transactionOptions[0], {
    readConcern: { level: "snapshot" },
    writeConcern: { w: "majority" },
    readPreference: "primary",
  });
});

test("ownership validation rejects negative values and unsafe JavaScript Numbers", () => {
  const {
    isValidGpsWorkerOwnershipState,
    toGpsWorkerOwnershipBigInt,
  } = require("../src/services/gpsWorkerOwnership");
  const valid = {
    _id: GPS_WORKER_OWNERSHIP_ID,
    token: Long.ONE,
    ownerId: "worker",
    state: "active",
    leaseExpiresAt: new Date(10),
    writeVersion: Long.ZERO,
    configVersion: Long.ZERO,
    updatedAt: new Date(1),
  };
  assert.equal(isValidGpsWorkerOwnershipState(valid), true);
  assert.equal(
    isValidGpsWorkerOwnershipState({ ...valid, token: Long.fromInt(-1) }),
    false,
  );
  assert.equal(
    isValidGpsWorkerOwnershipState({ ...valid, configVersion: Long.fromInt(-1) }),
    false,
  );
  assert.throws(() => toGpsWorkerOwnershipBigInt(Number.MAX_SAFE_INTEGER + 1));
  assert.throws(() => toGpsWorkerOwnershipBigInt(-1));
  assert.throws(() => toGpsWorkerOwnershipBigInt(Long.fromInt(-1)));
  assert.equal(toGpsWorkerOwnershipBigInt(1n), 1n);
  assert.equal(
    isValidGpsWorkerOwnershipState({ ...valid, token: 1n }),
    false,
  );
});

test("ownership service requests BSON Long values for persisted counter reads", async () => {
  const harness = createMemoryOwnershipHarness();
  const owner = await harness.service.activate({ ttlMs: 10_000 });
  await owner.getConfigurationVersion();
  await harness.service.runGpsConfigurationTransaction(async () => {});
  await owner.assertOwned();

  assert.ok(
    harness.ownershipReadOptions.length >= 3 &&
      harness.ownershipReadOptions.every(
        (options) => options.promoteLongs === false,
      ),
  );
});

test("ownership state rejects malformed persisted BSON counters", () => {
  const { isValidGpsWorkerOwnershipState } = require("../src/services/gpsWorkerOwnership");
  const valid = {
    _id: GPS_WORKER_OWNERSHIP_ID,
    token: Long.ONE,
    ownerId: "worker",
    state: "active",
    leaseExpiresAt: new Date(10),
    writeVersion: Long.ZERO,
    configVersion: Long.ZERO,
    updatedAt: new Date(1),
  };
  const malformedValues = [
    { label: "missing", value: undefined },
    { label: "negative BSON Long", value: Long.fromInt(-1) },
    { label: "BSON Int32", value: new Int32(1) },
    { label: "JavaScript number", value: 1 },
    { label: "string", value: "1" },
    { label: "null", value: null },
    { label: "array containing BSON Long", value: [Long.ONE] },
    { label: "array containing zero Long", value: [Long.ZERO] },
    { label: "array containing number", value: [0] },
    { label: "array containing string", value: ["0"] },
  ];

  for (const field of ["token", "writeVersion", "configVersion"]) {
    for (const { label, value } of malformedValues) {
      const record = { ...valid };
      if (value === undefined) delete record[field];
      else record[field] = value;
      assert.equal(
        isValidGpsWorkerOwnershipState(record),
        false,
        `${field} must reject ${label}`,
      );
    }
  }
  assert.equal(isValidGpsWorkerOwnershipState(valid), true);
});

test("activation rejects malformed persisted counters without repairing them", async () => {
  const malformedValues = [
    undefined,
    Long.fromInt(-1),
    new Int32(1),
    1,
    "1",
    null,
    [Long.ONE],
    [Long.ZERO],
    [0],
    ["0"],
  ];
  for (const field of ["token", "writeVersion", "configVersion"]) {
    for (const value of malformedValues) {
      const harness = createMemoryOwnershipHarness();
      harness.setCounter(field, value);
      const before = harness.getRecord();
      await assert.rejects(
        harness.service.activate(),
        (error) => error.code === "GPS_OWNERSHIP_INVALID",
        `${field} must reject ${String(value)}`,
      );
      assert.deepEqual(harness.getRecord(), before);
    }
  }
});

test("renewal and release refuse malformed counters; worker and configuration writes fail closed", async () => {
  const malformedValues = [
    undefined,
    Long.fromInt(-1),
    new Int32(1),
    1,
    "1",
    null,
    [Long.ONE],
    [Long.ZERO],
    [0],
    ["0"],
  ];

  for (const field of ["token", "writeVersion", "configVersion"]) {
    for (const value of malformedValues) {
      for (const operationName of ["renew", "release", "worker-write", "config-write"]) {
        const harness = createMemoryOwnershipHarness();
        const owner = await harness.service.activate({ ttlMs: 10_000 });
        harness.setCounter(field, value);
        const before = harness.getRecord();

        if (operationName === "renew") {
          assert.equal(await owner.renew(), false, `${field} renewal must fail closed`);
        } else if (operationName === "release") {
          assert.equal(await owner.release(), false, `${field} release must fail closed`);
        } else if (operationName === "worker-write") {
          let workerWriteCount = 0;
          await assert.rejects(
            owner.runTransaction(async () => {
              workerWriteCount += 1;
            }),
            (error) => error.code === "GPS_LEASE_LOST",
            `${field} worker transaction must fail closed`,
          );
          assert.equal(workerWriteCount, 0);
        } else {
          let configurationWriteCount = 0;
          await assert.rejects(
            harness.service.runGpsConfigurationTransaction(async () => {
              configurationWriteCount += 1;
            }),
            (error) => error.code === "GPS_OWNERSHIP_INVALID",
            `${field} configuration transaction must fail closed`,
          );
          assert.equal(configurationWriteCount, 0);
        }

        assert.deepEqual(harness.getRecord(), before);
      }
    }
  }
});

test("activation fails closed when the provisioned record has a negative token", async () => {
  const harness = createMemoryOwnershipHarness({ initialToken: -1n });
  await assert.rejects(
    harness.service.activate(),
    (error) => error.code === "GPS_OWNERSHIP_INVALID",
  );
});

test("admin GPS mutation invalidates a worker cycle using an earlier configuration version", async () => {
  const harness = createMemoryOwnershipHarness();
  const owner = await harness.service.activate({ ttlMs: 10_000 });
  const expectedConfigVersion = await owner.getConfigurationVersion();
  await harness.service.runGpsConfigurationTransaction(async (session) => {
    assert.ok(session);
  });
  assert.equal(harness.getRecord().configVersion.toBigInt(), 1n);

  let targetWrites = 0;
  await assert.rejects(
    owner.runTransaction(
      async () => {
        targetWrites++;
      },
      { expectedConfigVersion },
    ),
    (error) => error.code === "GPS_CONFIGURATION_CHANGED",
  );
  assert.equal(targetWrites, 0);
});

test("A token 10 cannot write an untouched GPS target after B activates token 11", async () => {
  const harness = createMemoryOwnershipHarness();
  const workerA = await harness.service.activate({ ttlMs: 10_000 });
  assert.equal(workerA.fencingToken, 10n);
  harness.advance(10_000);
  const workerB = await harness.service.activate({ ttlMs: 10_000 });
  assert.equal(workerB.fencingToken, 11n);

  const target = { value: "before" };
  const writes = [];
  const model = fakeGpsModel(target, writes);
  await assert.rejects(
    workerA.runTransaction((session) =>
      model.updateOne(
        { _id: "untouched-device" },
        { $set: { value: "stale-A" } },
        { session },
      ),
    ),
    (error) => error.code === "GPS_LEASE_LOST",
  );
  assert.equal(writes.length, 0);
  assert.equal(target.value, "before");
  assert.equal(harness.getRecord().token.toBigInt(), 11n);
});

test("A transaction that commits before B activation is ordered before the transfer", async () => {
  const harness = createMemoryOwnershipHarness();
  const workerA = await harness.service.activate({ ttlMs: 10_000 });
  const target = { value: "before" };
  const writes = [];
  await workerA.runTransaction((session) =>
    fakeGpsModel(target, writes).updateOne(
      { _id: "location" },
      { $set: { value: "A" } },
      { session },
    ),
  );
  assert.equal(target.value, "A");
  harness.advance(10_000);
  const workerB = await harness.service.activate({ ttlMs: 10_000 });
  assert.equal(workerB.fencingToken, 11n);
});

test("expired ownership can be taken over; stale renewal and release cannot affect the new owner", async () => {
  const harness = createMemoryOwnershipHarness();
  const workerA = await harness.service.activate({ ttlMs: 10_000 });
  assert.equal(await workerA.renew(), true);
  harness.advance(10_000);
  const workerB = await harness.service.activate({ ttlMs: 10_000 });
  assert.equal(workerB.fencingToken, 11n);
  assert.equal(await workerA.renew(), false);
  assert.equal(await workerA.release(), false);
  assert.equal(harness.getRecord().ownerId, workerB.ownerId);
});

test("crashed worker is recovered by expiry and MongoDB remains authoritative without Redis", async () => {
  const harness = createMemoryOwnershipHarness();
  const crashedWorker = await harness.service.activate({ ttlMs: 10_000 });
  harness.advance(10_000);
  const recoveredWorker = await harness.service.activate({ ttlMs: 10_000 });
  assert.equal(recoveredWorker.fencingToken, crashedWorker.fencingToken + 1n);
  assert.equal(typeof harness.service.activate, "function");
});

test("missing ownership state fails closed without creating a record", async () => {
  const harness = createMemoryOwnershipHarness();
  harness.collection.findOneAndUpdate = async () => null;
  harness.collection.findOne = async () => null;
  await assert.rejects(
    harness.service.activate(),
    (error) => error.code === "GPS_OWNERSHIP_STATE_MISSING",
  );
});

test("MongoDB disconnection prevents GPS target writes", async () => {
  const harness = createMemoryOwnershipHarness();
  const owner = await harness.service.activate();
  harness.collection.updateOne = async () => {
    throw new Error("database unavailable");
  };
  let writes = 0;
  await assert.rejects(
    owner.runTransaction(async () => {
      writes += 1;
    }),
    /database unavailable/,
  );
  assert.equal(writes, 0);
});

test("transient transaction errors retry database work without externally replaying events", async () => {
  const harness = createMemoryOwnershipHarness();
  const owner = await harness.service.activate();
  let attempts = 0;
  let eventCount = 0;
  await owner.runTransaction(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw transientError("TransientTransactionError");
    }
    return { committed: true };
  }).then((result) => {
    if (result.committed) eventCount += 1;
  });
  assert.equal(attempts, 2);
  assert.equal(eventCount, 1);
});

test("unknown commit results retry commit without replaying work, then fail closed", async () => {
  const harness = createMemoryOwnershipHarness({
    commitFailures: [
      transientError("UnknownTransactionCommitResult"),
      transientError("UnknownTransactionCommitResult"),
      transientError("UnknownTransactionCommitResult"),
    ],
  });
  const owner = await harness.service.activate();
  let workAttempts = 0;
  await assert.rejects(
    owner.runTransaction(async () => {
      workAttempts += 1;
      return "done";
    }),
    (error) => error.code === "GPS_OWNERSHIP_UNCERTAIN",
  );
  assert.equal(workAttempts, 1);
  assert.equal(await owner.assertOwned(), false);
});
