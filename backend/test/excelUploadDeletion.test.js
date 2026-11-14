"use strict";

const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const AdministrativeChangeAudit = require("../src/models/AdministrativeChangeAudit");
const AssignmentPropagationOutbox = require("../src/models/AssignmentPropagationOutbox");
const ExcelUpload = require("../src/models/ExcelUpload");
const User = require("../src/models/User");
const {
  deleteExcelUpload,
} = require("../src/controllers/excelManagement.controller");
const { mockGpsOwnershipTransactions } = require("./helpers/gpsOwnershipTransactionMock.cjs");
const { mockMutationIdempotency } = require("./helpers/mutationIdempotencyMock.cjs");

const transactions = mockGpsOwnershipTransactions();
const idempotency = mockMutationIdempotency();
const originals = {
  findById: ExcelUpload.findById,
  findOneAndUpdate: ExcelUpload.findOneAndUpdate,
  userFind: User.find,
  userBulkWrite: User.bulkWrite,
  auditCreate: AdministrativeChangeAudit.create,
  outboxUpdateOne: AssignmentPropagationOutbox.updateOne,
};

after(() => {
  transactions.restore();
  idempotency.restore();
  Object.assign(ExcelUpload, {
    findById: originals.findById,
    findOneAndUpdate: originals.findOneAndUpdate,
  });
  User.find = originals.userFind;
  User.bulkWrite = originals.userBulkWrite;
  AdministrativeChangeAudit.create = originals.auditCreate;
  AssignmentPropagationOutbox.updateOne = originals.outboxUpdateOne;
});

function responseDouble() {
  return {
    statusCode: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function installStores({ revision = 2, users = [] } = {}) {
  const state = {
    upload: {
      _id: "64a000000000000000000099",
      uploaded_by: "64a000000000000000000001",
      is_active: true,
      revision,
    },
    users,
    audit: [],
    outbox: [],
    userWrites: [],
  };
  ExcelUpload.findById = () => ({
    select() {
      return this;
    },
    session() {
      return this;
    },
    lean: async () => ({ ...state.upload }),
  });
  ExcelUpload.findOneAndUpdate = (filter, update) => ({
    lean: async () => {
      const expected = filter.$or
        ? filter.$or.some((condition) =>
            condition.revision?.$exists
              ? state.upload.revision === undefined
              : state.upload.revision === condition.revision,
          )
        : state.upload.revision === filter.revision;
      if (
        state.upload._id !== filter._id ||
        state.upload.is_active !== true ||
        !expected
      ) {
        return null;
      }
      state.upload.is_active = update.$set.is_active;
      state.upload.revision += update.$inc.revision;
      return { ...state.upload };
    },
  });
  User.find = () => ({
    select() {
      return this;
    },
    session() {
      return this;
    },
    lean: async () => state.users.map((user) => ({ ...user })),
  });
  User.bulkWrite = async (operations, options) => {
    state.userWrites.push({ operations, options });
    return { matchedCount: operations.length, modifiedCount: operations.length };
  };
  AdministrativeChangeAudit.create = async (documents) => {
    state.audit.push(...documents);
    return documents;
  };
  AssignmentPropagationOutbox.updateOne = async (filter, update) => {
    state.outbox.push({ id: filter._id, document: update.$setOnInsert });
    return { upsertedCount: 1 };
  };
  return state;
}

function request(key, version) {
  return {
    params: { id: "64a000000000000000000099" },
    user: { id: "64a000000000000000000001", role: "superadmin" },
    get(name) {
      if (name.toLowerCase() === "idempotency-key") return key;
      if (name.toLowerCase() === "if-match") return `"${version}"`;
      return undefined;
    },
  };
}

test("Excel-upload deactivation is revisioned, audited, propagated, and replayable", async () => {
  const state = installStores({
    users: [{
      _id: "64a000000000000000000002",
      role: "student",
      bus_no: "BUS-7",
      resourceVersion: 4,
      assignmentRevision: 3,
    }],
  });
  const first = responseDouble();
  const replay = responseDouble();
  await deleteExcelUpload(request("excel-delete-key-001", 2), first);
  await deleteExcelUpload(request("excel-delete-key-001", 2), replay);

  assert.equal(first.statusCode, 200);
  assert.equal(first.payload.revision, 3);
  assert.equal(first.payload.deactivatedUsers, 1);
  assert.equal(first.payload.duplicate, false);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.payload.duplicate, true);
  assert.equal(state.upload.is_active, false);
  assert.equal(state.audit.length, 1);
  assert.equal(state.outbox.length, 1);
  assert.equal(state.userWrites.length, 1);
  assert.deepEqual(state.userWrites[0].operations[0].updateOne.update.$inc, {
    resourceVersion: 1,
    assignmentRevision: 1,
  });
  assert.equal(
    state.userWrites[0].operations[0].updateOne.filter.$and[1].excel_upload_id,
    "64a000000000000000000099",
  );
});

test("Excel-upload deactivation rejects missing keys and stale revisions", async () => {
  const state = installStores();
  const missingKey = responseDouble();
  await deleteExcelUpload(request("", 2), missingKey);
  assert.equal(missingKey.statusCode, 400);
  assert.equal(state.userWrites.length, 0);

  const stale = responseDouble();
  await deleteExcelUpload(request("excel-delete-stale-001", 1), stale);
  assert.equal(stale.statusCode, 409);
  assert.equal(state.upload.is_active, true);
  assert.equal(state.audit.length, 0);
  assert.equal(state.outbox.length, 0);
});

test("concurrent Excel-upload deletions with one revision commit at most once", async () => {
  const state = installStores();
  const first = responseDouble();
  const second = responseDouble();
  await Promise.all([
    deleteExcelUpload(request("excel-delete-race-001", 2), first),
    deleteExcelUpload(request("excel-delete-race-002", 2), second),
  ]);
  assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 409]);
  assert.equal(state.upload.revision, 3);
  assert.equal(state.audit.length, 1);
  assert.equal(state.outbox.length, 1);
});
