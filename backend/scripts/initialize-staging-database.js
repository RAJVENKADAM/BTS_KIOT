"use strict";

const dns = require("node:dns");
const net = require("node:net");
const { MongoClient } = require("mongodb");
const GpsDevice = require("../src/models/GpsDevice");
const LoginAttemptBucket = require("../src/models/LoginAttemptBucket");
const {
  LOGIN_ATTEMPT_COLLECTION,
  LOGIN_ATTEMPT_INDEX_KEYS,
  LOGIN_ATTEMPT_INDEX_OPTIONS,
} = require("./staging-database-definitions");

const STAGING_DATABASE_NAME = "bts_staging_db";
const STAGING_MONGODB_HOST = "rajvenkadam.hm6bni0.mongodb.net";
const CONNECTION_OPTIONS = {
  maxPoolSize: 2,
  minPoolSize: 0,
  serverSelectionTimeoutMS: 10_000,
  connectTimeoutMS: 5_000,
  socketTimeoutMS: 10_000,
  waitQueueTimeoutMS: 5_000,
  appName: "BTMS-staging-database-initializer",
};
const GPS_COLLECTION = GpsDevice.collection.collectionName;
const LOGIN_ATTEMPT_SCHEMA_COLLECTION =
  LoginAttemptBucket.collection.collectionName;
const GPS_INDEXES = GpsDevice.schema.indexes();
const MAX_ERROR_MESSAGE_LENGTH = 2_048;
const MAX_ERROR_MESSAGES = 24;

class InitializationError extends Error {
  constructor(message, report) {
    super(message);
    this.name = "InitializationError";
    this.report = report;
  }
}

function assertStagingTarget(env = process.env) {
  if (
    String(env.NODE_ENV || "").toLowerCase() === "production" ||
    String(process.env.NODE_ENV || "").toLowerCase() === "production"
  ) {
    throw new Error("Refusing staging initialization when NODE_ENV=production.");
  }
  if (env.BTMS_DATABASE_ENVIRONMENT !== "staging") {
    throw new Error("Set BTMS_DATABASE_ENVIRONMENT=staging to identify the target.");
  }
  if (env.BTMS_STAGING_DB_NAME !== STAGING_DATABASE_NAME) {
    throw new Error(
      `Set BTMS_STAGING_DB_NAME=${STAGING_DATABASE_NAME} exactly.`,
    );
  }
  if (!env.MONGODB_URI || !String(env.MONGODB_URI).trim()) {
    throw new Error("MONGODB_URI is required; its value will not be displayed.");
  }

  let connectionString;
  try {
    connectionString = new URL(env.MONGODB_URI);
  } catch {
    throw new Error("MONGODB_URI is invalid; its value will not be displayed.");
  }
  if (!["mongodb:", "mongodb+srv:"].includes(connectionString.protocol)) {
    throw new Error("MONGODB_URI must use the MongoDB or MongoDB SRV protocol.");
  }
  if (!connectionString.username || !connectionString.password) {
    throw new Error("MONGODB_URI must include both username and password credentials.");
  }
  const authSources = [...connectionString.searchParams.entries()]
    .filter(([name]) => name.toLowerCase() === "authsource")
    .map(([, value]) => value.toLowerCase());
  if (authSources.length > 1 || authSources.includes("bts_db")) {
    throw new Error(
      "MONGODB_URI has an ambiguous or production authentication database.",
    );
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(connectionString.pathname.replace(/^\/+/, ""));
  } catch {
    throw new Error("MONGODB_URI has an invalid database path.");
  }
  if (databaseName.toLowerCase() === "bts_db") {
    throw new Error("Refusing to initialize the production database.");
  }
  if (databaseName !== STAGING_DATABASE_NAME) {
    throw new Error("MONGODB_URI database path is not the expected staging database.");
  }

  const hostname = connectionString.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (hostname !== STAGING_MONGODB_HOST) {
    throw new Error("MONGODB_URI hostname is not the expected staging Atlas host.");
  }

  return { databaseName, hostname };
}

function collectErrorDetails(error) {
  const objects = [];
  const strings = [];
  const pending = [error];
  const seen = new Set();
  while (pending.length && objects.length < 12) {
    const current = pending.shift();
    if (typeof current === "string") {
      if (strings.length < MAX_ERROR_MESSAGES) {
        strings.push(current.slice(0, MAX_ERROR_MESSAGE_LENGTH));
      }
      continue;
    }
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    objects.push(current);
    for (const key of ["cause", "reason", "errorResponse", "errInfo", "response"]) {
      if (current[key] !== undefined) pending.push(current[key]);
    }
    for (const key of ["message", "errmsg", "$err"]) {
      if (typeof current[key] === "string" && strings.length < MAX_ERROR_MESSAGES) {
        strings.push(current[key].slice(0, MAX_ERROR_MESSAGE_LENGTH));
      }
    }
  }
  return {
    objects,
    messages: [...new Set(strings)].slice(0, MAX_ERROR_MESSAGES),
  };
}

function classifyErrorMessage(messages) {
  const message = messages.join(" ").slice(0, MAX_ERROR_MESSAGE_LENGTH * 2);
  if (/\b(not authorized|unauthorized)\b/i.test(message)) {
    return "AUTHORIZATION_DENIED";
  }
  if (/\b(namespace|collection)\b.{0,50}\b(already exists|exists)\b/i.test(message)) {
    return "NAMESPACE_CONFLICT";
  }
  if (/\b(invalid|malformed)\s+(namespace|collection)\b/i.test(message)) {
    return "INVALID_NAMESPACE";
  }
  if (
    /\bnot allowed to perform action\s+\[[A-Za-z][A-Za-z0-9]*\]/i.test(message) ||
    /\baction\s+\[[A-Za-z][A-Za-z0-9]*\]\s+(?:is\s+)?not allowed\b/i.test(message)
  ) {
    return "ACTION_RESTRICTION";
  }
  if (/\bfeatureCompatibilityVersion\b|\bFCV\b/i.test(message)) {
    return "FEATURE_COMPATIBILITY";
  }
  if (
    /\b(?:operation|command|feature)\b.{0,60}\b(?:not supported|unsupported)\b/i.test(message) ||
    /\bunsupported\b.{0,60}\b(?:operation|command|feature)\b/i.test(message)
  ) {
    return "UNSUPPORTED_OPERATION";
  }
  if (
    /\b(?:quota|resource limit|rate limit)\b.{0,60}\b(?:exceeded|reached)\b/i.test(message) ||
    /\b(?:exceeded|reached)\b.{0,60}\b(?:quota|resource limit|rate limit)\b/i.test(message)
  ) {
    return "RESOURCE_LIMIT";
  }
  return null;
}

function safeAuthorizationDetails(error, operation, databaseName, messages) {
  const message = messages.join(" ");
  const actionMatch =
    message.match(/action\s+\[([A-Za-z][A-Za-z0-9]*)\]/i) ||
    message.match(/execute command\s*\{\s*([A-Za-z][A-Za-z0-9]*)\s*:/i);
  const commandAction = actionMatch?.[1]?.toLowerCase();
  const commandToAction = {
    create: "createCollection",
    createindexes: "createIndex",
    drop: "dropCollection",
    dropindexes: "dropIndex",
  };
  const operationMatch = operation.match(/^(createCollection|createIndex):([A-Za-z0-9_-]+)$/);
  const action =
    (commandAction && commandToAction[commandAction]) ||
    (actionMatch?.[1] && /^[A-Za-z][A-Za-z0-9]*$/.test(actionMatch[1])
      ? actionMatch[1]
      : operationMatch?.[1]) ||
    null;

  const explicitNamespace = message.match(
    /action\s+\[[A-Za-z][A-Za-z0-9]*\]\s+on\s+\[([A-Za-z0-9_.-]+)\]/i,
  )?.[1];
  const commandNamespace = message.match(
    /not authorized on\s+([A-Za-z0-9_-]+)\s+to execute command\s*\{\s*create:\s*["']([A-Za-z0-9_-]+)["']/i,
  );
  const namespace =
    explicitNamespace ||
    (commandNamespace
      ? `${commandNamespace[1]}.${commandNamespace[2]}`
      : operationMatch && /^[A-Za-z0-9_-]+$/.test(databaseName)
        ? `${databaseName}.${operationMatch[2]}`
        : null);
  const authorizationReason =
    /\b(not authorized|unauthorized)\b/i.test(message) ||
    error.some((item) => item?.code === 13 || item?.codeName === "Unauthorized")
      ? "NOT_AUTHORIZED"
      : null;

  const serverRejectionReason =
    authorizationReason ||
    (/\b(namespace|collection)\b.{0,50}\b(already exists|exists)\b/i.test(message)
      ? "NAMESPACE_EXISTS"
      : /\b(invalid|malformed)\s+(namespace|collection)\b/i.test(message)
        ? "INVALID_NAMESPACE"
        : error.some(
              (item) => item?.code === 8000 || item?.codeName === "AtlasError",
            )
          ? "ATLAS_RESTRICTION"
          : error.some((item) => Number.isInteger(item?.code))
            ? "SERVER_REJECTED"
            : null);

  return {
    action,
    namespace,
    authorizationReason,
    serverRejectionReason,
    messageClassification: classifyErrorMessage(messages),
  };
}

function safeErrorDetails(error, operation = "", databaseName = "") {
  const collected = collectErrorDetails(error);
  const causes = collected.objects;
  const networkError = causes.find(
    (cause) =>
      cause?.code === "ECONNREFUSED" ||
      cause?.syscall ||
      cause?.codeName === "AuthenticationFailed" ||
      cause?.code === 18,
  ) || error;
  const serverError = causes.find(
    (cause) => Number.isInteger(cause?.code) || typeof cause?.codeName === "string",
  ) || error;
  const code = serverError?.code ?? networkError?.code;
  const codeName = serverError?.codeName ?? networkError?.codeName;
  const syscall =
    typeof networkError?.syscall === "string" &&
    /^[A-Za-z0-9_]{1,60}$/.test(networkError.syscall)
      ? networkError.syscall
      : null;
  const port = Number.isInteger(networkError?.port)
    ? networkError.port
    : null;
  const networkPhase =
    codeName === "AuthenticationFailed" || code === 18
      ? "AUTHENTICATION"
      : syscall === "querySrv" ||
          syscall === "queryTxt" ||
          port === 53
        ? "DNS_RESOLUTION"
        : code === "ECONNREFUSED" && syscall === "connect"
          ? "TCP_CONNECTIVITY"
          : code === "ECONNREFUSED"
            ? "NETWORK_REFUSAL_UNCLASSIFIED"
            : null;
  return {
    code: Number.isInteger(code)
      ? code
      : typeof code === "string" && /^[A-Za-z0-9_]+$/.test(code)
        ? code
        : null,
    codeName:
      typeof codeName === "string" && /^[A-Za-z0-9_]+$/.test(codeName)
        ? codeName
        : null,
    syscall,
    address: net.isIP(networkError?.address || "")
      ? networkError.address
      : null,
    port,
    networkPhase,
    ...safeAuthorizationDetails(causes, operation, databaseName, collected.messages),
  };
}

function configureStagingDns(env, setServers = dns.setServers) {
  const servers = String(env.BTMS_STAGING_DNS_SERVERS || "")
    .split(",")
    .map((server) => server.trim())
    .filter(Boolean);
  if (!servers.length) return 0;
  if (servers.some((server) => !net.isIP(server))) {
    throw new Error("BTMS_STAGING_DNS_SERVERS must contain valid IP addresses.");
  }
  setServers(servers);
  return servers.length;
}

function makeReport(target) {
  return {
    status: "IN_PROGRESS",
    target,
    operations: [],
    duplicateChecks: [],
    failure: null,
  };
}

function stopWithFailure(report, operation, error, status = "FAILED") {
  const failure = {
    operation,
    status,
    error: safeErrorDetails(error, operation, report.target.databaseName),
  };
  report.operations.push(failure);
  report.failure = failure;
  report.status = status === "BLOCKED" ? "BLOCKED" : "FAILED";
  throw new InitializationError(
    status === "BLOCKED"
      ? "Initialization blocked by duplicate GPS data; no records were changed."
      : "Staging initialization failed; see safe operation details.",
    report,
  );
}

async function listCollectionNames(db) {
  const collections = await db
    .listCollections({}, { authorizedCollections: true, nameOnly: true })
    .toArray();
  return new Set(collections.map((collection) => collection.name));
}

async function ensureCollection(db, collectionName, knownCollections, report) {
  if (knownCollections.has(collectionName)) {
    report.operations.push({
      operation: "collection",
      name: collectionName,
      status: "EXISTING",
    });
    return;
  }

  try {
    await db.createCollection(collectionName);
    knownCollections.add(collectionName);
    report.operations.push({
      operation: "collection",
      name: collectionName,
      status: "CREATED",
    });
  } catch (error) {
    if (error?.code === 48) {
      const currentCollections = await listCollectionNames(db);
      if (currentCollections.has(collectionName)) {
        knownCollections.add(collectionName);
        report.operations.push({
          operation: "collection",
          name: collectionName,
          status: "EXISTING",
        });
        return;
      }
    }
    stopWithFailure(report, `createCollection:${collectionName}`, error);
  }
}

function gpsIndexLabel(keys, options) {
  if (keys.deviceId === 1 && Object.keys(keys).length === 1) {
    return "gpsDeviceIdentityUniqueIndex";
  }
  if (
    keys.bus_id === 1 &&
    Object.keys(keys).length === 1 &&
    options.unique === true &&
    options.partialFilterExpression?.is_active === true
  ) {
    return "gpsActiveBusAssignmentUniqueIndex";
  }
  return `gpsIndex:${Object.keys(keys).join("_")}`;
}

async function checkGpsDuplicates(db, collectionName, keys, options, report) {
  const keyField = Object.keys(keys)[0];
  const pipeline = [];
  if (options.partialFilterExpression) {
    pipeline.push({ $match: options.partialFilterExpression });
  }
  pipeline.push(
    {
      $group: {
        _id: `$${keyField}`,
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $limit: 1 },
  );

  let duplicates;
  try {
    duplicates = await db.collection(collectionName).aggregate(pipeline, {
      maxTimeMS: 10_000,
    }).toArray();
  } catch (error) {
    stopWithFailure(report, `duplicateCheck:${keyField}`, error);
  }

  const check = {
    field: keyField,
    status: duplicates.length ? "DUPLICATES_FOUND" : "CLEAR",
    duplicateGroupsFound: duplicates.length > 0,
  };
  report.duplicateChecks.push(check);
  if (duplicates.length) {
    stopWithFailure(
      report,
      `duplicateCheck:${keyField}`,
      { code: "DUPLICATE_DATA" },
      "BLOCKED",
    );
  }
}

async function ensureIndex(db, collectionName, keys, options, label, report) {
  try {
    const name = await db.collection(collectionName).createIndex(keys, options);
    report.operations.push({
      operation: "index",
      collection: collectionName,
      label,
      name,
      status: "ENSURED",
    });
  } catch (error) {
    stopWithFailure(report, `createIndex:${label}`, error);
  }
}

async function initializeStagingDatabase({
  env = process.env,
  createClient = (uri, options) => new MongoClient(uri, options),
  setDnsServers = dns.setServers,
} = {}) {
  const target = assertStagingTarget(env);
  const report = makeReport(target);
  if (LOGIN_ATTEMPT_SCHEMA_COLLECTION !== LOGIN_ATTEMPT_COLLECTION) {
    throw new Error(
      "Login-attempt model collection does not match the migration collection.",
    );
  }
  let client;
  let failure;
  let currentOperation = "dnsConfiguration";

  try {
    configureStagingDns(env, setDnsServers);
    currentOperation = "clientConstruction";
    client = createClient(env.MONGODB_URI, CONNECTION_OPTIONS);
    currentOperation = "connect";
    await client.connect();
    currentOperation = "databaseOperations";
    const db = client.db(target.databaseName);
    let collections;
    try {
      collections = await listCollectionNames(db);
    } catch (error) {
      stopWithFailure(report, "listCollections", error);
    }

    if (collections.has(GPS_COLLECTION)) {
      for (const [keys, options] of GPS_INDEXES) {
        await checkGpsDuplicates(
          db,
          GPS_COLLECTION,
          keys,
          options,
          report,
        );
      }
    }

    await ensureCollection(db, LOGIN_ATTEMPT_COLLECTION, collections, report);
    await ensureCollection(db, GPS_COLLECTION, collections, report);
    await ensureIndex(
      db,
      LOGIN_ATTEMPT_COLLECTION,
      LOGIN_ATTEMPT_INDEX_KEYS,
      LOGIN_ATTEMPT_INDEX_OPTIONS,
      "loginAttemptTtlIndex",
      report,
    );
    for (const [keys, options] of GPS_INDEXES) {
      await ensureIndex(
        db,
        GPS_COLLECTION,
        keys,
        options,
        gpsIndexLabel(keys, options),
        report,
      );
    }
    report.status = "SUCCEEDED";
  } catch (error) {
    failure =
      error instanceof InitializationError
        ? error
        : new InitializationError(
            "Staging initialization failed; see safe operation details.",
            report,
          );
    if (!report.failure) {
      report.failure = {
        operation: currentOperation,
        status: "FAILED",
        error: safeErrorDetails(error, currentOperation, target.databaseName),
      };
      report.operations.push(report.failure);
      report.status = "FAILED";
    }
  }

  if (client) {
    try {
      await client.close();
    } catch (error) {
      if (!failure) {
        report.failure = {
          operation: "close",
          status: "FAILED",
          error: safeErrorDetails(error, "close", target.databaseName),
        };
        report.operations.push(report.failure);
        report.status = "FAILED";
        failure = new InitializationError(
          "Staging initialization could not confirm clean connection shutdown.",
          report,
        );
      }
    }
  }

  if (failure) throw failure;
  return report;
}

if (require.main === module) {
  require("dotenv").config();
  initializeStagingDatabase()
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
    })
    .catch((error) => {
      if (error.report) {
        console.error(JSON.stringify(error.report, null, 2));
      } else {
        console.error(error.message);
      }
      process.exitCode = 1;
    });
}

module.exports = {
  CONNECTION_OPTIONS,
  GPS_COLLECTION,
  InitializationError,
  STAGING_DATABASE_NAME,
  STAGING_MONGODB_HOST,
  assertStagingTarget,
  classifyErrorMessage,
  configureStagingDns,
  initializeStagingDatabase,
};
