"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  STAGING_DATABASE_NAME,
  STAGING_MONGODB_HOST,
  assertStagingTarget,
  checkRequiredIndexes,
  getIndexInspectionFailure,
  getTransactionSupport,
  verifyStagingReadiness,
} = require("../scripts/verify-staging-readiness");

const stagingEnv = {
  NODE_ENV: "test",
  BTMS_DATABASE_ENVIRONMENT: "staging",
  BTMS_STAGING_DB_NAME: STAGING_DATABASE_NAME,
  BTMS_STAGING_MONGODB_HOST: STAGING_MONGODB_HOST,
  MONGODB_URI:
    "mongodb+srv://user:password@staging.example.mongodb.net/btms_staging?retryWrites=true",
};
const stagingUri = new URL(stagingEnv.MONGODB_URI);
stagingUri.hostname = STAGING_MONGODB_HOST;
stagingUri.pathname = `/${STAGING_DATABASE_NAME}`;
stagingEnv.MONGODB_URI = stagingUri.toString();

test("staging guard rejects production, implicit staging, and missing target identity", () => {
  assert.throws(
    () => assertStagingTarget({ ...stagingEnv, NODE_ENV: "production" }),
    /NODE_ENV=production/,
  );
  assert.throws(
    () => assertStagingTarget({ ...stagingEnv, BTMS_DATABASE_ENVIRONMENT: "production" }),
    /BTMS_DATABASE_ENVIRONMENT=staging/,
  );
  assert.throws(
    () => assertStagingTarget({ ...stagingEnv, BTMS_STAGING_DB_NAME: "" }),
    /BTMS_STAGING_DB_NAME/,
  );
  assert.throws(
    () => assertStagingTarget({ ...stagingEnv, BTMS_STAGING_MONGODB_HOST: "prod.example.mongodb.net" }),
    /BTMS_STAGING_MONGODB_HOST/,
  );
  assert.throws(
    () => assertStagingTarget({
      ...stagingEnv,
      MONGODB_URI: "mongodb+srv://user:secret@staging.example.mongodb.net/bts_db",
      BTMS_STAGING_DB_NAME: STAGING_DATABASE_NAME,
    }),
    /production database/,
  );
  assert.throws(
    () => assertStagingTarget({ ...stagingEnv, MONGODB_URI: "not-a-uri" }),
    /MONGODB_URI is invalid/,
  );
});

test("target validation returns database identity without exposing URI", () => {
  const target = assertStagingTarget(stagingEnv);
  assert.equal(target.databaseName, STAGING_DATABASE_NAME);
  assert.equal(Object.hasOwn(target, "uri"), false);
  assert.equal(JSON.stringify(target).includes("password"), false);
});

test("readiness verifier pins the staging host and rejects production authSource before client construction", async () => {
  const productionAuthSourceUri = new URL(stagingEnv.MONGODB_URI);
  productionAuthSourceUri.searchParams.set("authSource", "bts_db");
  let clientConstructed = false;

  await assert.rejects(
    verifyStagingReadiness({
      env: {
        ...stagingEnv,
        MONGODB_URI: productionAuthSourceUri.toString(),
      },
      createClient() {
        clientConstructed = true;
        throw new Error("client should not be constructed");
      },
    }),
    /production authentication database/,
  );
  assert.equal(clientConstructed, false);

  const wrongHostUri = new URL(stagingEnv.MONGODB_URI);
  wrongHostUri.hostname = "production.example.mongodb.net";
  assert.throws(
    () =>
      assertStagingTarget({
        ...stagingEnv,
        MONGODB_URI: wrongHostUri.toString(),
      }),
    /expected staging Atlas host/,
  );
});

test("verification refuses unsafe targets before constructing a database client", async () => {
  let clientCreated = false;
  await assert.rejects(
    verifyStagingReadiness({
      env: { ...stagingEnv, NODE_ENV: "production" },
      createClient: () => {
        clientCreated = true;
        throw new Error("client should not be constructed");
      },
    }),
    /NODE_ENV=production/,
  );
  assert.equal(clientCreated, false);

  await assert.rejects(
    verifyStagingReadiness({
      env: {
        ...stagingEnv,
        MONGODB_URI: "mongodb+srv://user:secret@staging.example.mongodb.net/bts_db",
        BTMS_STAGING_DB_NAME: STAGING_DATABASE_NAME,
      },
      createClient: () => {
        clientCreated = true;
        throw new Error("client should not be constructed");
      },
    }),
    /production database/,
  );
  assert.equal(clientCreated, false);

  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(
      () => assertStagingTarget({ ...stagingEnv, NODE_ENV: "test" }),
      /NODE_ENV=production/,
    );
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});

test("required login and GPS indexes are matched by exact properties", () => {
  const result = checkRequiredIndexes({
    loginattemptbuckets: {
      exists: true,
      indexesStatus: "VERIFIED",
      indexes: [
        { name: "_id_", key: { _id: 1 } },
        {
          name: "ttl_expires_at",
          key: { expiresAt: 1 },
          expireAfterSeconds: 0,
        },
      ],
    },
    gpsdevices: {
      exists: true,
      indexesStatus: "VERIFIED",
      indexes: [
        { name: "deviceId_1", key: { deviceId: 1 }, unique: true },
        {
          name: "bus_id_1",
          key: { bus_id: 1 },
          unique: true,
          partialFilterExpression: { is_active: true },
        },
      ],
    },
  });
  assert.deepEqual(result, {
    loginAttemptTtlIndex: "PRESENT",
    gpsDeviceIdentityUniqueIndex: "PRESENT",
    gpsActiveBusAssignmentUniqueIndex: "PRESENT",
  });
  assert.equal(
    checkRequiredIndexes({
      loginattemptbuckets: {
        exists: true,
        indexesStatus: "VERIFIED",
        indexes: [{
          name: "ttl_expires_at",
          key: { expiresAt: 1 },
          expireAfterSeconds: 60,
        }],
      },
      gpsdevices: { exists: false, indexesStatus: "NOT_APPLICABLE", indexes: null },
    }).loginAttemptTtlIndex,
    "MISSING",
  );
});

test("Atlas index permission denial is NOT_VERIFIED with safe code and explanation", () => {
  const inspection = getIndexInspectionFailure({
    code: 8000,
    codeName: "AtlasError",
    message: "private details must not appear in the report",
  });
  assert.equal(inspection.status, "NOT_VERIFIED");
  assert.deepEqual(inspection.error, { code: 8000, codeName: "AtlasError" });
  assert.match(inspection.explanation, /readWrite principal/);
  assert.equal(JSON.stringify(inspection).includes("private details"), false);
});

test("transaction capability requires sessions, supported version, and supported topology", () => {
  assert.equal(
    getTransactionSupport({
      hello: { setName: "atlas-rs", logicalSessionTimeoutMinutes: 30 },
      version: "8.0.1",
    }).supported,
    true,
  );
  assert.equal(
    getTransactionSupport({
      hello: { msg: "isdbgrid", logicalSessionTimeoutMinutes: 30 },
      version: "4.2.0",
    }).supported,
    true,
  );
  assert.equal(
    getTransactionSupport({
      hello: { logicalSessionTimeoutMinutes: 30 },
      version: "8.0.1",
    }).supported,
    false,
  );
});

test("verification reports metadata and closes client without mutation operations", async () => {
  const operations = [];
  const indexes = {
    loginattemptbuckets: [
      { name: "_id_", key: { _id: 1 } },
      {
        name: "ttl_expires_at",
        key: { expiresAt: 1 },
        expireAfterSeconds: 0,
      },
    ],
    gpsdevices: [
      { name: "_id_", key: { _id: 1 } },
      { name: "deviceId_1", key: { deviceId: 1 }, unique: true },
      {
        name: "bus_id_1",
        key: { bus_id: 1 },
        unique: true,
        partialFilterExpression: { is_active: true },
      },
    ],
  };
  const db = {
    databaseName: STAGING_DATABASE_NAME,
    admin: () => ({
      command: async (command) => {
        operations.push(Object.keys(command)[0]);
        if (command.buildInfo) return { version: "8.0.1" };
        return { setName: "staging-rs", logicalSessionTimeoutMinutes: 30 };
      },
    }),
    listCollections: (filter, options) => {
      assert.deepEqual(filter, {});
      assert.deepEqual(options, { authorizedCollections: true, nameOnly: true });
      operations.push("listCollections:authorizedCollections");
      return ({
      toArray: async () => [
        { name: "loginattemptbuckets" },
        { name: "gpsdevices" },
      ],
      });
    },
    collection: (name) => ({
      listIndexes: () => ({
        toArray: async () => {
          operations.push(`listIndexes:${name}`);
          return indexes[name];
        },
      }),
    }),
  };
  let closed = false;
  const report = await verifyStagingReadiness({
    env: stagingEnv,
    createClient: () => ({
      async connect() {
        operations.push("connect");
      },
      db() {
        return db;
      },
      async close() {
        closed = true;
      },
    }),
  });

  assert.equal(report.status, "SUCCEEDED");
  assert.equal(report.readOnly, true);
  assert.equal(report.database, STAGING_DATABASE_NAME);
  assert.equal(report.serverVersion, "8.0.1");
  assert.equal(report.topology, "REPLICA_SET");
  assert.equal(report.transactionsSupported, true);
  assert.equal(report.collections.loginattemptbuckets.exists, true);
  assert.equal(report.requiredIndexes.loginAttemptTtlIndex, "PRESENT");
  assert.equal(report.requiredIndexes.gpsDeviceIdentityUniqueIndex, "PRESENT");
  assert.equal(report.requiredIndexes.gpsActiveBusAssignmentUniqueIndex, "PRESENT");
  assert.equal(report.readiness.status, "READY");
  assert.equal(closed, true);
  assert.deepEqual(operations, [
    "connect",
    "buildInfo",
    "hello",
    "listCollections:authorizedCollections",
    "listIndexes:loginattemptbuckets",
    "listIndexes:gpsdevices",
  ]);
  assert.equal(JSON.stringify(report).includes("password"), false);
});

test("verification attributes failures to stages using only sanitized diagnostics", async (t) => {
  const stages = [
    "connection",
    "buildInfo",
    "hello",
    "listCollections",
    "indexInspection:loginattemptbuckets",
    "clientClose",
  ];

  for (const failedStage of stages) {
    await t.test(failedStage, async () => {
      const privateMessage =
        "private-uri user=secret password=secret cluster=private.example";
      const failure = new Error(privateMessage);
      failure.name = "MongoWaitQueueTimeoutError";
      failure.code = 999999;
      const fail = (stage) => {
        if (failedStage === stage) throw failure;
      };
      const client = {
        async connect() {
          fail("connection");
        },
        db() {
          return {
            admin: () => ({
              async command(command) {
                if (command.buildInfo) {
                  fail("buildInfo");
                  return { version: "8.0.1" };
                }
                fail("hello");
                return {
                  setName: "staging-rs",
                  logicalSessionTimeoutMinutes: 30,
                };
              },
            }),
            listCollections: () => ({
              toArray: async () => {
                fail("listCollections");
                return [
                  { name: "loginattemptbuckets" },
                  { name: "gpsdevices" },
                ];
              },
            }),
            collection(name) {
              return {
                listIndexes: () => ({
                  toArray: async () => {
                    fail(`indexInspection:${name}`);
                    return [];
                  },
                }),
              };
            },
          };
        },
        async close() {
          fail("clientClose");
        },
      };
      const report = await verifyStagingReadiness({
        env: stagingEnv,
        createClient: () => client,
      });
      const diagnostic = report.diagnostics.find(
        (entry) => entry.stage === failedStage,
      );

      assert.ok(diagnostic, `expected diagnostic for ${failedStage}`);
      assert.equal(diagnostic.errorClass, "MongoWaitQueueTimeoutError");
      assert.equal(diagnostic.code, null);
      assert.equal(Number.isInteger(diagnostic.elapsedMs), true);
      assert.equal(diagnostic.elapsedMs >= 0, true);
      assert.equal(JSON.stringify(report).includes(privateMessage), false);
      assert.equal(JSON.stringify(report).includes("secret"), false);
      assert.equal(JSON.stringify(report).includes("private.example"), false);
      if (failedStage.startsWith("indexInspection:")) {
        assert.equal(report.readiness.status, "NOT_READY");
      }
      if (failedStage === "clientClose") {
        assert.equal(report.status, "FAILED");
        assert.deepEqual(report.closeError, {
          name: "MongoWaitQueueTimeoutError",
          code: null,
        });
      }
    });
  }
});

test("missing collections are reported and index listing is not attempted", async () => {
  const operations = [];
  const report = await verifyStagingReadiness({
    env: stagingEnv,
    createClient: () => ({
      async connect() {},
      db: () => ({
        admin: () => ({
          command: async (command) => command.buildInfo
            ? { version: "8.0.1" }
            : { setName: "staging-rs", logicalSessionTimeoutMinutes: 30 },
        }),
        listCollections: (filter, options) => {
          operations.push({ filter, options });
          return { toArray: async () => [] };
        },
        collection: () => {
          operations.push("unexpected-listIndexes");
          throw new Error("listIndexes must not run");
        },
      }),
      async close() {},
    }),
  });

  assert.equal(report.status, "SUCCEEDED");
  assert.equal(report.collections.loginattemptbuckets.exists, false);
  assert.equal(report.collections.gpsdevices.exists, false);
  assert.equal(report.collections.loginattemptbuckets.indexesStatus, "NOT_APPLICABLE");
  assert.equal(report.requiredIndexes.loginAttemptTtlIndex, "MISSING");
  assert.equal(report.requiredIndexes.gpsDeviceIdentityUniqueIndex, "MISSING");
  assert.equal(report.readiness.status, "NOT_READY");
  assert.deepEqual(operations, [{
    filter: {},
    options: { authorizedCollections: true, nameOnly: true },
  }]);
});

test("index inspection denial is reported independently without hiding collection presence", async () => {
  const report = await verifyStagingReadiness({
    env: stagingEnv,
    createClient: () => ({
      async connect() {},
      db: () => ({
        admin: () => ({
          command: async (command) => command.buildInfo
            ? { version: "8.0.1" }
            : { setName: "staging-rs", logicalSessionTimeoutMinutes: 30 },
        }),
        listCollections: () => ({
          toArray: async () => [{ name: "loginattemptbuckets" }],
        }),
        collection: (name) => ({
          listIndexes: () => ({
            toArray: async () => {
              assert.equal(name, "loginattemptbuckets");
              const error = new Error("do not expose this provider error detail");
              error.code = 8000;
              error.codeName = "AtlasError";
              throw error;
            },
          }),
        }),
      }),
      async close() {},
    }),
  });

  assert.equal(report.collections.loginattemptbuckets.exists, true);
  assert.equal(report.collections.loginattemptbuckets.indexesStatus, "NOT_VERIFIED");
  assert.equal(
    report.collections.loginattemptbuckets.indexInspectionError.code,
    8000,
  );
  assert.match(
    report.collections.loginattemptbuckets.indexInspectionExplanation,
    /readWrite principal/,
  );
  assert.equal(report.requiredIndexes.loginAttemptTtlIndex, "NOT_VERIFIED");
  assert.equal(report.collections.gpsdevices.exists, false);
  assert.equal(report.requiredIndexes.gpsDeviceIdentityUniqueIndex, "MISSING");
  assert.equal(report.readiness.status, "NOT_READY");
  assert.equal(
    JSON.stringify(report).includes("do not expose this provider error detail"),
    false,
  );
});
