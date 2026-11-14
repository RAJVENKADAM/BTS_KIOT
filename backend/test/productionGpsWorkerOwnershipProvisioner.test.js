"use strict";

const assert = require("node:assert/strict");
const { Long } = require("mongodb");
const test = require("node:test");
const {
  COLLECTION_NAME,
  CONFIRMATION_ENV,
  DATABASE_NAME,
  assertProductionTarget,
  initializeProductionGpsWorkerOwnership,
} = require("../scripts/initialize-production-gps-worker-ownership");

const productionHosts = [
  "prod-00-00.example.mongodb.net:27017",
  "prod-00-01.example.mongodb.net:27017",
  "prod-00-02.example.mongodb.net:27017",
];

function productionEnv(overrides = {}) {
  const sortedHosts = [...productionHosts].sort();

  return {
    NODE_ENV: "production",
    BTMS_PRODUCTION_DB_NAME: DATABASE_NAME,
    BTMS_PRODUCTION_MONGODB_HOSTS: productionHosts.join(","),
    BTMS_PRODUCTION_AUTH_DB: "admin",
    [CONFIRMATION_ENV]: `initialize:${DATABASE_NAME}@${sortedHosts.join(",")}`,
    MONGODB_URI: `mongodb://operator:password@${productionHosts.join(",")}/${DATABASE_NAME}?authSource=admin`,
    ...overrides,
  };
}

function ownershipRecord(overrides = {}) {
  return {
    _id: "gps-worker",
    token: Long.ZERO,
    ownerId: null,
    state: "inactive",
    leaseExpiresAt: new Date(0),
    writeVersion: Long.ZERO,
    configVersion: Long.ZERO,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function createProvisioner({
  collectionExists = true,
  record = null,
  insertError = null,
  concurrentRecord = null,
  failReadBack = false,
  readBackRecord = undefined,
  createCollectionError = null,
} = {}) {
  const calls = [];
  let exists = collectionExists;
  let currentRecord = record;
  let findCount = 0;
  const collection = {
    async findOne(filter) {
      calls.push(["findOne", filter]);
      findCount += 1;
      if (failReadBack && findCount > 1) return null;
      if (readBackRecord !== undefined && findCount > 1) return readBackRecord;
      return currentRecord;
    },
    async insertOne(document, options) {
      calls.push(["insertOne", document, options]);
      if (insertError) {
        if (insertError.code === 11000) currentRecord = concurrentRecord;
        throw insertError;
      }
      currentRecord = document;
      return { acknowledged: true };
    },
  };
  class MockClient {
    constructor(uri) {
      calls.push(["construct", uri]);
    }
    async connect() {
      calls.push(["connect"]);
    }
    db(name) {
      assert.equal(name, DATABASE_NAME);
      return {
        listCollections(filter, options) {
          assert.deepEqual(filter, { name: COLLECTION_NAME });
          assert.deepEqual(options, { nameOnly: true });
          return {
            async toArray() {
              return exists ? [{ name: COLLECTION_NAME }] : [];
            },
          };
        },
        async createCollection(name) {
          assert.equal(name, COLLECTION_NAME);
          calls.push(["createCollection", name]);
          if (createCollectionError) throw createCollectionError;
          exists = true;
        },
        collection(name) {
          assert.equal(name, COLLECTION_NAME);
          return collection;
        },
      };
    }
    async close() {
      calls.push(["close"]);
    }
  }
  return { calls, MockClient, collection };
}

const quietLogger = { info() {} };

test("creates missing collection and inserts exact inactive state with majority write concern", async () => {
  const fixture = createProvisioner({ collectionExists: false });
  const env = productionEnv();
  const result = await initializeProductionGpsWorkerOwnership({
    env,
    MongoClientClass: fixture.MockClient,
    logger: quietLogger,
  });
  const insert = fixture.calls.find(([operation]) => operation === "insertOne");
  const client = fixture.calls.find(([operation]) => operation === "construct");

  assert.equal(client[1], env.MONGODB_URI);
  assert.deepEqual(result, {
    collectionCreated: true,
    recordCreated: true,
    alreadyProvisioned: false,
  });
  assert.deepEqual(insert[1], {
    _id: "gps-worker",
    token: Long.ZERO,
    ownerId: null,
    state: "inactive",
    leaseExpiresAt: new Date(0),
    writeVersion: Long.ZERO,
    configVersion: Long.ZERO,
    updatedAt: insert[1].updatedAt,
  });
  assert.ok(insert[1].updatedAt instanceof Date);
  assert.deepEqual(insert[2], { writeConcern: { w: "majority" } });
  assert.ok(fixture.calls.some(([operation]) => operation === "findOne"));
});

test("uses the application URI builder to select the production database", async () => {
  const env = productionEnv({
    DB_NAME: "bts_staging_db",
    MONGODB_URI: productionEnv().MONGODB_URI.replace(
      `/${DATABASE_NAME}?`,
      "/?",
    ),
  });
  const fixture = createProvisioner();

  await initializeProductionGpsWorkerOwnership({
    env,
    MongoClientClass: fixture.MockClient,
    logger: quietLogger,
  });

  const client = fixture.calls.find(([operation]) => operation === "construct");
  assert.equal(
    client[1],
    env.MONGODB_URI.replace("/?", `/${DATABASE_NAME}?`),
  );
});

test("initializes an existing empty ownership collection", async () => {
  const fixture = createProvisioner();
  const result = await initializeProductionGpsWorkerOwnership({
    env: productionEnv(),
    MongoClientClass: fixture.MockClient,
    logger: quietLogger,
  });
  assert.equal(result.collectionCreated, false);
  assert.equal(result.recordCreated, true);
});

test("valid inactive ownership is a no-op", async () => {
  const fixture = createProvisioner({ record: ownershipRecord() });
  const result = await initializeProductionGpsWorkerOwnership({
    env: productionEnv(),
    MongoClientClass: fixture.MockClient,
    logger: quietLogger,
  });
  assert.equal(result.alreadyProvisioned, true);
  assert.equal(
    fixture.calls.some(([operation]) => operation === "insertOne"),
    false,
  );
});

test("active ownership is refused without modification", async () => {
  const fixture = createProvisioner({
    record: ownershipRecord({ state: "active", ownerId: "worker-a" }),
  });
  await assert.rejects(
    initializeProductionGpsWorkerOwnership({
      env: productionEnv(),
      MongoClientClass: fixture.MockClient,
      logger: quietLogger,
    }),
    /active or missing/,
  );
  assert.equal(
    fixture.calls.some(([operation]) => operation === "insertOne"),
    false,
  );
});

test("malformed ownership is refused without modification", async () => {
  const fixture = createProvisioner({
    record: ownershipRecord({ token: 0 }),
  });
  await assert.rejects(
    initializeProductionGpsWorkerOwnership({
      env: productionEnv(),
      MongoClientClass: fixture.MockClient,
      logger: quietLogger,
    }),
    /malformed or inconsistent/,
  );
  assert.equal(
    fixture.calls.some(([operation]) => operation === "insertOne"),
    false,
  );
});

for (const [name, mutate, message] of [
  [
    "wrong database",
    (env) => {
      env.MONGODB_URI = env.MONGODB_URI.replace("/bts_db?", "/bts_staging_db?");
    },
    /must select bts_db exactly/,
  ],
  [
    "wrong hostname",
    (env) => {
      env.MONGODB_URI = env.MONGODB_URI.replace(
        productionHosts[0],
        "other.example.mongodb.net:27017",
      );
    },
    /seed-list hosts do not match/,
  ],
  [
    "known staging hostname",
    (env) => {
      const stagingHost = "rajvenkadam.hm6bni0.mongodb.net:27017";

      const hosts = [stagingHost, productionHosts[1], productionHosts[2]];

      env.BTMS_PRODUCTION_MONGODB_HOSTS = hosts.join(",");
      env.MONGODB_URI = env.MONGODB_URI.replace(
        productionHosts[0],
        stagingHost,
      );

      env[CONFIRMATION_ENV] =
        `initialize:${DATABASE_NAME}@${[...hosts].sort().join(",")}`;
    },
    /known staging MongoDB hostname/,
  ],
  [
    "missing confirmation",
    (env) => {
      delete env[CONFIRMATION_ENV];
    },
    /must explicitly confirm/,
  ],
  [
    "invalid URI protocol",
    (env) => {
      env.MONGODB_URI = env.MONGODB_URI.replace(
        /^[a-z][a-z0-9+.-]*:/i,
        "postgresql:",
      );
    },
    /MONGODB_URI is invalid/,
  ],
  [
    "conflicting authentication database",
    (env) => {
      env.MONGODB_URI = env.MONGODB_URI.replace(
        "authSource=admin",
        "authSource=bts_staging_db",
      );
    },
    /exactly one canonical authSource matching/,
  ],
  [
    "noncanonical authentication option",
    (env) => {
      env.MONGODB_URI = env.MONGODB_URI.replace(
        "authSource=admin",
        "authsource=admin",
      );
    },
    /exactly one canonical authSource matching/,
  ],
]) {
  test(`${name} is rejected before MongoClient construction`, async () => {
    const env = productionEnv();
    mutate(env);
    let constructed = false;
    assert.throws(() => assertProductionTarget(env), message);
    await assert.rejects(
      initializeProductionGpsWorkerOwnership({
        env,
        MongoClientClass: class {
          constructor() {
            constructed = true;
          }
        },
      }),
      message,
    );
    assert.equal(constructed, false);
  });
}

test("duplicate-key race accepts a valid inactive winner without replacing it", async () => {
  const winner = ownershipRecord({ token: Long.fromInt(4) });
  const duplicateKey = Object.assign(new Error("duplicate key"), {
    code: 11000,
  });
  const fixture = createProvisioner({
    insertError: duplicateKey,
    concurrentRecord: winner,
  });
  const result = await initializeProductionGpsWorkerOwnership({
    env: productionEnv(),
    MongoClientClass: fixture.MockClient,
    logger: quietLogger,
  });
  assert.equal(result.alreadyProvisioned, true);
  assert.equal(result.recordCreated, false);
  assert.equal(winner.token.toString(), "4");
});

test("duplicate-key race refuses an active winner", async () => {
  const duplicateKey = Object.assign(new Error("duplicate key"), {
    code: 11000,
  });
  const fixture = createProvisioner({
    insertError: duplicateKey,
    concurrentRecord: ownershipRecord({
      state: "active",
      ownerId: "worker-a",
    }),
  });
  await assert.rejects(
    initializeProductionGpsWorkerOwnership({
      env: productionEnv(),
      MongoClientClass: fixture.MockClient,
      logger: quietLogger,
    }),
    /active or missing/,
  );
});

test("non-duplicate insert failure is surfaced without retrying or replacing state", async () => {
  const fixture = createProvisioner({
    insertError: Object.assign(new Error("insert failed"), { code: 8000 }),
  });
  await assert.rejects(
    initializeProductionGpsWorkerOwnership({
      env: productionEnv(),
      MongoClientClass: fixture.MockClient,
      logger: quietLogger,
    }),
    /insert failed/,
  );
  assert.equal(
    fixture.calls.filter(([operation]) => operation === "insertOne").length,
    1,
  );
});

test("failed read-back verification fails instead of reporting success", async () => {
  const fixture = createProvisioner({ failReadBack: true });
  await assert.rejects(
    initializeProductionGpsWorkerOwnership({
      env: productionEnv(),
      MongoClientClass: fixture.MockClient,
      logger: quietLogger,
    }),
    /read-back did not match/,
  );
});

test("read-back verification rejects a valid but non-initial inactive record", async () => {
  const fixture = createProvisioner({
    readBackRecord: ownershipRecord({ token: Long.ONE }),
  });
  await assert.rejects(
    initializeProductionGpsWorkerOwnership({
      env: productionEnv(),
      MongoClientClass: fixture.MockClient,
      logger: quietLogger,
    }),
    /exact inactive initial state/,
  );
});

test("successful provisioning can be rerun without changing the existing record", async () => {
  const fixture = createProvisioner();
  const options = {
    env: productionEnv(),
    MongoClientClass: fixture.MockClient,
    logger: quietLogger,
  };
  assert.equal(
    (await initializeProductionGpsWorkerOwnership(options)).recordCreated,
    true,
  );
  const inserted = fixture.calls.find(
    ([operation]) => operation === "insertOne",
  )[1];
  const secondResult = await initializeProductionGpsWorkerOwnership(options);
  assert.equal(secondResult.alreadyProvisioned, true);
  assert.equal(
    fixture.calls.filter(([operation]) => operation === "insertOne").length,
    1,
  );
  assert.equal(inserted.token, Long.ZERO);
});
