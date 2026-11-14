"use strict";

const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const AdministrativeChangeAudit = require("../src/models/AdministrativeChangeAudit");
const AssignmentPropagationOutbox = require("../src/models/AssignmentPropagationOutbox");
const Bus = require("../src/models/Bus");
const User = require("../src/models/User");
const { updateBusDetails } = require("../src/controllers/bus.controller");
const { mockGpsOwnershipTransactions } = require("./helpers/gpsOwnershipTransactionMock.cjs");
const { mockMutationIdempotency } = require("./helpers/mutationIdempotencyMock.cjs");

const transactions = mockGpsOwnershipTransactions();
const idempotency = mockMutationIdempotency();
const originals = {
  auditCreate: AdministrativeChangeAudit.create,
  outboxUpdateOne: AssignmentPropagationOutbox.updateOne,
  busFindOne: Bus.findOne,
  busFindOneAndUpdate: Bus.findOneAndUpdate,
  userFind: User.find,
};
const auditRecords = [];
AdministrativeChangeAudit.create = async (documents) => {
  auditRecords.push(...documents);
  return documents;
};
AssignmentPropagationOutbox.updateOne = async () => ({ upsertedCount: 1 });

after(() => {
  transactions.restore();
  idempotency.restore();
  AdministrativeChangeAudit.create = originals.auditCreate;
  AssignmentPropagationOutbox.updateOne = originals.outboxUpdateOne;
  Bus.findOne = originals.busFindOne;
  Bus.findOneAndUpdate = originals.busFindOneAndUpdate;
  User.find = originals.userFind;
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

function request({ key = "bus-details-request-001", expectedVersion = 4, previewNumber = "23" } = {}) {
  return {
    params: { busNo: "BUS-1" },
    body: { previewNumber, expectedVersion },
    user: { id: "64a000000000000000000001" },
    get(name) {
      return name === "Idempotency-Key" ? key : undefined;
    },
  };
}

function installStores({ writeResult } = {}) {
  const bus = {
    _id: "64a000000000000000000010",
    bus_no: "BUS-1",
    revision: 4,
    preview_number: "22",
    gps_device_id: "device-1",
    reg_no: null,
  };
  const writes = [];
  Bus.findOne = async (filter) =>
    filter.bus_no === bus.bus_no ? { ...bus } : null;
  Bus.findOneAndUpdate = (filter, update) => {
    writes.push({ filter, update });
    const updated =
      writeResult === undefined
        ? {
            ...bus,
            ...update.$set,
            revision: bus.revision + update.$inc.revision,
          }
        : writeResult;
    return { lean: async () => updated };
  };
  User.find = () => ({
    select() {
      return this;
    },
    lean: async () => [],
  });
  return { bus, writes };
}

test("bus details use an atomic expected-revision write and persist the revision", async () => {
  auditRecords.length = 0;
  const stores = installStores();
  const response = responseDouble();

  await updateBusDetails(request(), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.bus.revision, 5);
  assert.equal(stores.writes.length, 1);
  assert.deepEqual(stores.writes[0].filter, {
    $and: [
      { _id: stores.bus._id },
      { revision: 4 },
    ],
  });
  assert.deepEqual(stores.writes[0].update, {
    $set: { preview_number: "23" },
    $inc: { revision: 1 },
  });
  assert.equal(auditRecords.length, 1);
  assert.equal(auditRecords[0].bus_revision_before, 4);
  assert.equal(auditRecords[0].bus_revision_after, 5);
});

test("bus details reject a stale revision without reporting success", async () => {
  const stores = installStores({ writeResult: null });
  const response = responseDouble();

  await updateBusDetails(
    request({ key: "bus-details-stale-001", expectedVersion: 3 }),
    response,
  );

  assert.equal(response.statusCode, 409);
  assert.equal(response.payload.code, "BUS_REVISION_CONFLICT");
  assert.equal(stores.writes.length, 1);
});

test("bus details replay an identical key and reject payload changes", async () => {
  const stores = installStores();
  const first = responseDouble();
  await updateBusDetails(
    request({ key: "bus-details-replay-001" }),
    first,
  );
  const replay = responseDouble();
  await updateBusDetails(
    request({ key: "bus-details-replay-001" }),
    replay,
  );

  assert.equal(replay.statusCode, 200);
  assert.equal(replay.payload.duplicate, true);
  assert.equal(stores.writes.length, 1);

  const conflict = responseDouble();
  await updateBusDetails(
    request({
      key: "bus-details-replay-001",
      previewNumber: "24",
    }),
    conflict,
  );
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.payload.code, "IDEMPOTENCY_KEY_CONFLICT");
  assert.equal(stores.writes.length, 1);
});
