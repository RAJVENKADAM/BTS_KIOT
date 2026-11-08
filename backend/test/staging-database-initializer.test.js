"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { MongoServerError } = require("mongodb");
const GpsDevice = require("../src/models/GpsDevice");
const {
  CONNECTION_OPTIONS,
  GPS_COLLECTION,
  STAGING_DATABASE_NAME,
  STAGING_MONGODB_HOST,
  assertStagingTarget,
  classifyErrorMessage,
  configureStagingDns,
  initializeStagingDatabase,
} = require("../scripts/initialize-staging-database");
const {
  LOGIN_ATTEMPT_COLLECTION,
  LOGIN_ATTEMPT_INDEX_KEYS,
  LOGIN_ATTEMPT_INDEX_OPTIONS,
} = require("../scripts/staging-database-definitions");

const stagingEnv = {
  NODE_ENV: "test",
  BTMS_DATABASE_ENVIRONMENT: "staging",
  BTMS_STAGING_DB_NAME: STAGING_DATABASE_NAME,
  MONGODB_URI:
    `mongodb+srv://staging-user:staging-password@${STAGING_MONGODB_HOST}/${STAGING_DATABASE_NAME}?retryWrites=true`,
};

function createMock({
  initialCollections = [],
  initialIndexes = {},
  duplicateFields = [],
  gpsDocuments = [],
  failCreateIndex,
  failConnection,
  failCreateCollection,
} = {}) {
  const collections = new Set(initialCollections);
  const indexes = new Map(
    Object.entries(initialIndexes).map(([name, indexNames]) => [
      name,
      new Set(indexNames),
    ]),
  );
  const operations = [];
  const client = {
    async connect() {
      operations.push("connect");
      if (failConnection) throw failConnection;
    },
    db(databaseName) {
      assert.equal(databaseName, STAGING_DATABASE_NAME);
      return {
        listCollections(filter, options) {
          assert.deepEqual(filter, {});
          assert.deepEqual(options, {
            authorizedCollections: true,
            nameOnly: true,
          });
          operations.push("listCollections");
          return {
            toArray: async () => [...collections].map((name) => ({ name })),
          };
        },
        async createCollection(name) {
          operations.push(`createCollection:${name}`);
          if (failCreateCollection) throw failCreateCollection;
          if (collections.has(name)) {
            const error = new Error("already exists");
            error.code = 48;
            throw error;
          }
          collections.add(name);
          indexes.set(name, new Set());
        },
        collection(name) {
          if (!indexes.has(name)) indexes.set(name, new Set());
          return {
            aggregate(pipeline) {
              operations.push(`aggregate:${name}`);
              const groupField = pipeline.find((stage) => stage.$group)
                .$group._id.slice(1);
              const partial = pipeline.find(
                (stage) => stage.$match?.is_active === true,
              )?.$match;
              const eligibleDocuments = gpsDocuments.filter(
                (document) =>
                  !partial ||
                  Object.entries(partial).every(
                    ([field, value]) => document[field] === value,
                  ),
              );
              const valueCounts = new Map();
              for (const document of eligibleDocuments) {
                const value = Object.hasOwn(document, groupField)
                  ? document[groupField]
                  : null;
                valueCounts.set(value, (valueCounts.get(value) || 0) + 1);
              }
              const duplicateGroup = [...valueCounts].find(
                ([, count]) => count > 1,
              );
              return {
                toArray: async () =>
                  duplicateGroup ||
                  (duplicateFields.includes(groupField) &&
                  (!partial || partial.is_active === true)
                    ? ["redacted", 2]
                    : null)
                    ? [{ _id: "redacted", count: 2 }]
                    : [],
              };
            },
            async createIndex(keys, options) {
              const call = { name, keys, options };
              operations.push(call);
              if (failCreateIndex) throw failCreateIndex;
              const indexName =
                options.name ||
                Object.entries(keys)
                  .map(([field, direction]) => `${field}_${direction}`)
                  .join("_");
              if (!indexes.get(name).has(indexName)) {
                indexes.get(name).add(indexName);
              }
              return indexName;
            },
          };
        },
      };
    },
    async close() {
      operations.push("close");
    },
  };
  return { client, collections, indexes, operations };
}

async function runWithMock(options = {}, env = stagingEnv) {
  const mock = createMock(options);
  const report = await initializeStagingDatabase({
    env,
    createClient(uri, connectionOptions) {
      assert.equal(uri, env.MONGODB_URI);
      assert.deepEqual(connectionOptions, CONNECTION_OPTIONS);
      return mock.client;
    },
  });
  return { report, ...mock };
}

test("staging guard rejects missing environment and wrong database name", () => {
  assert.throws(
    () => assertStagingTarget({ ...stagingEnv, BTMS_DATABASE_ENVIRONMENT: "" }),
    /BTMS_DATABASE_ENVIRONMENT=staging/,
  );
  assert.throws(
    () => assertStagingTarget({ ...stagingEnv, BTMS_STAGING_DB_NAME: "other_db" }),
    /BTMS_STAGING_DB_NAME/,
  );
  assert.throws(
    () => assertStagingTarget({
      ...stagingEnv,
      MONGODB_URI: stagingEnv.MONGODB_URI.replace(STAGING_DATABASE_NAME, "other_db"),
    }),
    /database path/,
  );
});

test("staging guard rejects production, wrong hostname, and missing credentials", () => {
  assert.throws(
    () => assertStagingTarget({ ...stagingEnv, NODE_ENV: "production" }),
    /NODE_ENV=production/,
  );
  assert.throws(
    () => assertStagingTarget({
      ...stagingEnv,
      MONGODB_URI: stagingEnv.MONGODB_URI.replace(
        STAGING_MONGODB_HOST,
        "other.mongodb.net",
      ),
    }),
    /expected staging Atlas host/,
  );
  assert.throws(
    () => assertStagingTarget({
      ...stagingEnv,
      MONGODB_URI:
        `mongodb+srv://${STAGING_MONGODB_HOST}/${STAGING_DATABASE_NAME}`,
    }),
    /username and password/,
  );
  assert.throws(
    () => assertStagingTarget({
      ...stagingEnv,
      MONGODB_URI:
        `mongodb+srv://staging-user:password@${STAGING_MONGODB_HOST}/bts_db`,
    }),
    /production database/,
  );
});

test("staging initializer rejects production authSource before client construction or writes", async () => {
  const uri = new URL(stagingEnv.MONGODB_URI);
  uri.searchParams.set("authSource", "bts_db");
  const env = { ...stagingEnv, MONGODB_URI: uri.toString() };
  let clientConstructed = false;

  assert.throws(
    () => assertStagingTarget(env),
    /production authentication database/,
  );
  await assert.rejects(
    initializeStagingDatabase({
      env,
      createClient() {
        clientConstructed = true;
        throw new Error("client should not be constructed");
      },
    }),
    /production authentication database/,
  );
  assert.equal(clientConstructed, false);
});

test("guard returns only target identity and rejects before client construction", async () => {
  const target = assertStagingTarget(stagingEnv);
  assert.deepEqual(target, {
    databaseName: STAGING_DATABASE_NAME,
    hostname: STAGING_MONGODB_HOST,
  });
  assert.equal(JSON.stringify(target).includes("staging-password"), false);

  let clientCreated = false;
  await assert.rejects(
    initializeStagingDatabase({
      env: { ...stagingEnv, BTMS_DATABASE_ENVIRONMENT: "production" },
      createClient() {
        clientCreated = true;
        throw new Error("must not construct client");
      },
    }),
    /BTMS_DATABASE_ENVIRONMENT=staging/,
  );
  assert.equal(clientCreated, false);
});

test("staging DNS servers are configured before client construction", async () => {
  const calls = [];
  const mock = createMock();
  const report = await initializeStagingDatabase({
    env: { ...stagingEnv, BTMS_STAGING_DNS_SERVERS: "8.8.8.8, 1.1.1.1" },
    setDnsServers(servers) {
      calls.push(["dns", servers]);
    },
    createClient(uri, options) {
      calls.push(["client", uri, options]);
      return mock.client;
    },
  });
  assert.equal(report.status, "SUCCEEDED");
  assert.deepEqual(calls.map(([type]) => type), ["dns", "client"]);
  assert.deepEqual(calls[0], ["dns", ["8.8.8.8", "1.1.1.1"]]);
  assert.equal(configureStagingDns({ BTMS_STAGING_DNS_SERVERS: "" }, () => {
    assert.fail("DNS servers must not be changed when configuration is absent");
  }), 0);
  assert.throws(
    () => configureStagingDns(
      { BTMS_STAGING_DNS_SERVERS: "not-an-ip" },
      () => assert.fail("invalid DNS must not be applied"),
    ),
    /must contain valid IP addresses/,
  );
});

test("connection failures are staged and safely classified without exposing details", async () => {
  const dnsRefusal = Object.assign(
    new Error(`querySrv ECONNREFUSED secret-value-${stagingEnv.MONGODB_URI}`),
    {
      code: "ECONNREFUSED",
      syscall: "querySrv",
      address: "127.0.0.1",
      port: 53,
    },
  );
  const dnsMock = createMock({ failConnection: dnsRefusal });
  await assert.rejects(
    initializeStagingDatabase({
      env: stagingEnv,
      createClient: () => dnsMock.client,
    }),
    (error) => {
      assert.equal(error.report.status, "FAILED");
      assert.equal(error.report.failure.operation, "connect");
      assert.equal(error.report.failure.error.networkPhase, "DNS_RESOLUTION");
      assert.equal(error.report.failure.error.syscall, "querySrv");
      assert.equal(error.report.failure.error.address, "127.0.0.1");
      assert.equal(error.report.failure.error.port, 53);
      assert.equal(JSON.stringify(error.report).includes(stagingEnv.MONGODB_URI), false);
      assert.equal(JSON.stringify(error.report).includes("secret-value"), false);
      return true;
    },
  );

  const tcpRefusal = Object.assign(new Error("TCP refused"), {
    code: "ECONNREFUSED",
    syscall: "connect",
    address: "192.0.2.10",
    port: 27017,
  });
  const tcpMock = createMock({ failConnection: tcpRefusal });
  await assert.rejects(
    initializeStagingDatabase({
      env: stagingEnv,
      createClient: () => tcpMock.client,
    }),
    (error) => {
      assert.equal(error.report.failure.error.networkPhase, "TCP_CONNECTIVITY");
      assert.equal(error.report.failure.error.address, "192.0.2.10");
      return true;
    },
  );
});

test("new staging database structures use exact model and migration index definitions", async () => {
  const { report, collections, operations } = await runWithMock();
  assert.equal(report.status, "SUCCEEDED");
  assert.deepEqual([...collections].sort(), [
    GPS_COLLECTION,
    LOGIN_ATTEMPT_COLLECTION,
  ].sort());

  const indexCalls = operations.filter((operation) => typeof operation === "object");
  assert.equal(indexCalls.length, 3);
  assert.deepEqual(
    indexCalls.find((call) => call.name === LOGIN_ATTEMPT_COLLECTION),
    {
      name: LOGIN_ATTEMPT_COLLECTION,
      keys: LOGIN_ATTEMPT_INDEX_KEYS,
      options: LOGIN_ATTEMPT_INDEX_OPTIONS,
    },
  );
  const gpsDefinitions = GpsDevice.schema.indexes();
  for (const [keys, options] of gpsDefinitions) {
    assert.ok(
      indexCalls.some(
        (call) =>
          call.name === GPS_COLLECTION &&
          JSON.stringify(call.keys) === JSON.stringify(keys) &&
          JSON.stringify(call.options) === JSON.stringify(options),
      ),
    );
  }
  assert.equal(operations.includes("listIndexes"), false);
});

test("existing collections and indexes are preserved and ensured idempotently", async () => {
  const { report, collections, operations } = await runWithMock({
    initialCollections: [LOGIN_ATTEMPT_COLLECTION, GPS_COLLECTION],
    initialIndexes: {
      [LOGIN_ATTEMPT_COLLECTION]: ["ttl_expires_at"],
      [GPS_COLLECTION]: ["deviceId_1", "bus_id_1"],
    },
  });
  assert.equal(report.status, "SUCCEEDED");
  assert.equal(
    operations.filter((operation) => operation === `createCollection:${LOGIN_ATTEMPT_COLLECTION}`).length,
    0,
  );
  assert.equal(
    operations.filter((operation) => operation === `createCollection:${GPS_COLLECTION}`).length,
    0,
  );
  assert.equal(collections.size, 2);
  assert.equal(operations.filter((operation) => typeof operation === "object").length, 3);
  assert.ok(report.operations.every((operation) => operation.status !== "FAILED"));
});

test("duplicate device IDs block initialization before any collection or index writes", async () => {
  const mock = createMock({
    initialCollections: [GPS_COLLECTION],
    duplicateFields: ["deviceId"],
  });
  await assert.rejects(
    initializeStagingDatabase({
      env: stagingEnv,
      createClient: () => mock.client,
    }),
    (error) => {
      assert.equal(error.report.status, "BLOCKED");
      assert.equal(error.report.failure.error.code, "DUPLICATE_DATA");
      assert.equal(JSON.stringify(error.report).includes("redacted"), false);
      return true;
    },
  );
  assert.equal(mock.operations.some((operation) => typeof operation === "object"), false);
  assert.equal(mock.operations.some((operation) => operation.startsWith("createCollection:")), false);
});

test("duplicate active bus assignments block initialization before index creation", async () => {
  const mock = createMock({
    initialCollections: [GPS_COLLECTION],
    duplicateFields: ["bus_id"],
  });
  await assert.rejects(
    initializeStagingDatabase({
      env: stagingEnv,
      createClient: () => mock.client,
    }),
    (error) => error.report.failure.error.code === "DUPLICATE_DATA",
  );
  assert.equal(mock.operations.some((operation) => typeof operation === "object"), false);
  assert.equal(mock.operations.some((operation) => operation.startsWith("createCollection:")), false);
});

test("duplicate detection includes null and missing keys but excludes inactive bus assignments", async () => {
  for (const documents of [
    [{}, { deviceId: null }],
    [{ is_active: true }, { is_active: true, bus_id: null }],
  ]) {
    const mock = createMock({
      initialCollections: [GPS_COLLECTION],
      gpsDocuments: documents,
    });
    await assert.rejects(
      initializeStagingDatabase({
        env: stagingEnv,
        createClient: () => mock.client,
      }),
      (error) => error.report.failure.error.code === "DUPLICATE_DATA",
    );
    assert.equal(mock.operations.some((operation) => typeof operation === "object"), false);
  }

  const inactiveAssignments = await runWithMock({
    initialCollections: [GPS_COLLECTION],
    gpsDocuments: [
      { deviceId: "inactive-a", is_active: false, bus_id: "same-bus" },
      { deviceId: "inactive-b", is_active: false, bus_id: "same-bus" },
    ],
  });
  assert.equal(inactiveAssignments.report.status, "SUCCEEDED");
  assert.deepEqual(
    inactiveAssignments.report.duplicateChecks.map((check) => check.status),
    ["CLEAR", "CLEAR"],
  );
});

test("Atlas permission denial is surfaced with safe code and partial report", async () => {
  const denied = new Error("provider details and connection data must not leak");
  denied.code = 8000;
  denied.codeName = "AtlasError";
  const mock = createMock({ failCreateIndex: denied });
  await assert.rejects(
    initializeStagingDatabase({
      env: stagingEnv,
      createClient: () => mock.client,
    }),
    (error) => {
      assert.equal(error.report.status, "FAILED");
      assert.equal(error.report.failure.error.code, 8000);
      assert.equal(error.report.failure.error.codeName, "AtlasError");
      assert.equal(
        error.report.failure.error.serverRejectionReason,
        "ATLAS_RESTRICTION",
      );
      assert.equal(JSON.stringify(error.report).includes("provider details"), false);
      return true;
    },
  );
});

test("MongoDB driver AtlasError is not assumed to be an authorization failure", async () => {
  const denied = new MongoServerError({
    ok: 0,
    code: 8000,
    codeName: "AtlasError",
    errmsg: `not allowed to perform action [createCollection] on [${STAGING_DATABASE_NAME}.${LOGIN_ATTEMPT_COLLECTION}]; uri=private`,
    errInfo: { reason: "policy restriction", privateValue: "must not appear" },
    operationTime: "metadata-must-not-appear",
  });
  const mock = createMock({ failCreateCollection: denied });
  await assert.rejects(
    initializeStagingDatabase({
      env: stagingEnv,
      createClient: () => mock.client,
    }),
    (error) => {
      const details = error.report.failure.error;
      assert.equal(details.code, 8000);
      assert.equal(details.codeName, "AtlasError");
      assert.equal(details.action, "createCollection");
      assert.equal(
        details.namespace,
        `${STAGING_DATABASE_NAME}.${LOGIN_ATTEMPT_COLLECTION}`,
      );
      assert.equal(details.authorizationReason, null);
      assert.equal(details.serverRejectionReason, "ATLAS_RESTRICTION");
      assert.equal(details.messageClassification, "ACTION_RESTRICTION");
      assert.equal(JSON.stringify(error.report).includes("uri=private"), false);
      assert.equal(JSON.stringify(error.report).includes("privateValue"), false);
      assert.equal(JSON.stringify(error.report).includes("metadata-must-not-appear"), false);
      return true;
    },
  );
});

test("error-message patterns map only to bounded diagnostic categories", () => {
  const cases = [
    [
      "not allowed to perform action [createCollection] on [db.collection]",
      "ACTION_RESTRICTION",
    ],
    ["collection db.items already exists", "NAMESPACE_CONFLICT"],
    ["invalid namespace supplied", "INVALID_NAMESPACE"],
    ["command is not supported on this deployment", "UNSUPPORTED_OPERATION"],
    ["resource limit exceeded for this operation", "RESOURCE_LIMIT"],
    ["featureCompatibilityVersion is not supported", "FEATURE_COMPATIBILITY"],
    ["opaque private server details", null],
  ];
  for (const [message, classification] of cases) {
    assert.equal(classifyErrorMessage([message]), classification);
  }
  assert.equal(
    classifyErrorMessage([
      "private secret ".repeat(1_000) +
        " not allowed to perform action [createCollection]",
    ]),
    null,
  );
});

test("Atlas action diagnostics retain safe operation context without raw errmsg", async () => {
  const privateDetails =
    "not allowed to perform action [createCollection] on " +
    `[${STAGING_DATABASE_NAME}.${LOGIN_ATTEMPT_COLLECTION}]; ` +
    "uri=mongodb+srv://user:password@private.example";
  const atlasError = new MongoServerError({
    ok: 0,
    code: 8000,
    codeName: "AtlasError",
    errmsg: privateDetails,
  });
  const mock = createMock({ failCreateCollection: atlasError });

  await assert.rejects(
    initializeStagingDatabase({
      env: stagingEnv,
      createClient: () => mock.client,
    }),
    (error) => {
      const report = error.report;
      const details = report.failure.error;
      assert.equal(
        report.failure.operation,
        `createCollection:${LOGIN_ATTEMPT_COLLECTION}`,
      );
      assert.equal(details.code, 8000);
      assert.equal(details.codeName, "AtlasError");
      assert.equal(details.action, "createCollection");
      assert.equal(
        details.namespace,
        `${STAGING_DATABASE_NAME}.${LOGIN_ATTEMPT_COLLECTION}`,
      );
      assert.equal(details.authorizationReason, null);
      assert.equal(details.serverRejectionReason, "ATLAS_RESTRICTION");
      assert.equal(details.messageClassification, "ACTION_RESTRICTION");
      assert.equal(JSON.stringify(report).includes(privateDetails), false);
      assert.equal(JSON.stringify(report).includes("mongodb+srv"), false);
      assert.equal(JSON.stringify(report).includes("password"), false);
      return true;
    },
  );
});

test("standard MongoDB Unauthorized error is recognized through a wrapped cause", async () => {
  const serverError = new MongoServerError({
    ok: 0,
    code: 13,
    codeName: "Unauthorized",
    errmsg: `not authorized on ${STAGING_DATABASE_NAME} to execute command { create: "${LOGIN_ATTEMPT_COLLECTION}" }`,
  });
  const wrapper = new Error("operation failed", { cause: serverError });
  const mock = createMock({ failCreateCollection: wrapper });
  await assert.rejects(
    initializeStagingDatabase({
      env: stagingEnv,
      createClient: () => mock.client,
    }),
    (error) => {
      assert.equal(error.report.failure.error.code, 13);
      assert.equal(error.report.failure.error.codeName, "Unauthorized");
      assert.equal(
        error.report.failure.error.authorizationReason,
        "NOT_AUTHORIZED",
      );
      assert.equal(
        error.report.failure.error.serverRejectionReason,
        "NOT_AUTHORIZED",
      );
      assert.equal(
        error.report.failure.error.namespace,
        `${STAGING_DATABASE_NAME}.${LOGIN_ATTEMPT_COLLECTION}`,
      );
      assert.equal(JSON.stringify(error.report).includes(serverError.message), false);
      return true;
    },
  );
});

test("Atlas collection restrictions expose only action, namespace, and category", async () => {
  const denied = new Error(
    `not allowed to perform action [createCollection] on [${STAGING_DATABASE_NAME}.${LOGIN_ATTEMPT_COLLECTION}]; credential=private`,
  );
  denied.code = 8000;
  denied.codeName = "AtlasError";
  const mock = createMock({ failCreateCollection: denied });
  await assert.rejects(
    initializeStagingDatabase({
      env: stagingEnv,
      createClient: () => mock.client,
    }),
    (error) => {
      const details = error.report.failure.error;
      assert.equal(error.report.failure.operation, `createCollection:${LOGIN_ATTEMPT_COLLECTION}`);
      assert.equal(details.code, 8000);
      assert.equal(details.codeName, "AtlasError");
      assert.equal(details.action, "createCollection");
      assert.equal(
        details.namespace,
        `${STAGING_DATABASE_NAME}.${LOGIN_ATTEMPT_COLLECTION}`,
      );
      assert.equal(details.authorizationReason, null);
      assert.equal(details.serverRejectionReason, "ATLAS_RESTRICTION");
      assert.equal(JSON.stringify(error.report).includes("credential=private"), false);
      assert.equal(JSON.stringify(error.report).includes(denied.message), false);
      return true;
    },
  );
});

test("MongoDB unauthorized command error exposes safe create action and namespace", async () => {
  const denied = new Error(
    `not authorized on ${STAGING_DATABASE_NAME} to execute command { create: "${LOGIN_ATTEMPT_COLLECTION}", $db: "${STAGING_DATABASE_NAME}" }; user=private`,
  );
  denied.code = 8000;
  denied.codeName = "AtlasError";
  const mock = createMock({ failCreateCollection: denied });
  await assert.rejects(
    initializeStagingDatabase({
      env: stagingEnv,
      createClient: () => mock.client,
    }),
    (error) => {
      const details = error.report.failure.error;
      assert.equal(details.action, "createCollection");
      assert.equal(
        details.namespace,
        `${STAGING_DATABASE_NAME}.${LOGIN_ATTEMPT_COLLECTION}`,
      );
      assert.equal(details.authorizationReason, "NOT_AUTHORIZED");
      assert.equal(JSON.stringify(error.report).includes("user=private"), false);
      assert.equal(JSON.stringify(error.report).includes(denied.message), false);
      return true;
    },
  );
});

test("repeated initialization succeeds without duplicating collections or indexes", async () => {
  const mock = createMock();
  const initialize = () =>
    initializeStagingDatabase({
      env: stagingEnv,
      createClient: () => mock.client,
    });
  const first = await initialize();
  const second = await initialize();
  assert.equal(first.status, "SUCCEEDED");
  assert.equal(second.status, "SUCCEEDED");
  assert.equal(mock.collections.size, 2);
  assert.equal(mock.indexes.get(LOGIN_ATTEMPT_COLLECTION).size, 1);
  assert.equal(mock.indexes.get(GPS_COLLECTION).size, 2);
  assert.equal(
    mock.operations.filter((operation) => operation === `createCollection:${GPS_COLLECTION}`).length,
    1,
  );
});
