"use strict";

const STAGING_DATABASE_NAME = "bts_staging_db";
const STAGING_MONGODB_HOST = "rajvenkadam.hm6bni0.mongodb.net";
const EXPECTED_REPLICA_SET = "atlas-gqfeyl-shard-0";
const OWNERSHIP_ID = "gps-worker";
const STAGING_BSON_OPTIONS = Object.freeze({ promoteLongs: false });
const MAX_PENDING_OWNERSHIP_COMMANDS = 64;
const OWNERSHIP_FIELDS = new Set([
  "_id",
  "token",
  "ownerId",
  "state",
  "leaseExpiresAt",
  "writeVersion",
  "configVersion",
  "updatedAt",
]);

function assertStagingTarget(env = process.env) {
  const required = [
    "MONGODB_URI",
    "BTMS_DATABASE_ENVIRONMENT",
    "BTMS_STAGING_DB_NAME",
    "BTMS_STAGING_MONGODB_HOST",
  ];
  const missing = required.filter(
    (name) => typeof env[name] !== "string" || env[name].trim() === "",
  );
  if (missing.length) {
    throw new Error(`Missing required staging variables: ${missing.join(", ")}.`);
  }
  if (
    String(env.NODE_ENV || "").toLowerCase() === "production" ||
    String(process.env.NODE_ENV || "").toLowerCase() === "production"
  ) {
    throw new Error("Refusing staging integration tests in production mode.");
  }
  if (env.NODE_ENV !== "test") {
    throw new Error("NODE_ENV must be set to test for staging integration tests.");
  }
  if (env.BTMS_DATABASE_ENVIRONMENT !== "staging") {
    throw new Error("BTMS_DATABASE_ENVIRONMENT must identify staging exactly.");
  }
  if (env.BTMS_STAGING_DB_NAME !== STAGING_DATABASE_NAME) {
    throw new Error("BTMS_STAGING_DB_NAME does not match the approved staging database.");
  }
  if (env.BTMS_STAGING_MONGODB_HOST.toLowerCase() !== STAGING_MONGODB_HOST) {
    throw new Error("BTMS_STAGING_MONGODB_HOST does not match the approved staging host.");
  }

  let uri;
  try {
    uri = new URL(env.MONGODB_URI);
  } catch {
    throw new Error("MONGODB_URI is invalid; its value will not be displayed.");
  }
  if (
    !["mongodb:", "mongodb+srv:"].includes(uri.protocol) ||
    !uri.username ||
    !uri.password ||
    uri.port ||
    uri.hash
  ) {
    throw new Error("MONGODB_URI is not an unambiguous authenticated staging URI.");
  }
  const authSources = uri.searchParams.getAll("authSource");
  if (
    authSources.length > 1 ||
    authSources.some((source) => source.toLowerCase() === "bts_db")
  ) {
    throw new Error("MONGODB_URI has an ambiguous or production authentication database.");
  }

  let databaseName;
  try {
    if (
      !uri.pathname.startsWith("/") ||
      uri.pathname.startsWith("//") ||
      uri.pathname.slice(1).includes("/")
    ) {
      throw new Error("invalid path");
    }
    databaseName = decodeURIComponent(uri.pathname.replace(/^\/+/, ""));
  } catch {
    throw new Error("MONGODB_URI has an invalid database path.");
  }
  if (databaseName.toLowerCase() === "bts_db") {
    throw new Error("Refusing the production database.");
  }
  if (databaseName !== STAGING_DATABASE_NAME) {
    throw new Error("MONGODB_URI does not select the approved staging database.");
  }
  if (uri.hostname.toLowerCase() !== STAGING_MONGODB_HOST) {
    throw new Error("MONGODB_URI does not select the approved staging host.");
  }

  return {
    databaseName: STAGING_DATABASE_NAME,
    hostname: STAGING_MONGODB_HOST,
  };
}

function assertReplicaSetIdentity(databaseName, hello) {
  if (databaseName !== STAGING_DATABASE_NAME) {
    throw new Error("Connected MongoDB database does not match the approved staging database.");
  }
  if (
    hello?.setName !== EXPECTED_REPLICA_SET ||
    hello.logicalSessionTimeoutMinutes == null
  ) {
    throw new Error("Connected MongoDB topology is not the approved transaction-capable replica set.");
  }
}

function getRunScopedOwnershipCollectionName(runId) {
  if (typeof runId !== "string" || !/^[a-f0-9]{32}$/i.test(runId)) {
    throw new Error("GPS integration run ID is invalid.");
  }
  return `gps_worker_ownership_it_${runId}`;
}

function getCommandEventKey(event) {
  if (!Number.isSafeInteger(event?.requestId)) return null;
  const serviceId = event.serviceId?.toHexString?.() || "";
  return [
    event.address || "",
    event.connectionId ?? "",
    serviceId,
    event.requestId,
  ].join(":");
}

function createOwnershipWriteConflictTracker(collectionName) {
  const pendingCommands = new Map();
  const isOwnershipTransaction = (event) => {
    const command = event?.command;
    return (
      event?.commandName === "update" &&
      command?.update === collectionName &&
      Array.isArray(command.updates) &&
      command.updates.some((update) => update.q?._id === OWNERSHIP_ID) &&
      command.lsid != null &&
      command.txnNumber != null &&
      command.autocommit === false
    );
  };
  const removePendingCommand = (event) => {
    const key = getCommandEventKey(event);
    if (key === null) return null;
    const command = pendingCommands.get(key);
    pendingCommands.delete(key);
    return command || null;
  };

  return {
    onCommandStarted(event) {
      if (!isOwnershipTransaction(event)) return;
      const key = getCommandEventKey(event);
      if (key === null) return;
      if (pendingCommands.size >= MAX_PENDING_OWNERSHIP_COMMANDS) {
        pendingCommands.delete(pendingCommands.keys().next().value);
      }
      pendingCommands.set(key, true);
    },
    onCommandSucceeded(event) {
      removePendingCommand(event);
    },
    onCommandFailed(event) {
      if (!removePendingCommand(event)) return false;
      const failure = event?.failure;
      const isWriteConflict =
        failure?.code === 112 || failure?.codeName === "WriteConflict";
      const isTransientTransaction =
        failure?.hasErrorLabel?.("TransientTransactionError") === true ||
        failure?.errorLabels?.includes("TransientTransactionError") === true;
      return isWriteConflict && isTransientTransaction;
    },
    clear() {
      pendingCommands.clear();
    },
    get pendingCount() {
      return pendingCommands.size;
    },
  };
}

function isNonnegativeLong(value) {
  return (
    value?._bsontype === "Long" &&
    typeof value.greaterThanOrEqual === "function" &&
    value.greaterThanOrEqual(value.constructor.ZERO)
  );
}

function assertSafeInactiveOwnership(record) {
  if (!record) {
    throw new Error("GPS worker ownership authority is missing.");
  }
  if (Object.keys(record).some((field) => !OWNERSHIP_FIELDS.has(field))) {
    throw new Error("GPS worker ownership authority contains unexpected fields.");
  }
  const validDates = [record.leaseExpiresAt, record.updatedAt].every(
    (value) => value instanceof Date && Number.isFinite(value.getTime()),
  );
  if (
    record._id !== OWNERSHIP_ID ||
    record.state !== "inactive" ||
    record.ownerId !== null ||
    !isNonnegativeLong(record.token) ||
    !isNonnegativeLong(record.writeVersion) ||
    !isNonnegativeLong(record.configVersion) ||
    !validDates
  ) {
    throw new Error("GPS worker ownership authority is active, malformed, or unexpected.");
  }
}

function assertExpectedActiveOwnership(record, owner) {
  if (
    !record ||
    Object.keys(record).some((field) => !OWNERSHIP_FIELDS.has(field)) ||
    record._id !== OWNERSHIP_ID ||
    record.state !== "active" ||
    record.ownerId !== owner.ownerId ||
    !isNonnegativeLong(record.token) ||
    record.token.toBigInt() !== owner.fencingToken ||
    !isNonnegativeLong(record.writeVersion) ||
    !isNonnegativeLong(record.configVersion) ||
    ![record.leaseExpiresAt, record.updatedAt].every(
      (value) => value instanceof Date && Number.isFinite(value.getTime()),
    )
  ) {
    throw new Error("GPS worker ownership is not held by the expected test owner.");
  }
}

async function cleanupRunScopedCollections({
  transactionPreflightPassed,
  transactionProbeCollectionCreated,
  transactionProbeCollectionMayExist,
  ownershipCollectionCreated,
  ownershipCollectionMayExist,
  trackedOwners,
  readOwnership,
  releaseOwner,
  dropTransactionProbeCollection,
  dropOwnershipCollection,
}) {
  if (!transactionPreflightPassed) {
    throw new Error("Transaction preflight was not proven; test collections are preserved.");
  }
  if (
    (transactionProbeCollectionMayExist && !transactionProbeCollectionCreated) ||
    (ownershipCollectionMayExist && !ownershipCollectionCreated)
  ) {
    throw new Error("A test collection creation outcome is uncertain; collections are preserved.");
  }

  if (ownershipCollectionCreated) {
    const current = await readOwnership();
    if (current?.state === "active") {
      const tracked = trackedOwners.get(current.ownerId);
      if (!tracked) {
        throw new Error("An unowned active test authority was found; collection is preserved.");
      }
      assertExpectedActiveOwnership(current, tracked.owner);
      if (await releaseOwner(tracked.owner) !== true) {
        throw new Error("Conditional test ownership release was not confirmed.");
      }
      trackedOwners.delete(current.ownerId);
    }

    assertSafeInactiveOwnership(await readOwnership());
  }

  if (trackedOwners.size !== 0) {
    throw new Error("Tracked test owners remain; test collections are preserved.");
  }
  if (transactionProbeCollectionCreated) {
    if (await dropTransactionProbeCollection() !== true) {
      throw new Error(
        "Transaction probe collection deletion was not confirmed; later cleanup stopped.",
      );
    }
  }
  if (ownershipCollectionCreated) {
    if (await dropOwnershipCollection() !== true) {
      throw new Error(
        "Ownership collection deletion was not confirmed; later cleanup stopped.",
      );
    }
  }
}

module.exports = {
  EXPECTED_REPLICA_SET,
  OWNERSHIP_ID,
  STAGING_DATABASE_NAME,
  STAGING_MONGODB_HOST,
  STAGING_BSON_OPTIONS,
  assertExpectedActiveOwnership,
  assertReplicaSetIdentity,
  assertSafeInactiveOwnership,
  assertStagingTarget,
  cleanupRunScopedCollections,
  createOwnershipWriteConflictTracker,
  getRunScopedOwnershipCollectionName,
};
