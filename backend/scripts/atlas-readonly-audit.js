"use strict";

const { MongoClient } = require("mongodb");

const CONNECTION_OPTIONS = {
  maxPoolSize: 2,
  minPoolSize: 0,
  serverSelectionTimeoutMS: 10_000,
  connectTimeoutMS: 5_000,
  socketTimeoutMS: 10_000,
  waitQueueTimeoutMS: 5_000,
  appName: "BTMS-read-only-audit",
};

const OPERATION_TIMEOUT_MS = 10_000;

function getSafeError(error) {
  const code = error?.code ?? null;
  let category = "DATABASE_OPERATION_FAILED";

  if (code === 13 || error?.codeName === "Unauthorized") {
    category = "DATABASE_ACCESS_DENIED";
  } else if (code === 18 || error?.codeName === "AuthenticationFailed") {
    category = "AUTHENTICATION_FAILED";
  } else if (code === "ECONNREFUSED") {
    category = "CONNECTION_REFUSED";
  } else if (code === "ETIMEDOUT" || code === "ETIMEOUT") {
    category = "TIMEOUT";
  } else if (error?.name === "MongoServerSelectionError") {
    category = "SERVER_SELECTION_FAILED";
  } else if (error?.name === "MongoNetworkError") {
    category = "NETWORK_ERROR";
  }

  return {
    name: error?.name ?? "Error",
    code,
    category,
  };
}

async function inspectCollection(db, info) {
  const result = {
    name: info.name,
    type: info.type ?? "collection",
    estimatedDocumentCount: null,
    indexes: [],
  };

  if (info.type === "view") {
    result.countStatus = "UNSUPPORTED_VIEW";
    result.indexStatus = "UNSUPPORTED_VIEW";
    return result;
  }

  const collection = db.collection(info.name);

  try {
    result.estimatedDocumentCount = await collection.estimatedDocumentCount({
      maxTimeMS: OPERATION_TIMEOUT_MS,
    });
    result.countStatus = "SUCCEEDED";
  } catch (error) {
    result.countStatus = "FAILED";
    result.countError = getSafeError(error);
  }

  try {
    const indexCursor = collection.listIndexes().maxTimeMS(OPERATION_TIMEOUT_MS);
    const indexes = await indexCursor.toArray();
    result.indexes = indexes.map((index) => ({
      name: index.name,
      keys: index.key,
      unique: index.unique === true,
      ttlSeconds: index.expireAfterSeconds ?? null,
    }));
    result.indexStatus = "SUCCEEDED";
  } catch (error) {
    result.indexStatus = "FAILED";
    result.indexError = getSafeError(error);
  }

  return result;
}

async function runAtlasReadonlyAudit() {
  let mongoConfig;
  try {
    mongoConfig = require("../src/config/mongodb");
  } catch (error) {
    return {
      status: "FAILED",
      stage: "CONFIGURATION",
      error: getSafeError(error),
      collections: [],
    };
  }

  const client = new MongoClient(mongoConfig.MONGODB_URI, CONNECTION_OPTIONS);
  const report = {
    status: "FAILED",
    stage: "CONNECTION",
    collections: [],
  };

  try {
    await client.connect();
    const db = client.db();
    report.database = db.databaseName;
    report.stage = "METADATA";
    const collectionInfo = await db
      .listCollections({}, { nameOnly: false, maxTimeMS: OPERATION_TIMEOUT_MS })
      .toArray();

    for (const info of collectionInfo) {
      report.collections.push(await inspectCollection(db, info));
    }

    const incompleteCollections = report.collections.filter((collection) =>
      collection.countStatus !== "SUCCEEDED" ||
      collection.indexStatus !== "SUCCEEDED",
    ).length;
    report.status = incompleteCollections === 0
      ? "SUCCEEDED"
      : "PARTIALLY_COMPLETED";
    report.incompleteCollectionCount = incompleteCollections;
  } catch (error) {
    report.error = getSafeError(error);
  } finally {
    try {
      await client.close();
    } catch (error) {
      report.closeError = getSafeError(error);
      report.status = "FAILED";
      report.stage = "CONNECTION_CLOSE";
    }
  }

  return report;
}

module.exports = { runAtlasReadonlyAudit };

if (require.main === module) {
  runAtlasReadonlyAudit()
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      if (report.status !== "SUCCEEDED") process.exitCode = 1;
    })
    .catch((error) => {
      console.log(JSON.stringify({
        status: "FAILED",
        stage: "UNEXPECTED",
        error: getSafeError(error),
      }));
      process.exitCode = 1;
    });
}
