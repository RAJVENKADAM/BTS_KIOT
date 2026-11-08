"use strict";

const dns = require("node:dns");
const { performance } = require("node:perf_hooks");
const { MongoClient } = require("mongodb");
const { buildMongoURI } = require("../src/config/mongodb");

const STAGING_DATABASE_NAME = "bts_staging_db";
const STAGING_MONGODB_HOST = "rajvenkadam.hm6bni0.mongodb.net";
const COLLECTION_NAMES = ["loginattemptbuckets", "gpsdevices"];
const PRODUCTION_DATABASE_NAMES = new Set(["bts_db"]);
const READ_ONLY_OPTIONS = {
  maxPoolSize: 2,
  minPoolSize: 0,
  serverSelectionTimeoutMS: 10_000,
  connectTimeoutMS: 5_000,
  socketTimeoutMS: 10_000,
  waitQueueTimeoutMS: 5_000,
  appName: "BTMS-staging-readiness-read-only",
};
const SAFE_ERROR_CODES = new Set([
  6, 7, 13, 18, 26, 48, 50, 59, 68, 85, 86, 89, 91, 8000,
  11000, 11600, 11602, 13435, 13436,
]);

function getSafeError(error) {
  const rawCode = error?.code;
  const errorClass =
    typeof error?.name === "string" &&
    /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(error.name)
      ? error.name
      : "Error";
  return {
    name: errorClass,
    code:
      Number.isSafeInteger(rawCode) && SAFE_ERROR_CODES.has(rawCode)
        ? rawCode
        : null,
  };
}

async function runDiagnosticStage(diagnostics, stage, operation) {
  const startedAt = performance.now();
  try {
    const result = await operation();
    diagnostics.push({
      stage,
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      errorClass: null,
      code: null,
    });
    return result;
  } catch (error) {
    const safeError = getSafeError(error);
    diagnostics.push({
      stage,
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      errorClass: safeError.name,
      code: safeError.code,
    });
    throw error;
  }
}

function assertStagingTarget(env = process.env) {
  if (
    String(env.NODE_ENV || "").toLowerCase() === "production" ||
    String(process.env.NODE_ENV || "").toLowerCase() === "production"
  ) {
    throw new Error("Refusing database verification when NODE_ENV=production.");
  }
  if (String(env.BTMS_DATABASE_ENVIRONMENT || "").toLowerCase() !== "staging") {
    throw new Error("Set BTMS_DATABASE_ENVIRONMENT=staging to identify the target.");
  }
  if (!env.MONGODB_URI || !String(env.MONGODB_URI).trim()) {
    throw new Error("MONGODB_URI is required; its value will not be displayed.");
  }
  if (env.BTMS_STAGING_DB_NAME !== STAGING_DATABASE_NAME) {
    throw new Error(`Set BTMS_STAGING_DB_NAME=${STAGING_DATABASE_NAME} exactly.`);
  }
  if (env.BTMS_STAGING_MONGODB_HOST !== STAGING_MONGODB_HOST) {
    throw new Error(
      `Set BTMS_STAGING_MONGODB_HOST=${STAGING_MONGODB_HOST} exactly.`,
    );
  }

  let connectionString;
  try {
    connectionString = new URL(buildMongoURI(env));
  } catch {
    throw new Error("MONGODB_URI is invalid; its value will not be displayed.");
  }
  if (!["mongodb:", "mongodb+srv:"].includes(connectionString.protocol)) {
    throw new Error("MONGODB_URI must use the MongoDB or MongoDB SRV protocol.");
  }
  let databaseName;
  try {
    databaseName = decodeURIComponent(
      connectionString.pathname.replace(/^\/+/, ""),
    );
  } catch {
    throw new Error("MONGODB_URI has an invalid database path.");
  }
  if (PRODUCTION_DATABASE_NAMES.has(databaseName.toLowerCase())) {
    throw new Error("Refusing to verify the configured production database.");
  }
  const actualHost = connectionString.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase();

  if (databaseName !== STAGING_DATABASE_NAME) {
    throw new Error(
      "MONGODB_URI database path is not the expected staging database.",
    );
  }
  if (actualHost !== STAGING_MONGODB_HOST) {
    throw new Error(
      "MONGODB_URI hostname is not the expected staging Atlas host.",
    );
  }
  const authSources = [...connectionString.searchParams.entries()]
    .filter(([name]) => name.toLowerCase() === "authsource")
    .map(([, value]) => value.toLowerCase());
  if (authSources.length > 1 || authSources.includes("bts_db")) {
    throw new Error(
      "MONGODB_URI has an ambiguous or production authentication database.",
    );
  }

  return {
    databaseName,
  };
}

function getTransactionSupport({ hello, version }) {
  const versionParts = String(version || "")
    .split(".")
    .slice(0, 2)
    .map(Number);
  if (
    versionParts.length < 2 ||
    versionParts.some((part) => !Number.isInteger(part))
  ) {
    return { supported: null, reason: "SERVER_VERSION_UNAVAILABLE" };
  }

  const major = versionParts[0];
  const minor = versionParts[1];
  const versionAtLeast = (requiredMajor, requiredMinor) =>
    major > requiredMajor ||
    (major === requiredMajor && minor >= requiredMinor);
  const hasSessions = hello?.logicalSessionTimeoutMinutes != null;

  if (hello?.msg === "isdbgrid") {
    return {
      supported: hasSessions && versionAtLeast(4, 2),
      reason: hasSessions
        ? versionAtLeast(4, 2)
          ? "SUPPORTED_SHARDED_CLUSTER"
          : "SERVER_VERSION_TOO_OLD"
        : "RETRYABLE_SESSIONS_UNAVAILABLE",
    };
  }
  if (typeof hello?.setName === "string" && hello.setName) {
    return {
      supported: hasSessions && versionAtLeast(4, 0),
      reason: hasSessions
        ? versionAtLeast(4, 0)
          ? "SUPPORTED_REPLICA_SET"
          : "SERVER_VERSION_TOO_OLD"
        : "RETRYABLE_SESSIONS_UNAVAILABLE",
    };
  }
  if (hello && !hello.msg && !hello.setName) {
    return { supported: false, reason: "STANDALONE_DEPLOYMENT" };
  }
  return { supported: null, reason: "TOPOLOGY_UNAVAILABLE" };
}

function summarizeIndex(index) {
  return {
    name: index.name,
    key: index.key,
    unique: index.unique === true,
    expireAfterSeconds: index.expireAfterSeconds ?? null,
    partialFilterExpression: index.partialFilterExpression ?? null,
  };
}

function findLoginTtlIndex(indexes) {
  return indexes?.find(
    (index) =>
      index.name === "ttl_expires_at" &&
      index.key?.expiresAt === 1 &&
      Object.keys(index.key).length === 1 &&
      index.expireAfterSeconds === 0,
  );
}

function findGpsDeviceIdentityIndex(indexes) {
  return indexes?.find(
    (index) =>
      index.key?.deviceId === 1 &&
      Object.keys(index.key).length === 1 &&
      index.unique === true,
  );
}

function findGpsActiveBusAssignmentIndex(indexes) {
  return indexes?.find(
    (index) =>
      index.key?.bus_id === 1 &&
      Object.keys(index.key).length === 1 &&
      index.unique === true &&
      index.partialFilterExpression?.is_active === true,
  );
}

function getIndexStatus(collection, predicate) {
  if (!collection.exists) return "MISSING";
  if (collection.indexesStatus !== "VERIFIED") return "NOT_VERIFIED";
  return predicate(collection.indexes) ? "PRESENT" : "MISSING";
}

function checkRequiredIndexes(collections) {
  const login = collections.loginattemptbuckets;
  const gps = collections.gpsdevices;

  return {
    loginAttemptTtlIndex: getIndexStatus(login, findLoginTtlIndex),
    gpsDeviceIdentityUniqueIndex: getIndexStatus(gps, findGpsDeviceIdentityIndex),
    gpsActiveBusAssignmentUniqueIndex: getIndexStatus(
      gps,
      findGpsActiveBusAssignmentIndex,
    ),
  };
}

function getIndexInspectionFailure(error) {
  const safeError = {
    code:
      typeof error?.code === "number" ||
      (typeof error?.code === "string" && /^[A-Z0-9_]{1,60}$/.test(error.code))
        ? error.code
        : null,
    codeName:
      typeof error?.codeName === "string" &&
      /^[A-Za-z0-9_]{1,60}$/.test(error.codeName)
        ? error.codeName
        : null,
  };
  const denied =
    safeError.code === 8000 ||
    safeError.code === 13 ||
    safeError.codeName === "Unauthorized";
  return {
    status: "NOT_VERIFIED",
    error: safeError,
    explanation: denied
      ? "Atlas denied listIndexes for this readWrite principal (MongoDB error 8000 / Unauthorized). Index metadata is not verified; no broader privileges are requested."
      : "MongoDB did not allow index metadata to be read. Index metadata is not verified; no privilege changes are requested.",
  };
}

async function collectReadiness(db, databaseName, diagnostics) {
  const admin = db.admin();
  const [buildInfo, hello, collections] = await Promise.all([
    runDiagnosticStage(diagnostics, "buildInfo", () =>
      admin.command({ buildInfo: 1 }),
    ),
    runDiagnosticStage(diagnostics, "hello", () =>
      admin.command({ hello: 1 }),
    ),
    runDiagnosticStage(diagnostics, "listCollections", () =>
      db.listCollections({}, { authorizedCollections: true, nameOnly: true })
        .toArray(),
    ),
  ]);
  const existingCollections = new Set(collections.map((collection) => collection.name));
  const collectionResults = {};

  for (const name of COLLECTION_NAMES) {
    if (!existingCollections.has(name)) {
      collectionResults[name] = {
        exists: false,
        indexesStatus: "NOT_APPLICABLE",
        indexes: null,
      };
      continue;
    }
    try {
      collectionResults[name] = {
        exists: true,
        indexesStatus: "VERIFIED",
        indexes: await runDiagnosticStage(
          diagnostics,
          `indexInspection:${name}`,
          async () =>
            (await db.collection(name).listIndexes().toArray())
              .map(summarizeIndex),
        ),
      };
    } catch (error) {
      const inspection = getIndexInspectionFailure(error);
      collectionResults[name] = {
        exists: true,
        indexesStatus: inspection.status,
        indexes: null,
        indexInspectionError: inspection.error,
        indexInspectionExplanation: inspection.explanation,
      };
    }
  }

  const transactionSupport = getTransactionSupport({
    hello,
    version: buildInfo.version,
  });
  const requiredIndexes = checkRequiredIndexes(collectionResults);
  const readinessChecks = {
    transactionsSupported: transactionSupport.supported === true,
    loginAttemptCollectionExists: collectionResults.loginattemptbuckets.exists
      ? "PRESENT"
      : "MISSING",
    loginAttemptTtlIndex: requiredIndexes.loginAttemptTtlIndex,
    gpsDeviceCollectionExists: collectionResults.gpsdevices.exists
      ? "PRESENT"
      : "MISSING",
    gpsDeviceIdentityUniqueIndex: requiredIndexes.gpsDeviceIdentityUniqueIndex,
    gpsActiveBusAssignmentUniqueIndex:
      requiredIndexes.gpsActiveBusAssignmentUniqueIndex,
  };
  return {
    database: databaseName,
    serverVersion: buildInfo.version,
    topology: hello.msg === "isdbgrid"
      ? "SHARDED_CLUSTER"
      : hello.setName
        ? "REPLICA_SET"
        : "STANDALONE_OR_UNKNOWN",
    replicaSetName: hello.setName || null,
    sessionsSupported: hello.logicalSessionTimeoutMinutes != null,
    transactionsSupported: transactionSupport.supported,
    transactionSupportReason: transactionSupport.reason,
    collections: collectionResults,
    requiredIndexes,
    readiness: {
      status: Object.values(readinessChecks).every((check) => check === true || check === "PRESENT")
        ? "READY"
        : "NOT_READY",
      checks: readinessChecks,
    },
  };
}

async function verifyStagingReadiness({
  env = process.env,
  createClient = (uri, options) => new MongoClient(uri, options),
} = {}) {
  const target = assertStagingTarget(env);
  const report = {
    status: "FAILED",
    readOnly: true,
    database: target.databaseName,
    diagnostics: [],
  };
  let client;
  try {
    const dnsServers = String(env.BTMS_STAGING_DNS_SERVERS || "")
      .split(",")
      .map((server) => server.trim())
      .filter(Boolean);
    if (dnsServers.length) dns.setServers(dnsServers);
    client = createClient(buildMongoURI(env), READ_ONLY_OPTIONS);
    await runDiagnosticStage(report.diagnostics, "connection", () =>
      client.connect(),
    );
    Object.assign(
      report,
      await collectReadiness(client.db(), target.databaseName, report.diagnostics),
    );
    report.status = "SUCCEEDED";
  } catch (error) {
    report.error = getSafeError(error);
  } finally {
    if (client) {
      try {
        await runDiagnosticStage(report.diagnostics, "clientClose", () =>
          client.close(),
        );
      } catch (error) {
        report.status = "FAILED";
        report.closeError = getSafeError(error);
      }
    }
  }
  return report;
}

module.exports = {
  STAGING_DATABASE_NAME,
  STAGING_MONGODB_HOST,
  assertStagingTarget,
  checkRequiredIndexes,
  collectReadiness,
  getIndexInspectionFailure,
  getTransactionSupport,
  verifyStagingReadiness,
};

if (require.main === module) {
  require("dotenv").config();
  verifyStagingReadiness()
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      if (report.status !== "SUCCEEDED") process.exitCode = 1;
    })
    .catch((error) => {
      console.error(JSON.stringify({
        status: "REFUSED",
        error: getSafeError(error),
      }));
      process.exitCode = 1;
    });
}
