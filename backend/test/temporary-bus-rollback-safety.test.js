"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const AdministrativeChangeAudit = require("../src/models/AdministrativeChangeAudit");
const AssignmentPropagationOutbox = require("../src/models/AssignmentPropagationOutbox");
const Bus = require("../src/models/Bus");
const BusChange = require("../src/models/BusChange");
const User = require("../src/models/User");
const { rollbackTemporaryBusChange } = require("../src/controllers/bus.controller");
const { mockGpsOwnershipTransactions } = require("./helpers/gpsOwnershipTransactionMock.cjs");
const { mockMutationIdempotency } = require("./helpers/mutationIdempotencyMock.cjs");

const sourceId = "64a000000000000000000010";
const targetId = "64a000000000000000000011";
const changeId = "64a000000000000000000012";

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

function makeRequest() {
  return {
    params: { changeId },
    body: { expectedVersion: 3, expectedVersions: { "BUS-2": 5 } },
    user: { id: "64a000000000000000000020" },
    get(name) {
      return name === "Idempotency-Key" ? randomUUID() : undefined;
    },
  };
}

function installStores(type, riderCount) {
  const transactions = mockGpsOwnershipTransactions();
  const idempotency = mockMutationIdempotency();
  const originals = {
    auditCreate: AdministrativeChangeAudit.create,
    outboxUpdateOne: AssignmentPropagationOutbox.updateOne,
    busFind: Bus.find,
    busFindOneAndUpdate: Bus.findOneAndUpdate,
    busChangeFind: BusChange.find,
    busChangeFindById: BusChange.findById,
    busChangeUpdateOne: BusChange.updateOne,
    userFind: User.find,
    userUpdateOne: User.updateOne,
  };
  const sourceBus = new Bus({
    _id: sourceId,
    bus_no: "BUS-1",
    preview_number: "1",
    gps_device_id: "device-1",
    revision: 3,
    status: type === "alter" ? "inactive" : "active",
  });
  const targetBus = new Bus({
    _id: targetId,
    bus_no: "BUS-2",
    preview_number: "2",
    gps_device_id: "device-2",
    revision: 5,
    status: "active",
  });
  const buses = new Map([
    [sourceId, sourceBus],
    [targetId, targetBus],
  ]);
  const change = {
    _id: changeId,
    type,
    status: "active",
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    sourceBusId: sourceId,
    sourceBusNo: "BUS-1",
    sourcePreview: "1",
    targetBusId: targetId,
    targetBusNo: "BUS-2",
    targetPreview: "2",
    busSnapshots: [
      { busId: sourceId, busNo: "BUS-1", status: "active" },
      { busId: targetId, busNo: "BUS-2", status: "active" },
    ],
    assignmentSnapshots: [
      {
        userId: "64a000000000000000000021",
        beforeBusNo: "BUS-1",
        afterBusNo: "BUS-2",
      },
      ...(type === "combine"
        ? [{
            userId: "64a000000000000000000022",
            beforeBusNo: "BUS-2",
            afterBusNo: "BUS-2",
          }]
        : []),
    ],
  };
  const busWrites = [];
  const assignmentWrites = [];
  let changeStatus = "active";

  BusChange.findById = async () => change;
  BusChange.find = () => ({ select: async () => [] });
  BusChange.updateOne = async () => {
    changeStatus = "rolled_back";
    return { matchedCount: 1 };
  };
  Bus.find = async () => [sourceBus, targetBus];
  Bus.findOneAndUpdate = (filter, update) => {
    const bus = buses.get(String(filter.$and[0]._id));
    if (!bus || bus.revision !== filter.$and[1].revision) {
      return { lean: async () => null };
    }
    Object.assign(bus, update.$set);
    bus.revision += update.$inc.revision;
    busWrites.push(bus.bus_no);
    return { lean: async () => bus.toObject() };
  };
  User.find = (filter) => {
    const results = filter.bus_no
      ? Array.from({ length: riderCount }, (_, index) => ({
          _id: `64a00000000000000000${String(index + 100).slice(-4)}`,
          bus_no: "BUS-1",
          assignmentRevision: 1,
        }))
      : [
          {
            _id: "64a000000000000000000021",
            bus_no: "BUS-2",
            assignmentRevision: 2,
          },
          ...(type === "combine"
            ? [{
                _id: "64a000000000000000000022",
                bus_no: "BUS-2",
                assignmentRevision: 2,
              }]
            : []),
        ];
    return {
      select() {
        return this;
      },
      lean: async () => results,
      then(resolve, reject) {
        return Promise.resolve(results).then(resolve, reject);
      },
    };
  };
  User.updateOne = async (filter, update) => {
    assignmentWrites.push({ filter, update });
    return { matchedCount: 1 };
  };
  AdministrativeChangeAudit.create = async () => [];
  AssignmentPropagationOutbox.updateOne = async () => ({ upsertedCount: 1 });

  return {
    busWrites,
    assignmentWrites,
    get changeStatus() {
      return changeStatus;
    },
    restore() {
      transactions.restore();
      idempotency.restore();
      AdministrativeChangeAudit.create = originals.auditCreate;
      AssignmentPropagationOutbox.updateOne = originals.outboxUpdateOne;
      Bus.find = originals.busFind;
      Bus.findOneAndUpdate = originals.busFindOneAndUpdate;
      BusChange.find = originals.busChangeFind;
      BusChange.findById = originals.busChangeFindById;
      BusChange.updateOne = originals.busChangeUpdateOne;
      User.find = originals.userFind;
      User.updateOne = originals.userUpdateOne;
    },
  };
}

test("alter and combine rollback require an empty original source bus", async () => {
  for (const type of ["alter", "combine"]) {
    const occupiedStores = installStores(type, 11);
    try {
      const occupiedResponse = responseDouble();
      await rollbackTemporaryBusChange(makeRequest(), occupiedResponse);

      assert.equal(occupiedResponse.statusCode, 409);
      assert.match(occupiedResponse.payload.error, /11 rider\(s\)/);
      assert.match(occupiedResponse.payload.error, /No rider assignments were changed/);
      assert.equal(occupiedStores.busWrites.length, 0);
      assert.equal(occupiedStores.assignmentWrites.length, 0);
      assert.equal(occupiedStores.changeStatus, "active");
    } finally {
      occupiedStores.restore();
    }

    const emptyStores = installStores(type, 0);
    try {
      const emptyResponse = responseDouble();
      await rollbackTemporaryBusChange(makeRequest(), emptyResponse);

      assert.equal(emptyResponse.statusCode, null);
      assert.equal(emptyResponse.payload.success, true);
      assert.equal(emptyStores.changeStatus, "rolled_back");
      assert.deepEqual(emptyStores.busWrites, ["BUS-1", "BUS-2"]);
      assert.equal(emptyStores.assignmentWrites.length, 1);
      assert.deepEqual(emptyStores.assignmentWrites[0].update, {
        $inc: { assignmentRevision: 1 },
        $set: { bus_no: "BUS-1" },
      });
    } finally {
      emptyStores.restore();
    }
  }
});
