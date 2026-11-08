"use strict";

const { MongoClient } = require("mongodb");
const {
  LOGIN_ATTEMPT_COLLECTION: COLLECTION_NAME,
  LOGIN_ATTEMPT_INDEX_NAME: INDEX_NAME,
  LOGIN_ATTEMPT_INDEX_KEYS,
  LOGIN_ATTEMPT_INDEX_OPTIONS,
} = require("./staging-database-definitions");

const STAGING_DATABASE_NAME = "bts_staging_db";
const STAGING_MONGODB_HOST = "rajvenkadam.hm6bni0.mongodb.net";
const MONGO_INDEX_METADATA_FIELDS = new Set(["v", "ns", "key"]);

class SafeMigrationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SafeMigrationError";
  }
}

function getConfirmationValue(direction) {
  return `--confirm=${direction}:${STAGING_DATABASE_NAME}@${STAGING_MONGODB_HOST}`;
}

function parseArguments(argv) {
  const [direction, confirmation, ...extra] = argv;
  if (!["up", "down"].includes(direction) || extra.length > 0) {
    throw new SafeMigrationError(
      `Usage: node scripts/migrate-login-attempts.js <up|down> ${getConfirmationValue("<up|down>")}`,
    );
  }
  if (!confirmation || !confirmation.startsWith("--confirm=")) {
    throw new SafeMigrationError(
      `Explicit target and operation confirmation required: ${getConfirmationValue(direction)}`,
    );
  }
  return { direction, confirmation };
}

function assertMigrationTarget({ env = process.env, direction, confirmation }) {
  if (!["up", "down"].includes(direction)) {
    throw new SafeMigrationError("Migration direction must be explicitly set to up or down.");
  }
  if (
    String(env.NODE_ENV || "").toLowerCase() === "production" ||
    String(process.env.NODE_ENV || "").toLowerCase() === "production"
  ) {
    throw new SafeMigrationError("Refusing login-attempt migration when NODE_ENV=production.");
  }
  if (env.BTMS_DATABASE_ENVIRONMENT !== "staging") {
    throw new SafeMigrationError("Set BTMS_DATABASE_ENVIRONMENT=staging to identify the target.");
  }
  if (env.BTMS_STAGING_DB_NAME !== STAGING_DATABASE_NAME) {
    throw new SafeMigrationError(`Set BTMS_STAGING_DB_NAME=${STAGING_DATABASE_NAME} exactly.`);
  }
  if (env.BTMS_STAGING_MONGODB_HOST !== STAGING_MONGODB_HOST) {
    throw new SafeMigrationError(
      `Set BTMS_STAGING_MONGODB_HOST=${STAGING_MONGODB_HOST} exactly.`,
    );
  }
  if (!env.MONGODB_URI || !String(env.MONGODB_URI).trim()) {
    throw new SafeMigrationError("MONGODB_URI is required; its value will not be displayed.");
  }

  let uri;
  try {
    uri = new URL(env.MONGODB_URI);
  } catch {
    throw new SafeMigrationError("MONGODB_URI is invalid; its value will not be displayed.");
  }
  if (
    !["mongodb:", "mongodb+srv:"].includes(uri.protocol) ||
    !uri.username ||
    !uri.password ||
    uri.port ||
    uri.hash
  ) {
    throw new SafeMigrationError("MONGODB_URI must be an unambiguous credentialed staging URI.");
  }

  const authSources = [...uri.searchParams.entries()]
    .filter(([name]) => name.toLowerCase() === "authsource")
    .map(([, value]) => value.toLowerCase());
  if (
    authSources.length > 1 ||
    authSources.includes("bts_db")
  ) {
    throw new SafeMigrationError("MONGODB_URI has an ambiguous or production authentication database.");
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
    databaseName = decodeURIComponent(uri.pathname.slice(1));
  } catch {
    throw new SafeMigrationError("MONGODB_URI has an invalid database path.");
  }
  if (databaseName.toLowerCase() === "bts_db") {
    throw new SafeMigrationError("Refusing to migrate the production database.");
  }
  if (databaseName !== STAGING_DATABASE_NAME) {
    throw new SafeMigrationError("MONGODB_URI database path is not the expected staging database.");
  }
  if (uri.hostname.toLowerCase() !== STAGING_MONGODB_HOST) {
    throw new SafeMigrationError("MONGODB_URI hostname is not the expected staging Atlas host.");
  }
  if (confirmation !== getConfirmationValue(direction)) {
    throw new SafeMigrationError(
      `Confirmation must exactly match the operation and target: ${getConfirmationValue(direction)}`,
    );
  }

  return { databaseName };
}

function isExpectedTtlIndex(index) {
  if (
    index?.name !== INDEX_NAME ||
    !index.key ||
    Object.keys(index.key).length !== Object.keys(LOGIN_ATTEMPT_INDEX_KEYS).length ||
    Object.entries(LOGIN_ATTEMPT_INDEX_KEYS).some(
      ([field, direction]) => index.key[field] !== direction,
    )
  ) {
    return false;
  }
  const actualOptions = Object.fromEntries(
    Object.entries(index).filter(
      ([name]) => !MONGO_INDEX_METADATA_FIELDS.has(name),
    ),
  );
  return (
    Object.keys(actualOptions).sort().join(",") ===
      Object.keys(LOGIN_ATTEMPT_INDEX_OPTIONS).sort().join(",") &&
    Object.entries(LOGIN_ATTEMPT_INDEX_OPTIONS).every(
      ([name, value]) => actualOptions[name] === value,
    )
  );
}

async function ensureCollection(db) {
  const collections = await db
    .listCollections({ name: COLLECTION_NAME }, { nameOnly: true })
    .toArray();
  if (collections.length === 0) {
    await db.createCollection(COLLECTION_NAME);
  }
}

async function up(db, logger = console) {
  await ensureCollection(db);
  const collection = db.collection(COLLECTION_NAME);
  const indexes = await collection.listIndexes().toArray();
  const existingIndex = indexes.find((index) => index.name === INDEX_NAME);
  if (existingIndex) {
    if (!isExpectedTtlIndex(existingIndex)) {
      throw new SafeMigrationError(
        `Refusing to change unexpected ${INDEX_NAME} index definition.`,
      );
    }
    logger.info(`${COLLECTION_NAME}.${INDEX_NAME} already matches the expected TTL index.`);
    return;
  }
  await collection.createIndex(
    LOGIN_ATTEMPT_INDEX_KEYS,
    LOGIN_ATTEMPT_INDEX_OPTIONS,
  );
  logger.info(
    `Created ${COLLECTION_NAME}.${INDEX_NAME}. Login limiting requires MongoDB transactions (replica set or sharded cluster).`,
  );
}

async function down(db, logger = console) {
  const collections = await db
    .listCollections({ name: COLLECTION_NAME }, { nameOnly: true })
    .toArray();
  if (collections.length === 0) {
    logger.info(`${COLLECTION_NAME} does not exist; nothing to roll back.`);
    return;
  }
  const collection = db.collection(COLLECTION_NAME);
  const indexes = await collection.listIndexes().toArray();
  const index = indexes.find((candidate) => candidate.name === INDEX_NAME);
  if (!index) {
    logger.info(`${INDEX_NAME} does not exist; nothing to roll back.`);
    return;
  }
  if (!isExpectedTtlIndex(index)) {
    throw new SafeMigrationError(
      `Refusing to drop ${INDEX_NAME}; its key or options differ from the expected TTL index.`,
    );
  }
  await collection.dropIndex(INDEX_NAME);
  logger.info(
    `Dropped ${INDEX_NAME}; retained ${COLLECTION_NAME} and its records. Login requests now fail closed until the migration is applied again.`,
  );
}

async function runMigration(db, direction, logger = console) {
  if (direction === "up") return up(db, logger);
  if (direction === "down") return down(db, logger);
  throw new SafeMigrationError("Migration direction must be explicitly set to up or down.");
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  MongoClientClass = MongoClient,
  logger = console,
} = {}) {
  const { direction, confirmation } = parseArguments(argv);
  const { databaseName } = assertMigrationTarget({
    env,
    direction,
    confirmation,
  });

  const client = new MongoClientClass(env.MONGODB_URI, {
    maxPoolSize: 2,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 5_000,
    waitQueueTimeoutMS: 5_000,
    appName: "BTMS-staging-login-attempt-migration",
  });
  let failure;
  try {
    await client.connect();
    await runMigration(client.db(databaseName), direction, logger);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await client.close();
    } catch (error) {
      if (!failure) failure = error;
    }
  }
  if (failure) throw failure;
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
      error instanceof SafeMigrationError
        ? error.message
        : "Database operation failed; raw error details were omitted.",
  };
}

if (require.main === module) {
  require("dotenv").config();
  main().catch((error) => {
    console.error("Login-attempt migration failed:", getSafeErrorDetails(error));
    process.exitCode = 1;
  });
}

module.exports = {
  COLLECTION_NAME,
  INDEX_NAME,
  SafeMigrationError,
  STAGING_DATABASE_NAME,
  STAGING_MONGODB_HOST,
  assertMigrationTarget,
  getConfirmationValue,
  getSafeErrorDetails,
  isExpectedTtlIndex,
  main,
  parseArguments,
  runMigration,
};
