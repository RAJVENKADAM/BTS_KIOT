"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { Long, MongoClient } = require("mongodb");
const test = require("node:test");
const {
  assertExpectedActiveOwnership,
  assertReplicaSetIdentity,
  assertSafeInactiveOwnership,
  assertStagingTarget,
  cleanupRunScopedCollections,
  createOwnershipWriteConflictTracker,
  getRunScopedOwnershipCollectionName,
  OWNERSHIP_ID,
  STAGING_BSON_OPTIONS,
  STAGING_DATABASE_NAME,
} = require("./helpers/stagingGpsIntegrationSafety");
const {
  createGpsWorkerOwnershipService,
  toGpsWorkerOwnershipBigInt,
} = require("../src/services/gpsWorkerOwnership");

const CLIENT_OPTIONS = {
  appName: "BTMS-staging-gps-worker-integration-tests",
  maxPoolSize: 4,
  minPoolSize: 0,
  serverSelectionTimeoutMS: 10_000,
  connectTimeoutMS: 5_000,
  socketTimeoutMS: 15_000,
  waitQueueTimeoutMS: 5_000,
  timeoutMS: 15_000,
  monitorCommands: true,
  ...STAGING_BSON_OPTIONS,
};
const LEASE_TTL_MS = 300_000;
const MAX_TEST_OPERATION_MS = 10_000;
const MAX_CLEANUP_OPERATION_MS = 5_000;
const SAFE_ERROR_CODES = new Set([
  6, 7, 13, 18, 26, 48, 50, 59, 68, 85, 86, 89, 91, 112, 251, 8000, 11000,
  11600, 11602, 13435, 13436,
]);

let client;
let database;
let ownershipCollection;
let testCollection;
let ownershipCollectionName;
let transactionProbeCollection;
let transactionProbeCollectionName;
let ownershipCollectionMayExist = false;
let ownershipCollectionCreated = false;
let transactionProbeCollectionMayExist = false;
let transactionProbeCollectionCreated = false;
let transactionPreflightPassed = false;
let runId;
const activeTestOwners = new Map();

function safeFailure(stage, error) {
  if (error?.operationOutcomeUncertain === true) {
    return new Error(
      `${stage} failed (timeout; the MongoDB operation may still complete server-side).`,
    );
  }
  const name =
    typeof error?.name === "string" &&
    /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(error.name)
      ? error.name
      : "Error";
  const code =
    Number.isSafeInteger(error?.code) && SAFE_ERROR_CODES.has(error.code)
      ? `, code ${error.code}`
      : "";
  return new Error(`${stage} failed (${name}${code}).`);
}

function withCleanupDeadline(stage, operation, timeoutMS = MAX_CLEANUP_OPERATION_MS) {
  // This bounds the caller, not the driver operation; callers must stop later destructive steps.
  let timer;
  const operationPromise = Promise.resolve().then(operation);
  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${stage} exceeded its ${timeoutMS} ms deadline.`);
      error.name = "TimeoutError";
      error.operationOutcomeUncertain = true;
      reject(error);
    }, timeoutMS);
  });
  return Promise.race([operationPromise, timeoutPromise]).finally(() =>
    clearTimeout(timer),
  );
}

async function safeMongoOperation(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    throw safeFailure(stage, error);
  }
}

async function dropRunScopedCollection(stage, name) {
  return withCleanupDeadline(stage, async () => {
    try {
      return await database.dropCollection(name, {
        maxTimeMS: MAX_CLEANUP_OPERATION_MS,
        timeoutMS: MAX_CLEANUP_OPERATION_MS,
      });
    } catch (error) {
      const failure = safeFailure(stage, error);
      failure.operationOutcomeUncertain = true;
      throw failure;
    }
  });
}

function createService() {
  const stats = { transactionStarts: 0 };
  const connection = {
    startSession(...args) {
      const session = client.startSession(...args);
      const startTransaction = session.startTransaction.bind(session);
      session.startTransaction = (...transactionArgs) => {
        stats.transactionStarts += 1;
        return startTransaction(...transactionArgs);
      };
      return session;
    },
  };
  return {
    stats,
    service: createGpsWorkerOwnershipService({
      collection: ownershipCollection,
      connection,
    }),
  };
}

async function readOwnership() {
  return safeMongoOperation("GPS ownership read", () =>
    ownershipCollection.findOne(
      { _id: OWNERSHIP_ID },
      {
        maxTimeMS: MAX_CLEANUP_OPERATION_MS,
        timeoutMS: MAX_CLEANUP_OPERATION_MS,
      },
    ),
  );
}

async function assertInactiveBeforeClaim() {
  assertSafeInactiveOwnership(await readOwnership());
}

async function claim(service) {
  await assertInactiveBeforeClaim();
  const owner = await safeMongoOperation("GPS ownership activation", () =>
    service.activate({ ttlMs: LEASE_TTL_MS }),
  );
  if (!owner) {
    throw new Error("GPS ownership activation was refused; the authority was not reset.");
  }
  activeTestOwners.set(owner.ownerId, { owner, service });
  assertExpectedActiveOwnership(await readOwnership(), owner);
  return owner;
}

async function release(owner) {
  if (!owner) return false;
  assertExpectedActiveOwnership(await readOwnership(), owner);
  const tracked = activeTestOwners.get(owner.ownerId);
  if (!tracked) {
    throw new Error("Refusing to release an owner not created by this test run.");
  }
  const released = await safeMongoOperation("GPS ownership release", () =>
    owner.release(),
  );
  if (released) activeTestOwners.delete(owner.ownerId);
  return released;
}

async function insertTestRecord(id, session, value) {
  return safeMongoOperation(`test record write ${id}`, () =>
    testCollection.insertOne(
      { _id: id, runId, value },
      {
        session,
        maxTimeMS: MAX_TEST_OPERATION_MS,
        timeoutMS: MAX_TEST_OPERATION_MS,
      },
    ),
  );
}

async function findTestRecord(id) {
  return safeMongoOperation(`test record read ${id}`, () =>
    testCollection.findOne(
      { _id: id, runId },
      {
        maxTimeMS: MAX_TEST_OPERATION_MS,
        timeoutMS: MAX_TEST_OPERATION_MS,
      },
    ),
  );
}

async function verifyTransactionCapability() {
  const session = client.startSession({
    defaultTimeoutMS: MAX_TEST_OPERATION_MS,
  });
  let operationError;
  try {
    session.startTransaction({
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
      readPreference: "primary",
    });
    await transactionProbeCollection.insertOne(
      { _id: `${runId}:commit`, runId, result: "committed" },
      {
        session,
        maxTimeMS: MAX_TEST_OPERATION_MS,
        timeoutMS: MAX_TEST_OPERATION_MS,
      },
    );
    await session.commitTransaction({ timeoutMS: MAX_TEST_OPERATION_MS });
    const committed = await transactionProbeCollection.findOne(
      { _id: `${runId}:commit`, runId },
      {
        maxTimeMS: MAX_TEST_OPERATION_MS,
        timeoutMS: MAX_TEST_OPERATION_MS,
      },
    );
    assert.equal(committed?.result, "committed");

    session.startTransaction({
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
      readPreference: "primary",
    });
    await transactionProbeCollection.insertOne(
      { _id: `${runId}:rollback`, runId, result: "must-not-commit" },
      {
        session,
        maxTimeMS: MAX_TEST_OPERATION_MS,
        timeoutMS: MAX_TEST_OPERATION_MS,
      },
    );
    await session.abortTransaction({
      timeoutMS: MAX_TEST_OPERATION_MS,
      throwTimeout: true,
    });
    const rolledBack = await transactionProbeCollection.findOne(
      { _id: `${runId}:rollback`, runId },
      {
        maxTimeMS: MAX_TEST_OPERATION_MS,
        timeoutMS: MAX_TEST_OPERATION_MS,
      },
    );
    assert.equal(rolledBack, null);
  } catch (error) {
    operationError = error;
    if (session.inTransaction()) {
      try {
        await session.abortTransaction({
          timeoutMS: MAX_TEST_OPERATION_MS,
          throwTimeout: true,
        });
      } catch {
        // Any failed preflight preserves the disposable collection.
      }
    }
  }

  try {
    await session.endSession({ timeoutMS: MAX_CLEANUP_OPERATION_MS });
  } catch (error) {
    throw safeFailure("transaction preflight session cleanup", error);
  }
  if (operationError) {
    throw safeFailure("real MongoDB transaction preflight", operationError);
  }
  transactionPreflightPassed = true;
}

async function expectServiceError(operation, expectedCode, description) {
  try {
    await operation();
  } catch (error) {
    if (error?.code === expectedCode) return;
    throw safeFailure(description, error);
  }
  throw new Error(`${description} did not reject with ${expectedCode}.`);
}

test.before(
  async () => {
    const target = assertStagingTarget(process.env);
    runId = randomUUID().replace(/-/g, "");
    ownershipCollectionName = getRunScopedOwnershipCollectionName(runId);
    transactionProbeCollectionName = `gps_worker_transaction_probe_${runId}`;

    try {
      client = new MongoClient(process.env.MONGODB_URI, CLIENT_OPTIONS);
      await safeMongoOperation("staging MongoDB connection", () => client.connect());
      database = client.db(target.databaseName);
      if (database.databaseName !== STAGING_DATABASE_NAME) {
        throw new Error("Connected MongoDB database does not match staging.");
      }

      const hello = await safeMongoOperation("replica-set identity check", () =>
        database.admin().command(
          { hello: 1 },
          { maxTimeMS: MAX_TEST_OPERATION_MS },
        ),
      );
      assertReplicaSetIdentity(database.databaseName, hello);

      const preexistingProbeCollection = await safeMongoOperation(
        "transaction probe collection collision check",
        () =>
          database
            .listCollections(
              { name: transactionProbeCollectionName },
              { nameOnly: true, timeoutMS: MAX_CLEANUP_OPERATION_MS },
            )
            .hasNext(),
      );
      if (preexistingProbeCollection) {
        throw new Error("The generated transaction probe collection already exists.");
      }
      transactionProbeCollectionMayExist = true;
      await safeMongoOperation("transaction probe collection creation", () =>
        database.createCollection(transactionProbeCollectionName, {
          maxTimeMS: MAX_TEST_OPERATION_MS,
          timeoutMS: MAX_TEST_OPERATION_MS,
        }),
      );
      transactionProbeCollectionCreated = true;
      transactionProbeCollection = database.collection(
        transactionProbeCollectionName,
      );
      await verifyTransactionCapability();

      const preexistingTestCollection = await safeMongoOperation(
        "test collection collision check",
        () =>
          database
            .listCollections(
              { name: ownershipCollectionName },
              { nameOnly: true, timeoutMS: MAX_CLEANUP_OPERATION_MS },
            )
            .hasNext(),
      );
      if (preexistingTestCollection) {
        throw new Error("The generated test collection already exists; refusing to reuse it.");
      }
      ownershipCollectionMayExist = true;
      await safeMongoOperation("isolated test collection creation", () =>
        database.createCollection(ownershipCollectionName, {
          maxTimeMS: MAX_TEST_OPERATION_MS,
          timeoutMS: MAX_TEST_OPERATION_MS,
        }),
      );
      ownershipCollectionCreated = true;
      ownershipCollection = database.collection(ownershipCollectionName);
      testCollection = ownershipCollection;
      await safeMongoOperation("isolated GPS ownership seed", () =>
        ownershipCollection.insertOne(
          {
            _id: OWNERSHIP_ID,
            token: Long.ZERO,
            ownerId: null,
            state: "inactive",
            leaseExpiresAt: new Date(0),
            writeVersion: Long.ZERO,
            configVersion: Long.ZERO,
            updatedAt: new Date(),
          },
          {
            maxTimeMS: MAX_TEST_OPERATION_MS,
            timeoutMS: MAX_TEST_OPERATION_MS,
          },
        ),
      );
      assertSafeInactiveOwnership(await readOwnership());
    } catch (error) {
      if (
        error?.message?.startsWith("Missing required staging variables:") ||
        error?.message?.startsWith("BTMS_") ||
        error?.message?.startsWith("MONGODB_URI") ||
        error?.message?.startsWith("Refusing") ||
        error?.message?.startsWith("Connected MongoDB") ||
        error?.message?.startsWith("GPS worker ownership") ||
        error?.message?.startsWith("The generated test collection")
      ) {
        throw error;
      }
      throw safeFailure("staging integration preflight", error);
    }
  },
  { timeout: 45_000 },
);

test.after(
  async () => {
    let cleanupError;
    try {
      await cleanupRunScopedCollections({
        transactionPreflightPassed,
        transactionProbeCollectionCreated,
        transactionProbeCollectionMayExist,
        ownershipCollectionCreated,
        ownershipCollectionMayExist,
        trackedOwners: activeTestOwners,
        readOwnership,
        releaseOwner: (owner) =>
          withCleanupDeadline(
            "conditional GPS ownership release",
            () =>
              safeMongoOperation("conditional GPS ownership release", () =>
                owner.release(),
              ),
            MAX_TEST_OPERATION_MS,
          ),
          dropTransactionProbeCollection: async () => {
            const dropped = await dropRunScopedCollection(
              "transaction probe collection deletion",
              transactionProbeCollectionName,
            );
            return dropped === true;
          },
          dropOwnershipCollection: async () => {
            const dropped = await dropRunScopedCollection(
              "isolated ownership collection deletion",
              ownershipCollectionName,
            );
          return dropped === true;
        },
      });
    } catch (error) {
      cleanupError = safeFailure("GPS ownership cleanup", error);
    } finally {
      if (client) {
        try {
          await withCleanupDeadline(
            "staging MongoDB client shutdown",
            () => client.close(),
          );
        } catch (error) {
          cleanupError ||= safeFailure("staging MongoDB close", error);
        }
      }
    }

    if (cleanupError) throw cleanupError;
  },
  { timeout: 45_000 },
);

test(
  "staging replica-set GPS ownership, transactions, and configuration fencing",
  { timeout: 170_000 },
  async (t) => {
    await t.test("concurrent claims allocate one increasing fencing token", async () => {
      await assertInactiveBeforeClaim();
      const before = await readOwnership();
      const first = createService();
      const second = createService();
      const [firstOwner, secondOwner] = await safeMongoOperation(
        "concurrent GPS ownership claims",
        () =>
          Promise.all([
            first.service.activate({ ttlMs: LEASE_TTL_MS }),
            second.service.activate({ ttlMs: LEASE_TTL_MS }),
          ]),
      );
      assert.equal(Number(Boolean(firstOwner)) + Number(Boolean(secondOwner)), 1);
      const owner = firstOwner || secondOwner;
      const ownerService = firstOwner ? first.service : second.service;
      activeTestOwners.set(owner.ownerId, { owner, service: ownerService });
      assert.equal(
        owner.fencingToken,
        toGpsWorkerOwnershipBigInt(before.token) + 1n,
      );
      assertExpectedActiveOwnership(await readOwnership(), owner);
      assert.equal(await release(owner), true);
      assert.equal(await owner.release(), false);
      const inactive = await readOwnership();
      assertSafeInactiveOwnership(inactive);
      assert.equal(toGpsWorkerOwnershipBigInt(inactive.token), owner.fencingToken);
    });

    await t.test("stale owners cannot renew or write; current owner renews and releases conditionally", async () => {
      const first = createService();
      const staleOwner = await claim(first.service);
      assert.equal(await release(staleOwner), true);

      const second = createService();
      const currentOwner = await claim(second.service);
      assert.equal(currentOwner.fencingToken, staleOwner.fencingToken + 1n);

      assert.equal(await staleOwner.renew(), false);
      await expectServiceError(
        () =>
          staleOwner.runTransaction((session) =>
            insertTestRecord("stale-owner-write", session, "must-not-commit"),
          ),
        "GPS_LEASE_LOST",
        "stale-owner GPS write",
      );
      assert.equal(await findTestRecord("stale-owner-write"), null);

      assertExpectedActiveOwnership(await readOwnership(), currentOwner);
      assert.equal(await currentOwner.renew(), true);
      assert.equal(await release(currentOwner), true);
      assert.equal(await staleOwner.release(), false);
      assertSafeInactiveOwnership(await readOwnership());
    });

    await t.test("real transactions roll back atomically and configuration changes fence stale worker cycles", async () => {
      const { service } = createService();
      const owner = await claim(service);
      const rollbackId = "rollback-must-not-persist";
      const versionBeforeRollback = await readOwnership();

      await assert.rejects(
        () =>
          owner.runTransaction(async (session) => {
            await insertTestRecord(rollbackId, session, "rollback");
            const error = new Error("intentional test rollback");
            error.code = "TEST_ROLLBACK";
            throw error;
          }),
        (error) => error?.code === "TEST_ROLLBACK",
      );
      assert.equal(await findTestRecord(rollbackId), null);
      const versionAfterRollback = await readOwnership();
      assert.equal(
        toGpsWorkerOwnershipBigInt(versionAfterRollback.writeVersion),
        toGpsWorkerOwnershipBigInt(versionBeforeRollback.writeVersion),
      );

      const oldConfigVersion = await owner.getConfigurationVersion();
      await safeMongoOperation("GPS configuration transaction", () =>
        service.runGpsConfigurationTransaction((session) =>
          insertTestRecord("configuration-committed", session, "configured"),
        ),
      );
      assert.equal(await findTestRecord("configuration-committed") !== null, true);
      const changed = await readOwnership();
      assert.equal(
        toGpsWorkerOwnershipBigInt(changed.configVersion),
        oldConfigVersion + 1n,
      );

      await expectServiceError(
        () =>
          owner.runTransaction(
            (session) =>
              insertTestRecord("stale-configuration-write", session, "must-not-commit"),
            { expectedConfigVersion: oldConfigVersion },
          ),
        "GPS_CONFIGURATION_CHANGED",
        "stale configuration worker write",
      );
      assert.equal(await findTestRecord("stale-configuration-write"), null);

      const currentConfigVersion = await owner.getConfigurationVersion();
      await safeMongoOperation("current-owner GPS transaction", () =>
        owner.runTransaction(
          (session) =>
            insertTestRecord("current-configuration-write", session, "committed"),
          { expectedConfigVersion: currentConfigVersion },
        ),
      );
      assert.equal(await findTestRecord("current-configuration-write") !== null, true);
      assert.equal(await release(owner), true);
    });

    await t.test("concurrent real transactions retry conflicts without stale writes", async () => {
      const worker = createService();
      const workerOwner = await claim(worker.service);
      let releaseConflictedWorker;
      const conflictObserved = new Promise((resolve) => {
        releaseConflictedWorker = resolve;
      });
      const configuration = createService();
      const conflictTracker =
        createOwnershipWriteConflictTracker(ownershipCollectionName);
      const onCommandFailed = (event) => {
        if (conflictTracker.onCommandFailed(event)) releaseConflictedWorker();
      };
      client.on("commandStarted", conflictTracker.onCommandStarted);
      client.on("commandSucceeded", conflictTracker.onCommandSucceeded);
      client.on("commandFailed", onCommandFailed);
      const expectedConfigVersion = await workerOwner.getConfigurationVersion();
      let signalWorkerEntered;
      let releaseWorkerOperation;
      const workerEntered = new Promise((resolve) => {
        signalWorkerEntered = resolve;
      });
      const workerMayCommit = new Promise((resolve) => {
        releaseWorkerOperation = resolve;
      });
      let releaseCalled = false;
      const completeWorkerOperation = () => {
        if (releaseCalled) return;
        releaseCalled = true;
        releaseWorkerOperation();
      };
      const completionOrder = [];

      const workerTask = workerOwner
        .runTransaction(async (session) => {
          signalWorkerEntered();
          await workerMayCommit;
          await insertTestRecord("conflicting-worker-write", session, "worker");
        }, { expectedConfigVersion })
        .then(() => {
          completionOrder.push("worker");
          return { status: "committed" };
        })
        .catch((error) => {
          if (error?.code === "GPS_CONFIGURATION_CHANGED") {
            return { status: "fenced" };
          }
          return {
            status: "error",
            error: safeFailure("conflicting worker transaction", error),
          };
        });

      let configurationTask;
      let configurationOutcome;
      let retryObserved = false;
      let retryWaitFailure;
      try {
        await Promise.race([
          workerEntered,
          delay(MAX_TEST_OPERATION_MS).then(() => {
            throw new Error("Worker transaction did not reach its real session operation.");
          }),
        ]);
        configurationTask = safeMongoOperation(
          "conflicting configuration transaction",
          () =>
            configuration.service.runGpsConfigurationTransaction((session) =>
              insertTestRecord("conflicting-configuration-write", session, "configuration"),
            ),
        ).then(
          () => {
            completionOrder.push("configuration");
            configurationOutcome = { status: "fulfilled" };
          },
          (error) => {
            configurationOutcome = { status: "rejected", error };
          },
        );

        await Promise.race([
          conflictObserved,
          delay(8_000).then(() => {
            throw new Error("No transient MongoDB write conflict was observed.");
          }),
        ]);
        const retryDeadline = Date.now() + 8_000;
        while (
          configuration.stats.transactionStarts < 2 &&
          !configurationOutcome &&
          Date.now() < retryDeadline
        ) {
          await delay(5);
        }
        retryObserved =
          configuration.stats.transactionStarts >= 2;
        if (!retryObserved) {
          retryWaitFailure = new Error(
            "A real transaction conflict did not trigger a configuration transaction retry.",
          );
        }
      } finally {
        client.off("commandStarted", conflictTracker.onCommandStarted);
        client.off("commandSucceeded", conflictTracker.onCommandSucceeded);
        client.off("commandFailed", onCommandFailed);
        conflictTracker.clear();
        completeWorkerOperation();
      }

      const workerResult = await workerTask;
      await configurationTask;
      if (retryWaitFailure) throw retryWaitFailure;
      assert.equal(retryObserved, true);
      assert.equal(configurationOutcome?.status, "fulfilled");
      assert.notEqual(workerResult.status, "error", workerResult.error?.message);
      assert.ok(["committed", "fenced"].includes(workerResult.status));
      assert.equal(await findTestRecord("conflicting-configuration-write") !== null, true);

      const workerRecord = await findTestRecord("conflicting-worker-write");
      if (workerResult.status === "committed") {
        assert.ok(workerRecord);
        assert.ok(
          completionOrder.indexOf("worker") <
            completionOrder.indexOf("configuration"),
        );
      } else {
        assert.equal(workerRecord, null);
      }
      assertExpectedActiveOwnership(await readOwnership(), workerOwner);
      assert.equal(await release(workerOwner), true);
    });
  },
);
