"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  LOGIN_ATTEMPT_INDEX_KEYS,
  LOGIN_ATTEMPT_INDEX_NAME,
  LOGIN_ATTEMPT_INDEX_OPTIONS,
} = require("../scripts/staging-database-definitions");
const {
  COLLECTION_NAME,
  STAGING_DATABASE_NAME,
  STAGING_MONGODB_HOST,
  assertMigrationTarget,
  getConfirmationValue,
  getSafeErrorDetails,
  isExpectedTtlIndex,
  main,
  parseArguments,
  runMigration,
} = require("../scripts/migrate-login-attempts");

const stagingUri = new URL(
  `mongodb+srv://test-user:test-password@${STAGING_MONGODB_HOST}/${STAGING_DATABASE_NAME}?retryWrites=true`,
);
const stagingEnv = {
  NODE_ENV: "test",
  BTMS_DATABASE_ENVIRONMENT: "staging",
  BTMS_STAGING_DB_NAME: STAGING_DATABASE_NAME,
  BTMS_STAGING_MONGODB_HOST: STAGING_MONGODB_HOST,
  MONGODB_URI: stagingUri.toString(),
};

function validConfirmation(direction) {
  return getConfirmationValue(direction);
}

function validTarget(overrides = {}) {
  return {
    env: { ...stagingEnv, ...overrides },
    direction: "up",
    confirmation: validConfirmation("up"),
  };
}

function expectedIndex(overrides = {}) {
  return {
    v: 2,
    key: { ...LOGIN_ATTEMPT_INDEX_KEYS },
    ns: `${STAGING_DATABASE_NAME}.${COLLECTION_NAME}`,
    ...LOGIN_ATTEMPT_INDEX_OPTIONS,
    ...overrides,
  };
}

function createMockDatabase({ collectionExists = true, indexes = [], documents = [] } = {}) {
  const operations = [];
  let present = collectionExists;
  const currentIndexes = [...indexes];
  const preservedDocuments = [...documents];
  const collection = {
    listIndexes() {
      operations.push("listIndexes");
      return { toArray: async () => [...currentIndexes] };
    },
    async createIndex(keys, options) {
      operations.push("createIndex");
      currentIndexes.push({ key: keys, ...options });
      return options.name;
    },
    async dropIndex(name) {
      operations.push(`dropIndex:${name}`);
      const index = currentIndexes.findIndex((entry) => entry.name === name);
      if (index >= 0) currentIndexes.splice(index, 1);
    },
  };
  const db = {
    listCollections(filter, options) {
      operations.push("listCollections");
      assert.deepEqual(filter, { name: COLLECTION_NAME });
      assert.deepEqual(options, { nameOnly: true });
      return {
        toArray: async () =>
          present ? [{ name: COLLECTION_NAME }] : [],
      };
    },
    async createCollection(name) {
      operations.push(`createCollection:${name}`);
      present = true;
    },
    collection(name) {
      assert.equal(name, COLLECTION_NAME);
      return collection;
    },
  };
  return { db, operations, documents: preservedDocuments, indexes: currentIndexes };
}

test("target validation requires explicit staging identity, exact target, and confirmation", () => {
  const invalidCases = [
    [{ BTMS_DATABASE_ENVIRONMENT: "" }, /BTMS_DATABASE_ENVIRONMENT=staging/],
    [{ BTMS_STAGING_DB_NAME: "" }, /BTMS_STAGING_DB_NAME/],
    [{ BTMS_STAGING_DB_NAME: "other_db" }, /BTMS_STAGING_DB_NAME/],
    [{ BTMS_STAGING_MONGODB_HOST: "prod.example.mongodb.net" }, /BTMS_STAGING_MONGODB_HOST/],
    [{ NODE_ENV: "production" }, /NODE_ENV=production/],
    [{ MONGODB_URI: "" }, /MONGODB_URI is required/],
  ];
  for (const [overrides, message] of invalidCases) {
    assert.throws(
      () => assertMigrationTarget(validTarget(overrides)),
      message,
    );
  }

  const productionDatabaseUri = new URL(stagingEnv.MONGODB_URI);
  productionDatabaseUri.pathname = "/bts_db";
  assert.throws(
    () =>
      assertMigrationTarget(
        validTarget({ MONGODB_URI: productionDatabaseUri.toString() }),
      ),
    /production database/,
  );

  const missingDatabaseUri = new URL(stagingEnv.MONGODB_URI);
  missingDatabaseUri.pathname = "";
  assert.throws(
    () =>
      assertMigrationTarget(
        validTarget({ MONGODB_URI: missingDatabaseUri.toString() }),
      ),
    /database path/,
  );
  const wrongDatabaseUri = new URL(stagingEnv.MONGODB_URI);
  wrongDatabaseUri.pathname = "/other_db";
  assert.throws(
    () =>
      assertMigrationTarget(
        validTarget({ MONGODB_URI: wrongDatabaseUri.toString() }),
      ),
    /expected staging database/,
  );

  const wrongHostUri = new URL(stagingEnv.MONGODB_URI);
  wrongHostUri.hostname = "other.mongodb.net";
  assert.throws(
    () =>
      assertMigrationTarget(
        validTarget({ MONGODB_URI: wrongHostUri.toString() }),
      ),
    /expected staging Atlas host/,
  );

  const productionAuthSourceUri = new URL(stagingEnv.MONGODB_URI);
  productionAuthSourceUri.searchParams.set("authSource", "bts_db");
  assert.throws(
    () =>
      assertMigrationTarget(
        validTarget({ MONGODB_URI: productionAuthSourceUri.toString() }),
      ),
    /production authentication database/,
  );
});

test("migration direction and explicit operation confirmation are mandatory", () => {
  assert.throws(() => parseArguments([]), /Usage:/);
  assert.throws(() => parseArguments(["remove"]), /Usage:/);
  assert.throws(() => parseArguments(["up"]), /confirmation required/);
  assert.throws(
    () =>
      assertMigrationTarget({
        ...validTarget(),
        confirmation: validConfirmation("down"),
      }),
    /Confirmation must exactly match/,
  );
  assert.throws(
    () =>
      assertMigrationTarget({
        ...validTarget(),
        direction: undefined,
      }),
    /direction must be explicitly set/,
  );
});

test("invalid migration configuration is rejected before client construction or writes", async () => {
  let clientConstructed = false;
  await assert.rejects(
    main({
      argv: ["up", validConfirmation("up")],
      env: { ...stagingEnv, BTMS_DATABASE_ENVIRONMENT: "" },
      MongoClientClass: class {
        constructor() {
          clientConstructed = true;
        }
      },
    }),
    /BTMS_DATABASE_ENVIRONMENT=staging/,
  );
  assert.equal(clientConstructed, false);
});

test("main performs validated up migration with an injected client only", async () => {
  const mock = createMockDatabase();
  const operations = [];
  class MockClient {
    constructor(uri) {
      assert.equal(uri, stagingEnv.MONGODB_URI);
      operations.push("construct");
    }

    async connect() {
      operations.push("connect");
    }

    db(name) {
      assert.equal(name, STAGING_DATABASE_NAME);
      return mock.db;
    }

    async close() {
      operations.push("close");
    }
  }

  await main({
    argv: ["up", validConfirmation("up")],
    env: stagingEnv,
    MongoClientClass: MockClient,
    logger: { info() {} },
  });
  assert.equal(operations[0], "construct");
  assert.ok(mock.operations.includes("createIndex"));
  assert.equal(operations.at(-1), "close");
});

test("up ensures the expected TTL index without changing existing login records", async () => {
  const priorDocuments = [{ _id: "existing-account", failures: 4 }];
  const mock = createMockDatabase({
    collectionExists: false,
    documents: priorDocuments,
  });
  const logs = [];
  await runMigration(mock.db, "up", { info: (message) => logs.push(message) });
  assert.deepEqual(mock.documents, priorDocuments);
  assert.ok(mock.operations.includes(`createCollection:${COLLECTION_NAME}`));
  assert.ok(mock.operations.includes("createIndex"));
  assert.equal(
    mock.indexes.some((index) => isExpectedTtlIndex(index)),
    true,
  );
  assert.equal(logs.length, 1);
});

test("up is idempotent when the expected index already exists", async () => {
  const mock = createMockDatabase({
    indexes: [expectedIndex()],
    documents: [{ _id: "retained" }],
  });
  await runMigration(mock.db, "up", { info() {} });
  assert.equal(mock.operations.includes("createIndex"), false);
  assert.deepEqual(mock.documents, [{ _id: "retained" }]);
});

test("down drops only the exact expected TTL index and preserves documents", async () => {
  const mock = createMockDatabase({
    indexes: [expectedIndex()],
    documents: [{ _id: "retained", failures: 2 }],
  });
  await runMigration(mock.db, "down", { info() {} });
  assert.ok(mock.operations.includes(`dropIndex:${LOGIN_ATTEMPT_INDEX_NAME}`));
  assert.deepEqual(mock.documents, [{ _id: "retained", failures: 2 }]);
});

test("down refuses a same-name index with a different key or options", async (t) => {
  const mismatches = [
    { key: { expiresAt: 1, accountId: 1 } },
    { expireAfterSeconds: 60 },
    { unique: true },
  ];
  for (const [index, mismatch] of mismatches.entries()) {
    await t.test(`mismatch ${index + 1}`, async () => {
      const mock = createMockDatabase({
        indexes: [expectedIndex(mismatch)],
      });
      await assert.rejects(
        runMigration(mock.db, "down", { info() {} }),
        /Refusing to drop/,
      );
      assert.equal(
        mock.operations.some((operation) => operation.startsWith("dropIndex:")),
        false,
      );
    });
  }
});

test("unsafe migration errors are redacted while codes remain available", () => {
  const error = Object.assign(
    new Error(`failed mongodb+srv://user:password@${STAGING_MONGODB_HOST}/bts_staging_db`),
    { code: 8000, codeName: "AtlasError" },
  );
  const details = getSafeErrorDetails(error);
  assert.equal(details.code, 8000);
  assert.equal(details.codeName, "AtlasError");
  assert.equal(details.message.includes("mongodb+srv"), false);
  assert.equal(details.message.includes("password"), false);
  assert.equal(details.message.includes(STAGING_MONGODB_HOST), false);
});
