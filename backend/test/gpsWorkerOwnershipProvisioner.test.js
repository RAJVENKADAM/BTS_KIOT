"use strict";

const assert = require("node:assert/strict");
const { Long } = require("mongodb");
const test = require("node:test");
const {
  assertStagingTarget,
  getSafeErrorDetails,
  initialize,
  isValidOwnershipRecord,
} = require("../scripts/initialize-gps-worker-ownership");

const stagingEnv = {
  NODE_ENV: "test",
  BTMS_DATABASE_ENVIRONMENT: "staging",
  BTMS_STAGING_DB_NAME: "bts_staging_db",
  MONGODB_URI:
    "mongodb+srv://staging-user:staging-password@rajvenkadam.hm6bni0.mongodb.net/bts_staging_db",
};

function ownershipRecord(overrides = {}) {
  return {
    _id: "gps-worker",
    token: Long.fromInt(12),
    ownerId: null,
    state: "inactive",
    leaseExpiresAt: new Date(0),
    writeVersion: Long.ZERO,
    configVersion: Long.ZERO,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function mockProvisioner(
  initialRecord,
  { findOneResults, insertError, afterUpdate } = {},
) {
  const calls = [];
  let record = initialRecord;
  let findOneIndex = 0;
  const collection = {
    async findOne() {
      if (findOneResults) {
        const result = findOneResults[
          Math.min(findOneIndex, findOneResults.length - 1)
        ];
        findOneIndex += 1;
        return result ? { ...result } : null;
      }
      return record ? { ...record } : null;
    },
    async insertOne(document) {
      if (insertError) throw insertError;
      record = document;
      return { acknowledged: true };
    },
    async updateOne(filter, update, options) {
      calls.push({ filter, update, options });
      if (filter.configVersion?.$exists === false) {
        Object.assign(record, update.$set);
        afterUpdate?.(record);
        return { matchedCount: 1 };
      }
      return { matchedCount: 0 };
    },
  };
  class MockClient {
    async connect() {}
    db(name) {
      assert.equal(name, "bts_staging_db");
      return {
        async createCollection() {
          const error = new Error("already exists");
          error.code = 48;
          throw error;
        },
        collection(name) {
          assert.equal(name, "gpsworkerownerships");
          return collection;
        },
      };
    }
    async close() {}
  }
  return { calls, collection, MongoClientClass: MockClient };
}

test("provisioner refuses active GPS ownership without changing it", async () => {
  const record = ownershipRecord({ state: "active", ownerId: "worker-a" });
  const mock = mockProvisioner(record);
  await assert.rejects(
    initialize({
      env: stagingEnv,
      MongoClientClass: mock.MongoClientClass,
      logger: { info() {} },
    }),
    /ownership is active/,
  );
  assert.deepEqual(mock.calls, []);
});

test("provisioner rejects ownership records containing invalid dates", async () => {
  const record = ownershipRecord({ leaseExpiresAt: new Date(Number.NaN) });
  assert.equal(isValidOwnershipRecord(record), false);
  const mock = mockProvisioner(record);
  await assert.rejects(
    initialize({
      env: stagingEnv,
      MongoClientClass: mock.MongoClientClass,
      logger: { info() {} },
    }),
    /invalid or active/,
  );
  assert.deepEqual(mock.calls, []);
});

test("provisioner rejects inactive ownership with a non-null owner", async () => {
  const record = ownershipRecord({ ownerId: "stale-worker" });
  assert.equal(isValidOwnershipRecord(record), false);
  const mock = mockProvisioner(record);
  await assert.rejects(
    initialize({
      env: stagingEnv,
      MongoClientClass: mock.MongoClientClass,
      logger: { info() {} },
    }),
    /invalid or active/,
  );
  assert.deepEqual(mock.calls, []);
});

test("provisioner validates every token and date field", async (t) => {
  const invalidRecords = [
    ownershipRecord({ token: 12 }),
    ownershipRecord({ writeVersion: -1 }),
    ownershipRecord({ configVersion: "0" }),
    ownershipRecord({ updatedAt: new Date(Number.NaN) }),
    ownershipRecord({ leaseExpiresAt: "not-a-date" }),
  ];
  for (const [index, record] of invalidRecords.entries()) {
    await t.test(`invalid ownership field ${index + 1}`, () => {
      assert.equal(isValidOwnershipRecord(record), false);
    });
  }
});

test("duplicate-key race rejects an active concurrent ownership record", async () => {
  const duplicateError = new Error("duplicate key");
  duplicateError.code = 11000;
  const activeRecord = ownershipRecord({
    state: "active",
    ownerId: "worker-b",
  });
  const mock = mockProvisioner(null, {
    findOneResults: [null, activeRecord],
    insertError: duplicateError,
  });

  await assert.rejects(
    initialize({
      env: stagingEnv,
      MongoClientClass: mock.MongoClientClass,
      logger: { info() {} },
    }),
    /ownership is active/,
  );
});

test("duplicate-key race rejects a malformed concurrent ownership record", async () => {
  const duplicateError = new Error("duplicate key");
  duplicateError.code = 11000;
  const malformedRecord = ownershipRecord({
    state: "inactive",
    ownerId: "stale-worker",
  });
  const mock = mockProvisioner(null, {
    findOneResults: [null, malformedRecord],
    insertError: duplicateError,
  });

  await assert.rejects(
    initialize({
      env: stagingEnv,
      MongoClientClass: mock.MongoClientClass,
      logger: { info() {} },
    }),
    /invalid or active/,
  );
});

test("duplicate-key race applies strict validation to token and date fields", async (t) => {
  const malformedRecords = [
    ownershipRecord({ token: 12 }),
    ownershipRecord({ writeVersion: -1 }),
    ownershipRecord({ configVersion: "0" }),
    ownershipRecord({ leaseExpiresAt: new Date(Number.NaN) }),
    ownershipRecord({ updatedAt: new Date(Number.NaN) }),
  ];
  for (const [index, record] of malformedRecords.entries()) {
    await t.test(`malformed concurrent record ${index + 1}`, async () => {
      const duplicateError = new Error("duplicate key");
      duplicateError.code = 11000;
      const mock = mockProvisioner(null, {
        findOneResults: [null, record],
        insertError: duplicateError,
      });
      await assert.rejects(
        initialize({
          env: stagingEnv,
          MongoClientClass: mock.MongoClientClass,
          logger: { info() {} },
        }),
        /invalid or active/,
      );
    });
  }
});

test("legacy ownership upgrade preserves its inactive fencing token", async () => {
  const record = ownershipRecord({ configVersion: undefined });
  const tokenBefore = record.token;
  const mock = mockProvisioner(record);
  const result = await initialize({
    env: stagingEnv,
    MongoClientClass: mock.MongoClientClass,
    logger: { info() {} },
  });

  assert.deepEqual(result, { collectionCreated: false, recordCreated: false });
  assert.equal(record.token.toString(), tokenBefore.toString());
  assert.equal(record.configVersion.toString(), "0");
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(mock.calls[0].options, {
    writeConcern: { w: "majority" },
  });
});

test("legacy upgrade verification rejects ownership activated concurrently", async () => {
  const record = ownershipRecord({ configVersion: undefined });
  const mock = mockProvisioner(record, {
    afterUpdate: (updatedRecord) => {
      updatedRecord.state = "active";
      updatedRecord.ownerId = "worker-a";
    },
  });
  await assert.rejects(
    initialize({
      env: stagingEnv,
      MongoClientClass: mock.MongoClientClass,
      logger: { info() {} },
    }),
    /could not be verified/,
  );
});

test("GPS ownership target rejects production authSource before client construction", async () => {
  const uri = new URL(stagingEnv.MONGODB_URI);
  uri.searchParams.set("authSource", "bts_db");
  const env = { ...stagingEnv, MONGODB_URI: uri.toString() };
  let clientConstructed = false;

  assert.throws(
    () => assertStagingTarget(env),
    /production authentication database/,
  );
  await assert.rejects(
    initialize({
      env,
      MongoClientClass: class {
        constructor() {
          clientConstructed = true;
        }
      },
    }),
    /production authentication database/,
  );
  assert.equal(clientConstructed, false);
});

test("GPS ownership CLI error details omit raw connection strings and preserve codes", () => {
  const error = Object.assign(
    new Error(`failed mongodb+srv://user:password@${new URL(stagingEnv.MONGODB_URI).hostname}`),
    { code: 8000, codeName: "AtlasError" },
  );
  const details = getSafeErrorDetails(error);
  assert.equal(details.code, 8000);
  assert.equal(details.codeName, "AtlasError");
  assert.equal(details.message.includes("mongodb+srv"), false);
  assert.equal(details.message.includes("password"), false);
  assert.equal(details.message.includes(new URL(stagingEnv.MONGODB_URI).hostname), false);
});
