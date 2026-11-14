"use strict";

const { MongoClient, Long } = require("mongodb");
const { ConnectionString } = require("mongodb-connection-string-url");
const { buildMongoURI } = require("../src/config/mongodb");
const GpsWorkerOwnership = require("../src/models/GpsWorkerOwnership");

const DATABASE_NAME = "bts_db";
const STAGING_DATABASE_NAME = "bts_staging_db";
const STAGING_MONGODB_HOST = "rajvenkadam.hm6bni0.mongodb.net";
const COLLECTION_NAME = GpsWorkerOwnership.collection.collectionName;
const OWNERSHIP_ID = "gps-worker";
const CONFIRMATION_ENV = "BTMS_PRODUCTION_GPS_OWNERSHIP_CONFIRMATION";

class ProductionTargetError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProductionTargetError";
  }
}

function assertProductionTarget(env = process.env) {
  if (env.NODE_ENV !== "production") {
    throw new ProductionTargetError("NODE_ENV must be production.");
  }

  if (env.BTMS_PRODUCTION_DB_NAME !== DATABASE_NAME) {
    throw new ProductionTargetError(
      `Set BTMS_PRODUCTION_DB_NAME=${DATABASE_NAME} exactly.`,
    );
  }

  if (!env.MONGODB_URI || !String(env.MONGODB_URI).trim()) {
    throw new ProductionTargetError(
      "MONGODB_URI is required; its value will not be displayed.",
    );
  }

  // Independently supplied expected seed-list hosts.
  const expectedHosts = String(env.BTMS_PRODUCTION_MONGODB_HOSTS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

  const hostPattern =
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}:27017$/;

  if (
    expectedHosts.length === 0 ||
    expectedHosts.some((host) => !hostPattern.test(host)) ||
    new Set(expectedHosts).size !== expectedHosts.length
  ) {
    throw new ProductionTargetError(
      "BTMS_PRODUCTION_MONGODB_HOSTS must contain the independently verified production seed-list hosts with port 27017.",
    );
  }

  let mongoURI;
  let uri;

  try {
    // Use exactly the same database-selection logic as BTS.
    mongoURI = buildMongoURI({
      ...env,
      DB_NAME: DATABASE_NAME,
    });

    uri = new ConnectionString(mongoURI);
  } catch {
    throw new ProductionTargetError(
      "MONGODB_URI is invalid; its value will not be displayed.",
    );
  }

  if (
    !["mongodb:", "mongodb+srv:"].includes(uri.protocol) ||
    !uri.username ||
    !uri.password ||
    uri.hash
  ) {
    throw new ProductionTargetError(
      "MONGODB_URI must be a credentialed MongoDB URI.",
    );
  }

  const actualHosts = uri.hosts
    .map((host) => host.toString().toLowerCase())
    .sort();

  const sortedExpectedHosts = [...expectedHosts].sort();

  if (
    actualHosts.length !== sortedExpectedHosts.length ||
    actualHosts.some((host, index) => host !== sortedExpectedHosts[index])
  ) {
    throw new ProductionTargetError(
      "MongoDB seed-list hosts do not match the independently verified production hosts.",
    );
  }

  if (actualHosts.some((host) => host.split(":")[0] === STAGING_MONGODB_HOST)) {
    throw new ProductionTargetError(
      "The known staging MongoDB hostname cannot be used for production provisioning.",
    );
  }

  let databaseName;

  try {
    if (
      !uri.pathname.startsWith("/") ||
      uri.pathname.startsWith("//") ||
      uri.pathname.slice(1).includes("/")
    ) {
      throw new Error("Invalid database path.");
    }

    databaseName = decodeURIComponent(uri.pathname.slice(1));
  } catch {
    throw new ProductionTargetError("MongoDB URI database path is invalid.");
  }

  if (databaseName !== DATABASE_NAME) {
    throw new ProductionTargetError(
      `MongoDB URI must select ${DATABASE_NAME} exactly; staging database ${STAGING_DATABASE_NAME} is refused.`,
    );
  }

  const authSources = [...uri.searchParams.entries()].filter(
    ([name]) => name.toLowerCase() === "authsource",
  );

  const expectedAuthDatabase = String(env.BTMS_PRODUCTION_AUTH_DB || "").trim();

  if (
    !expectedAuthDatabase ||
    /(^|[_-])staging($|[_-])/i.test(expectedAuthDatabase) ||
    authSources.length !== 1 ||
    authSources[0][0] !== "authSource" ||
    authSources[0][1] !== expectedAuthDatabase
  ) {
    throw new ProductionTargetError(
      "MONGODB_URI must contain exactly one canonical authSource matching BTMS_PRODUCTION_AUTH_DB.",
    );
  }

  const expectedConfirmation = `initialize:${DATABASE_NAME}@${sortedExpectedHosts.join(",")}`;

  if (env[CONFIRMATION_ENV] !== expectedConfirmation) {
    throw new ProductionTargetError(
      `${CONFIRMATION_ENV} must explicitly confirm this database and seed-list target.`,
    );
  }

  return {
    databaseName,
    mongoURI,
  };
}

function isValidInactiveOwnershipRecord(document) {
  const isNonnegativeLong = (value) =>
    value?._bsontype === "Long" && value.greaterThanOrEqual(Long.ZERO);
  const isFiniteDate = (value) =>
    value instanceof Date && Number.isFinite(value.getTime());

  return Boolean(
    document &&
    document._id === OWNERSHIP_ID &&
    isNonnegativeLong(document.token) &&
    document.ownerId === null &&
    document.state === "inactive" &&
    isFiniteDate(document.leaseExpiresAt) &&
    isNonnegativeLong(document.writeVersion) &&
    isNonnegativeLong(document.configVersion) &&
    isFiniteDate(document.updatedAt),
  );
}

function isInitialOwnershipRecord(document) {
  return Boolean(
    isValidInactiveOwnershipRecord(document) &&
    document.token.equals(Long.ZERO) &&
    document.leaseExpiresAt.getTime() === 0 &&
    document.writeVersion.equals(Long.ZERO) &&
    document.configVersion.equals(Long.ZERO),
  );
}

function assertValidInactiveRecord(document, context) {
  if (!document || document.state === "active") {
    throw new Error(
      `GPS ownership ${context} is active or missing; no ownership changes were made.`,
    );
  }
  if (!isValidInactiveOwnershipRecord(document)) {
    throw new Error(
      `GPS ownership ${context} is malformed or inconsistent; no ownership changes were made.`,
    );
  }
}

async function ensureCollection(database) {
  const exists = async () =>
    (
      await database
        .listCollections({ name: COLLECTION_NAME }, { nameOnly: true })
        .toArray()
    ).length > 0;
  if (await exists()) return false;

  try {
    await database.createCollection(COLLECTION_NAME);
    return true;
  } catch (error) {
    if (error?.code !== 48 && error?.codeName !== "NamespaceExists") {
      throw error;
    }
    if (await exists()) return false;
    throw new Error(
      "GPS ownership collection creation raced but the collection is still missing.",
    );
  }
}

async function initializeProductionGpsWorkerOwnership({
  env = process.env,
  MongoClientClass = MongoClient,
  logger = console,
} = {}) {
  const { databaseName, mongoURI } = assertProductionTarget(env);
  const client = new MongoClientClass(mongoURI, {
    maxPoolSize: 2,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 5_000,
    waitQueueTimeoutMS: 5_000,
    appName: "BTMS-production-gps-ownership-provisioner",
  });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const database = client.db(databaseName);
    const collectionCreated = await ensureCollection(database);
    const collection = database.collection(COLLECTION_NAME);
    const existing = await collection.findOne({ _id: OWNERSHIP_ID });
    if (existing) {
      assertValidInactiveRecord(existing, "record");
      logger.info(
        "GPS worker ownership is already provisioned; no changes made.",
      );
      return {
        collectionCreated,
        recordCreated: false,
        alreadyProvisioned: true,
      };
    }

    const initialRecord = {
      _id: OWNERSHIP_ID,
      token: Long.ZERO,
      ownerId: null,
      state: "inactive",
      leaseExpiresAt: new Date(0),
      writeVersion: Long.ZERO,
      configVersion: Long.ZERO,
      updatedAt: new Date(),
    };

    try {
      await collection.insertOne(initialRecord, {
        writeConcern: { w: "majority" },
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const concurrentRecord = await collection.findOne({
        _id: OWNERSHIP_ID,
      });
      assertValidInactiveRecord(
        concurrentRecord,
        "record created concurrently",
      );
      logger.info(
        "GPS worker ownership was provisioned concurrently; no existing state was changed.",
      );
      return {
        collectionCreated,
        recordCreated: false,
        alreadyProvisioned: true,
      };
    }

    const verifiedRecord = await collection.findOne({ _id: OWNERSHIP_ID });
    if (!isInitialOwnershipRecord(verifiedRecord)) {
      throw new Error(
        "GPS ownership read-back did not match the exact inactive initial state.",
      );
    }
    logger.info("Created and verified inactive GPS worker ownership state.");
    return {
      collectionCreated,
      recordCreated: true,
      alreadyProvisioned: false,
    };
  } finally {
    if (connected) await client.close();
  }
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
      error instanceof ProductionTargetError
        ? error.message
        : "Provisioning failed; raw error details were omitted.",
  };
}

if (require.main === module) {
  initializeProductionGpsWorkerOwnership().catch((error) => {
    console.error(
      "Production GPS worker ownership provisioning failed:",
      getSafeErrorDetails(error),
    );
    process.exitCode = 1;
  });
}

module.exports = {
  COLLECTION_NAME,
  CONFIRMATION_ENV,
  DATABASE_NAME,
  assertProductionTarget,
  getSafeErrorDetails,
  initializeProductionGpsWorkerOwnership,
  isValidInactiveOwnershipRecord,
};
