"use strict";

const assert = require("node:assert/strict");
const { BSON, Long, MongoClient } = require("mongodb");
const test = require("node:test");
const {
  assertExpectedActiveOwnership,
  assertReplicaSetIdentity,
  assertSafeInactiveOwnership,
  assertStagingTarget,
  cleanupRunScopedCollections,
  createOwnershipWriteConflictTracker,
  getRunScopedOwnershipCollectionName,
  STAGING_BSON_OPTIONS,
} = require("./helpers/stagingGpsIntegrationSafety");

const validEnv = () => ({
  NODE_ENV: "test",
  BTMS_DATABASE_ENVIRONMENT: "staging",
  BTMS_STAGING_DB_NAME: "bts_staging_db",
  BTMS_STAGING_MONGODB_HOST: "rajvenkadam.hm6bni0.mongodb.net",
  MONGODB_URI:
    "mongodb+srv://test-user:test-password@rajvenkadam.hm6bni0.mongodb.net/bts_staging_db?retryWrites=true",
});

const validInactiveRecord = () => ({
  _id: "gps-worker",
  token: Long.ZERO,
  ownerId: null,
  state: "inactive",
  leaseExpiresAt: new Date(0),
  writeVersion: Long.ZERO,
  configVersion: Long.ZERO,
  updatedAt: new Date(1),
});

test("staging MongoDB BSON options preserve all ownership Int64 fields as Long", () => {
  const client = new MongoClient(
    "mongodb://127.0.0.1:27017",
    STAGING_BSON_OPTIONS,
  );
  assert.equal(client.bsonOptions.promoteLongs, false);

  const decoded = BSON.deserialize(
    BSON.serialize(validInactiveRecord()),
    client.bsonOptions,
  );
  for (const field of ["token", "writeVersion", "configVersion"]) {
    assert.equal(decoded[field]?._bsontype, "Long");
  }
  assert.doesNotThrow(() => assertSafeInactiveOwnership(decoded));
});

test("ownership conflict tracker correlates driver events and excludes unrelated failures", () => {
  const collectionName = "gps_worker_ownership_it_test";
  const tracker = createOwnershipWriteConflictTracker(collectionName);
  const startedEvent = (overrides = {}) => ({
    address: "staging.example:27017",
    connectionId: 12,
    requestId: 34,
    commandName: "update",
    command: {
      update: collectionName,
      updates: [{ q: { _id: "gps-worker" } }],
      lsid: { id: "session" },
      txnNumber: Long.ONE,
      autocommit: false,
    },
    ...overrides,
  });
  const failedEvent = (overrides = {}) => ({
    address: "staging.example:27017",
    connectionId: 12,
    requestId: 34,
    commandName: "update",
    failure: {
      code: 112,
      codeName: "WriteConflict",
      errorLabels: ["TransientTransactionError"],
    },
    ...overrides,
  });

  tracker.onCommandStarted(startedEvent());
  assert.equal(tracker.pendingCount, 1);
  assert.equal(
    tracker.onCommandFailed(
      failedEvent({ connectionId: 13, failure: { code: 112 } }),
    ),
    false,
  );
  assert.equal(
    tracker.onCommandFailed(
      failedEvent({
        failure: {
          code: 91,
          errorLabels: ["TransientTransactionError"],
        },
      }),
    ),
    false,
  );
  assert.equal(tracker.pendingCount, 0);

  tracker.onCommandStarted(
    startedEvent({
      requestId: 35,
      command: {
        update: "unrelated_collection",
        updates: [{ q: { _id: "gps-worker" } }],
        lsid: { id: "session" },
        txnNumber: Long.ONE,
        autocommit: false,
      },
    }),
  );
  tracker.onCommandStarted(
    startedEvent({
      requestId: 36,
      command: {
        update: collectionName,
        updates: [{ q: { _id: "another-record" } }],
        lsid: { id: "session" },
        txnNumber: Long.ONE,
        autocommit: false,
      },
    }),
  );
  tracker.onCommandStarted(
    startedEvent({
      requestId: 37,
      command: {
        update: collectionName,
        updates: [{ q: { _id: "gps-worker" } }],
      },
    }),
  );
  assert.equal(tracker.pendingCount, 0);

  tracker.onCommandStarted(startedEvent({ requestId: 38 }));
  tracker.onCommandSucceeded({
    address: "staging.example:27017",
    connectionId: 12,
    requestId: 38,
  });
  assert.equal(tracker.pendingCount, 0);

  tracker.onCommandStarted(startedEvent({ requestId: 39 }));
  assert.equal(
    tracker.onCommandFailed(failedEvent({ requestId: 39 })),
    true,
  );
  assert.equal(tracker.pendingCount, 0);

  for (let requestId = 100; requestId < 200; requestId += 1) {
    tracker.onCommandStarted(startedEvent({ requestId }));
  }
  assert.equal(tracker.pendingCount, 64);
  tracker.clear();
  assert.equal(tracker.pendingCount, 0);
});

test("staging target guard accepts only the exact authenticated target and returns no URI", () => {
  assert.deepEqual(assertStagingTarget(validEnv()), {
    databaseName: "bts_staging_db",
    hostname: "rajvenkadam.hm6bni0.mongodb.net",
  });
});

test("staging target guard lists missing variable names without exposing values", () => {
  assert.throws(
    () => assertStagingTarget({}),
    (error) => {
      assert.match(error.message, /MONGODB_URI/);
      assert.match(error.message, /BTMS_STAGING_DB_NAME/);
      assert.doesNotMatch(error.message, /test-password/);
      return true;
    },
  );
});

test("staging target guard rejects production, unknown environment, and production database", () => {
  assert.throws(
    () => assertStagingTarget({ ...validEnv(), NODE_ENV: "production" }),
    /production mode/,
  );
  assert.throws(
    () => {
      const env = validEnv();
      delete env.NODE_ENV;
      return assertStagingTarget(env);
    },
    /NODE_ENV must be set to test/,
  );
  assert.throws(
    () => assertStagingTarget({ ...validEnv(), NODE_ENV: "development" }),
    /NODE_ENV must be set to test/,
  );
  assert.throws(
    () => assertStagingTarget({ ...validEnv(), BTMS_DATABASE_ENVIRONMENT: "unknown" }),
    /must identify staging exactly/,
  );
  assert.throws(
    () =>
      assertStagingTarget({
        ...validEnv(),
        MONGODB_URI:
          "mongodb+srv://test-user:test-password@rajvenkadam.hm6bni0.mongodb.net/bts_db",
      }),
    /production database/,
  );
});

test("staging target guard rejects host, database, and credential ambiguity without echoing URI", () => {
  assert.throws(
    () =>
      assertStagingTarget({
        ...validEnv(),
        BTMS_STAGING_MONGODB_HOST: "example.invalid",
      }),
    /does not match the approved staging host/,
  );
  for (const MONGODB_URI of [
    "mongodb+srv://test-user:test-password@example.invalid/bts_staging_db",
    "mongodb://test-user:test-password@rajvenkadam.hm6bni0.mongodb.net:27017/bts_staging_db",
    "mongodb+srv://rajvenkadam.hm6bni0.mongodb.net/bts_staging_db",
    "mongodb+srv://test-user:test-password@rajvenkadam.hm6bni0.mongodb.net/other_db",
    "mongodb+srv://test-user:test-password@rajvenkadam.hm6bni0.mongodb.net/bts_staging_db/other",
    "mongodb+srv://test-user:test-password@rajvenkadam.hm6bni0.mongodb.net/bts_staging_db?authSource=bts_db",
  ]) {
    assert.throws(
      () => assertStagingTarget({ ...validEnv(), MONGODB_URI }),
      (error) => {
        assert.doesNotMatch(error.message, /test-user|test-password|mongodb\+srv/i);
        return true;
      },
    );
  }
});

test("topology guard requires the exact replica set and sessions", () => {
  assert.doesNotThrow(() =>
    assertReplicaSetIdentity("bts_staging_db", {
      setName: "atlas-gqfeyl-shard-0",
      logicalSessionTimeoutMinutes: 30,
    }),
  );
  assert.throws(
    () =>
      assertReplicaSetIdentity("bts_db", {
        setName: "atlas-gqfeyl-shard-0",
        logicalSessionTimeoutMinutes: 30,
      }),
    /database does not match/,
  );
  assert.throws(
    () =>
      assertReplicaSetIdentity("bts_staging_db", {
        setName: "unexpected",
        logicalSessionTimeoutMinutes: 30,
      }),
    /topology is not/,
  );
});

test("ownership collection names are isolated to valid unique run IDs", () => {
  const first = getRunScopedOwnershipCollectionName("a".repeat(32));
  const second = getRunScopedOwnershipCollectionName("b".repeat(32));
  assert.equal(first, `gps_worker_ownership_it_${"a".repeat(32)}`);
  assert.notEqual(first, second);
  for (const invalidRunId of ["", "not-a-uuid", "a".repeat(31), "../" + "a".repeat(29)]) {
    assert.throws(
      () => getRunScopedOwnershipCollectionName(invalidRunId),
      /run ID is invalid/,
    );
  }
});

test("singleton preflight accepts only a valid inactive authority without unknown fields", () => {
  assert.doesNotThrow(() => assertSafeInactiveOwnership(validInactiveRecord()));
  assert.throws(() => assertSafeInactiveOwnership(null), /missing/);
  assert.throws(
    () =>
      assertSafeInactiveOwnership({
        ...validInactiveRecord(),
        state: "active",
        ownerId: "other-worker",
      }),
    /active, malformed, or unexpected/,
  );
  assert.throws(
    () =>
      assertSafeInactiveOwnership({
        ...validInactiveRecord(),
        ownerId: "unexpected-owner",
      }),
    /active, malformed, or unexpected/,
  );
  assert.throws(
    () =>
      assertSafeInactiveOwnership({
        ...validInactiveRecord(),
        updatedAt: new Date(Number.NaN),
      }),
    /active, malformed, or unexpected/,
  );
  assert.throws(
    () =>
      assertSafeInactiveOwnership({
        ...validInactiveRecord(),
        token: Long.fromInt(-1),
      }),
    /active, malformed, or unexpected/,
  );
  for (const field of ["writeVersion", "configVersion"]) {
    assert.throws(
      () =>
        assertSafeInactiveOwnership({
          ...validInactiveRecord(),
          [field]: Long.fromInt(-1),
        }),
      /active, malformed, or unexpected/,
    );
  }
  assert.throws(
    () =>
      assertSafeInactiveOwnership({
        ...validInactiveRecord(),
        leaseExpiresAt: new Date(Number.NaN),
      }),
    /active, malformed, or unexpected/,
  );
  assert.throws(
    () =>
      assertSafeInactiveOwnership({
        ...validInactiveRecord(),
        unexpected: true,
      }),
    /unexpected fields/,
  );
});

test("active singleton validation matches only the expected owner and fencing token", () => {
  const owner = { ownerId: "test-owner", fencingToken: 1n };
  const record = {
    ...validInactiveRecord(),
    token: Long.ONE,
    ownerId: owner.ownerId,
    state: "active",
  };
  assert.doesNotThrow(() => assertExpectedActiveOwnership(record, owner));
  assert.throws(
    () => assertExpectedActiveOwnership(record, { ...owner, ownerId: "other" }),
    /expected test owner/,
  );
  assert.throws(
    () =>
      assertExpectedActiveOwnership(
        { ...record, token: Long.fromInt(2) },
        owner,
      ),
    /expected test owner/,
  );
});

test("cleanup releases exact tracked owner and drops collections only after inactive read-back", async () => {
  const owner = { ownerId: "test-owner", fencingToken: 1n };
  let record = {
    ...validInactiveRecord(),
    token: Long.ONE,
    ownerId: owner.ownerId,
    state: "active",
  };
  const trackedOwners = new Map([[owner.ownerId, { owner }]]);
  const dropped = [];
  await cleanupRunScopedCollections({
    transactionPreflightPassed: true,
    transactionProbeCollectionCreated: true,
    transactionProbeCollectionMayExist: true,
    ownershipCollectionCreated: true,
    ownershipCollectionMayExist: true,
    trackedOwners,
    readOwnership: async () => record,
    releaseOwner: async (releasedOwner) => {
      assert.equal(releasedOwner, owner);
      record = { ...validInactiveRecord(), token: Long.ONE };
      return true;
    },
    dropTransactionProbeCollection: async () => {
      dropped.push("probe");
      return true;
    },
    dropOwnershipCollection: async () => {
      dropped.push("ownership");
      return true;
    },
  });
  assert.equal(trackedOwners.size, 0);
  assert.deepEqual(dropped, ["probe", "ownership"]);
});

test("cleanup preserves collections when conditional release returns false or throws", async () => {
  for (const releaseOwner of [
    async () => false,
    async () => {
      const error = new Error("unknown outcome");
      error.code = "GPS_OWNERSHIP_UNCERTAIN";
      throw error;
    },
  ]) {
    const owner = { ownerId: "test-owner", fencingToken: 1n };
    const record = {
      ...validInactiveRecord(),
      token: Long.ONE,
      ownerId: owner.ownerId,
      state: "active",
    };
    let dropCount = 0;
    await assert.rejects(
      cleanupRunScopedCollections({
        transactionPreflightPassed: true,
        transactionProbeCollectionCreated: true,
        transactionProbeCollectionMayExist: true,
        ownershipCollectionCreated: true,
        ownershipCollectionMayExist: true,
        trackedOwners: new Map([[owner.ownerId, { owner }]]),
        readOwnership: async () => record,
        releaseOwner,
        dropTransactionProbeCollection: async () => {
          dropCount += 1;
          return true;
        },
        dropOwnershipCollection: async () => {
          dropCount += 1;
          return true;
        },
      }),
    );
    assert.equal(dropCount, 0);
  }
});

test("cleanup never releases an owner whose token changed after activation", async () => {
  const owner = { ownerId: "test-owner", fencingToken: 1n };
  const newerRecord = {
    ...validInactiveRecord(),
    token: Long.fromInt(2),
    ownerId: owner.ownerId,
    state: "active",
  };
  let releaseCount = 0;
  let dropCount = 0;
  await assert.rejects(
    cleanupRunScopedCollections({
      transactionPreflightPassed: true,
      transactionProbeCollectionCreated: true,
      transactionProbeCollectionMayExist: true,
      ownershipCollectionCreated: true,
      ownershipCollectionMayExist: true,
      trackedOwners: new Map([[owner.ownerId, { owner }]]),
      readOwnership: async () => newerRecord,
      releaseOwner: async () => {
        releaseCount += 1;
        return true;
      },
      dropTransactionProbeCollection: async () => {
        dropCount += 1;
        return true;
      },
      dropOwnershipCollection: async () => {
        dropCount += 1;
        return true;
      },
    }),
  );
  assert.equal(releaseCount, 0);
  assert.equal(dropCount, 0);
});

test("cleanup preserves collections after ownership-read timeout, unexpected owner, or remaining owner", async () => {
  const owner = { ownerId: "test-owner", fencingToken: 1n };
  const makeOptions = (overrides = {}) => {
    let dropCount = 0;
    return {
      options: {
        transactionPreflightPassed: true,
        transactionProbeCollectionCreated: true,
        transactionProbeCollectionMayExist: true,
        ownershipCollectionCreated: true,
        ownershipCollectionMayExist: true,
        trackedOwners: new Map(),
        readOwnership: async () => validInactiveRecord(),
        releaseOwner: async () => true,
        dropTransactionProbeCollection: async () => {
          dropCount += 1;
          return true;
        },
        dropOwnershipCollection: async () => {
          dropCount += 1;
          return true;
        },
        ...overrides,
      },
      getDropCount: () => dropCount,
    };
  };

  const timeout = makeOptions({
    readOwnership: async () => {
      throw new Error("operation timed out");
    },
  });
  await assert.rejects(cleanupRunScopedCollections(timeout.options));
  assert.equal(timeout.getDropCount(), 0);

  const unexpected = makeOptions({
    readOwnership: async () => ({
      ...validInactiveRecord(),
      state: "active",
      ownerId: "newer-owner",
    }),
  });
  await assert.rejects(cleanupRunScopedCollections(unexpected.options));
  assert.equal(unexpected.getDropCount(), 0);

  const remaining = makeOptions({
    trackedOwners: new Map([[owner.ownerId, { owner }]]),
  });
  await assert.rejects(cleanupRunScopedCollections(remaining.options));
  assert.equal(remaining.getDropCount(), 0);
});

test("cleanup preserves collections when preflight or collection creation is uncertain", async () => {
  for (const overrides of [
    { transactionPreflightPassed: false },
    { transactionProbeCollectionMayExist: true, transactionProbeCollectionCreated: false },
    { ownershipCollectionMayExist: true, ownershipCollectionCreated: false },
  ]) {
    let dropCount = 0;
    await assert.rejects(
      cleanupRunScopedCollections({
        transactionPreflightPassed: true,
        transactionProbeCollectionCreated: true,
        transactionProbeCollectionMayExist: true,
        ownershipCollectionCreated: true,
        ownershipCollectionMayExist: true,
        trackedOwners: new Map(),
        readOwnership: async () => validInactiveRecord(),
        releaseOwner: async () => true,
        dropTransactionProbeCollection: async () => {
          dropCount += 1;
          return true;
        },
        dropOwnershipCollection: async () => {
          dropCount += 1;
          return true;
        },
        ...overrides,
      }),
    );
    assert.equal(dropCount, 0);
  }
});

test("cleanup stops after false or timed-out collection deletion", async () => {
  for (const { dropTransactionProbeCollection, expectedUncertainty } of [
    { dropTransactionProbeCollection: async () => false, expectedUncertainty: false },
    {
      dropTransactionProbeCollection: async () => {
        const error = new Error("operation timed out");
        error.operationOutcomeUncertain = true;
        throw error;
      },
      expectedUncertainty: true,
    },
  ]) {
    const dropped = [];
    await assert.rejects(
      cleanupRunScopedCollections({
        transactionPreflightPassed: true,
        transactionProbeCollectionCreated: true,
        transactionProbeCollectionMayExist: true,
        ownershipCollectionCreated: true,
        ownershipCollectionMayExist: true,
        trackedOwners: new Map(),
        readOwnership: async () => validInactiveRecord(),
        releaseOwner: async () => true,
        dropTransactionProbeCollection: async () => {
          dropped.push("probe");
          return dropTransactionProbeCollection();
        },
        dropOwnershipCollection: async () => {
          dropped.push("ownership");
          return true;
        },
      }),
      (error) => {
        assert.equal(
          error.operationOutcomeUncertain === true,
          expectedUncertainty,
        );
        return true;
      },
    );
    assert.deepEqual(dropped, ["probe"]);
  }
});
