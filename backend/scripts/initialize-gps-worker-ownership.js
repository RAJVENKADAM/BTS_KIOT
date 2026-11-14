"use strict";

const { MongoClient, Long } = require("mongodb");

const STAGING_DATABASE_NAME = "bts_staging_db";
const STAGING_MONGODB_HOST = "rajvenkadam.hm6bni0.mongodb.net";
const COLLECTION_NAME = "gpsworkerownerships";
const OWNERSHIP_ID = "gps-worker";

class StagingTargetError extends Error {
  constructor(message) {
    super(message);
    this.name = "StagingTargetError";
  }
}

function assertStagingTarget(env = process.env) {
  if (
    String(env.NODE_ENV || "").toLowerCase() === "production" ||
    String(process.env.NODE_ENV || "").toLowerCase() === "production"
  ) {
    throw new StagingTargetError(
      "Refusing GPS ownership provisioning when NODE_ENV=production.",
    );
  }
  if (env.BTMS_DATABASE_ENVIRONMENT !== "staging") {
    throw new StagingTargetError(
      "Set BTMS_DATABASE_ENVIRONMENT=staging to identify the target.",
    );
  }
  if (env.BTMS_STAGING_DB_NAME !== STAGING_DATABASE_NAME) {
    throw new StagingTargetError(
      `Set BTMS_STAGING_DB_NAME=${STAGING_DATABASE_NAME} exactly.`,
    );
  }
  if (!env.MONGODB_URI || !String(env.MONGODB_URI).trim()) {
    throw new StagingTargetError(
      "MONGODB_URI is required; its value will not be displayed.",
    );
  }

  let uri;
  try {
    uri = new URL(env.MONGODB_URI);
  } catch {
    throw new StagingTargetError(
      "MONGODB_URI is invalid; its value will not be displayed.",
    );
  }
  if (
    !["mongodb:", "mongodb+srv:"].includes(uri.protocol) ||
    !uri.username ||
    !uri.password
  ) {
    throw new StagingTargetError(
      "MONGODB_URI must be a credentialed MongoDB staging URI.",
    );
  }
  const authSources = [...uri.searchParams.entries()]
    .filter(([name]) => name.toLowerCase() === "authsource")
    .map(([, value]) => value.toLowerCase());
  if (authSources.length > 1 || authSources.includes("bts_db")) {
    throw new StagingTargetError(
      "MONGODB_URI has an ambiguous or production authentication database.",
    );
  }
  let databaseName;
  try {
    databaseName = decodeURIComponent(uri.pathname.replace(/^\/+/, ""));
  } catch {
    throw new StagingTargetError("MONGODB_URI has an invalid database path.");
  }
  if (databaseName.toLowerCase() === "bts_db") {
    throw new StagingTargetError(
      "Refusing to provision the production database.",
    );
  }
  if (databaseName !== STAGING_DATABASE_NAME) {
    throw new StagingTargetError(
      "MONGODB_URI database path is not the expected staging database.",
    );
  }
  if (uri.hostname.toLowerCase() !== STAGING_MONGODB_HOST) {
    throw new StagingTargetError(
      "MONGODB_URI hostname is not the expected staging Atlas host.",
    );
  }
  return databaseName;
}

function isValidOwnershipRecord(
  document,
  { allowMissingConfigVersion = false } = {},
) {
  const isFiniteDate = (value) =>
    value instanceof Date && Number.isFinite(value.getTime());
  const configVersionValid =
    document?.configVersion?._bsontype === "Long" &&
    document.configVersion.greaterThanOrEqual(Long.ZERO);
  const ownerValid =
    document?.state === "active"
      ? typeof document.ownerId === "string" && document.ownerId.length > 0
      : document?.state === "inactive" && document.ownerId === null;
  return (
    document?._id === OWNERSHIP_ID &&
    document.token?._bsontype === "Long" &&
    document.token.greaterThanOrEqual(Long.ZERO) &&
    document.writeVersion?._bsontype === "Long" &&
    document.writeVersion.greaterThanOrEqual(Long.ZERO) &&
    (configVersionValid ||
      (allowMissingConfigVersion && document?.configVersion === undefined)) &&
    ["active", "inactive"].includes(document.state) &&
    isFiniteDate(document.leaseExpiresAt) &&
    ownerValid &&
    isFiniteDate(document.updatedAt)
  );
}

function getSafeErrorDetails(error) {
  return {
    name:
      typeof error?.name === "string" &&
      /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(error.name)
        ? error.name
        : "Error",
    code:
      Number.isSafeInteger(error?.code) ||
      (typeof error?.code === "string" && /^[A-Z0-9_]{1,60}$/.test(error.code))
        ? error.code
        : null,
    codeName:
      typeof error?.codeName === "string" &&
      /^[A-Za-z0-9_]{1,60}$/.test(error.codeName)
        ? error.codeName
        : null,
    message:
      error instanceof StagingTargetError
        ? error.message
        : "Provisioning failed; raw error details were omitted.",
  };
}

async function initialize({
  env = process.env,
  MongoClientClass = MongoClient,
  logger = console,
} = {}) {
  const databaseName = assertStagingTarget(env);
  const client = new MongoClientClass(env.MONGODB_URI, {
    maxPoolSize: 2,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 5_000,
    waitQueueTimeoutMS: 5_000,
    appName: "BTMS-staging-gps-ownership-provisioner",
  });
  let connected = false;
  let collectionCreated = false;
  try {
    await client.connect();
    connected = true;
    const database = client.db(databaseName);
    try {
      await database.createCollection(COLLECTION_NAME);
      collectionCreated = true;
      logger.info("Created GPS worker ownership collection.");
    } catch (error) {
      if (error?.code !== 48 && error?.codeName !== "NamespaceExists") {
        throw error;
      }
      logger.info("GPS worker ownership collection already exists.");
    }
    const collection = database.collection(COLLECTION_NAME);
    const handleExistingRecord = async (existing) => {
      if (existing.state === "active") {
        throw new Error("GPS worker ownership is active; no changes made.");
      }
      if (
        !isValidOwnershipRecord(existing, {
          allowMissingConfigVersion: true,
        }) ||
        existing.state !== "inactive" ||
        existing.ownerId !== null
      ) {
        throw new Error(
          "Existing GPS worker ownership record is invalid or active; no changes made.",
        );
      }
      if (existing.configVersion === undefined) {
        const upgrade = await collection.updateOne(
          {
            _id: OWNERSHIP_ID,
            state: "inactive",
            ownerId: null,
            configVersion: { $exists: false },
          },
          { $set: { configVersion: Long.ZERO, updatedAt: new Date() } },
          { writeConcern: { w: "majority" } },
        );
        if (upgrade.matchedCount !== 1) {
          throw new Error(
            "GPS ownership record changed during provisioning; no further changes made.",
          );
        }
        const upgraded = await collection.findOne({ _id: OWNERSHIP_ID });
        if (
          !isValidOwnershipRecord(upgraded) ||
          upgraded.state !== "inactive" ||
          upgraded.ownerId !== null
        ) {
          throw new Error(
            "GPS ownership record upgrade could not be verified.",
          );
        }
        logger.info(
          "Added the GPS configuration version to the inactive ownership record.",
        );
        return;
      }
      logger.info(
        "GPS worker ownership record already exists; no changes made.",
      );
    };

    const existing = await collection.findOne({ _id: OWNERSHIP_ID });
    if (existing) {
      await handleExistingRecord(existing);
      return { collectionCreated, recordCreated: false };
    }

    const now = new Date();
    try {
      await collection.insertOne({
        _id: OWNERSHIP_ID,
        token: Long.ZERO,
        ownerId: null,
        state: "inactive",
        leaseExpiresAt: new Date(0),
        writeVersion: Long.ZERO,
        configVersion: Long.ZERO,
        updatedAt: now,
      });
      logger.info("Created inactive GPS worker ownership record.");
      return { collectionCreated, recordCreated: true };
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const concurrentRecord = await collection.findOne({ _id: OWNERSHIP_ID });
      if (!concurrentRecord) {
        throw new Error(
          "Concurrent GPS ownership initialization produced invalid state.",
        );
      }
      await handleExistingRecord(concurrentRecord);
      logger.info("GPS worker ownership record was created concurrently.");
      return { collectionCreated, recordCreated: false };
    }
  } finally {
    if (connected) await client.close();
  }
}

if (require.main === module) {
  require("dotenv").config();
  initialize().catch((error) => {
    console.error(
      "GPS worker ownership provisioning failed:",
      getSafeErrorDetails(error),
    );
    process.exitCode = 1;
  });
}

module.exports = {
  assertStagingTarget,
  getSafeErrorDetails,
  initialize,
  isValidOwnershipRecord,
};
