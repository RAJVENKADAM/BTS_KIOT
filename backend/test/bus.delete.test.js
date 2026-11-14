const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const AdministrativeChangeAudit = require("../src/models/AdministrativeChangeAudit");
const AssignmentPropagationOutbox = require("../src/models/AssignmentPropagationOutbox");
const Bus = require("../src/models/Bus");
const BusLiveLocation = require("../src/models/BusLiveLocation");
const BusRoute = require("../src/models/BusRoute");
const PlanMapping = require("../src/models/PlanMapping");
const User = require("../src/models/User");
const BusChange = require("../src/models/BusChange");
const { deleteBus } = require("../src/controllers/bus.controller");
const { setIO } = require("../src/socket");
const { mockGpsOwnershipTransactions } = require("./helpers/gpsOwnershipTransactionMock.cjs");
const { mockMutationIdempotency } = require("./helpers/mutationIdempotencyMock.cjs");

const gpsOwnershipTransactions = mockGpsOwnershipTransactions();
const mutationIdempotency = mockMutationIdempotency();
const originalAuditCreate = AdministrativeChangeAudit.create;
const originalOutboxUpdateOne = AssignmentPropagationOutbox.updateOne;
const outboxRecords = [];
AdministrativeChangeAudit.create = async () => [];
AssignmentPropagationOutbox.updateOne = async (filter, update) => {
  outboxRecords.push({ filter, update });
  return { upsertedCount: 1 };
};
after(() => {
  gpsOwnershipTransactions.restore();
  mutationIdempotency.restore();
  AdministrativeChangeAudit.create = originalAuditCreate;
  AssignmentPropagationOutbox.updateOne = originalOutboxUpdateOne;
});

function createResponse() {
  return {
    statusCode: 200,
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

test("permanently deletes a bus and cleans up its dependent records", async () => {
  const originals = {
    busFindOne: Bus.findOne,
    busFind: Bus.find,
    changeFindOne: BusChange.findOne,
    busUpdateMany: Bus.updateMany,
    busDeleteOne: Bus.deleteOne,
    userFind: User.find,
    userUpdateOne: User.updateOne,
    mappingUpdateMany: PlanMapping.updateMany,
    mappingDeleteMany: PlanMapping.deleteMany,
    routeDeleteMany: BusRoute.deleteMany,
    locationDeleteMany: BusLiveLocation.deleteMany,
  };
  const bus = {
    _id: "bus-id",
    bus_no: "BUS-12",
    toObject() {
      return { _id: this._id, bus_no: this.bus_no };
    },
  };
  const calls = [];
  const notifications = [];

  Bus.findOne = async (filter) => {
    calls.push(["bus.findOne", filter]);
    return bus;
  };
  Bus.find = (...args) => {
    calls.push(["bus.find", ...args]);
    return ({
    select() {
      return this;
    },
    lean: async () => [],
    });
  };
  BusChange.findOne = (filter) => ({
    select: async () => {
      calls.push(["busChange.findOne", filter]);
      return null;
    },
  });
  User.find = (...args) => {
    calls.push(["user.find", ...args]);
    return {
      select() {
        return this;
      },
      lean: async () => [
        { _id: "student-1", bus_no: "BUS-12" },
        { _id: "student-2", bus_no: "BUS-12" },
      ],
    };
  };
  User.updateOne = async (...args) => {
    calls.push(["user.updateOne", ...args]);
    return { matchedCount: 1 };
  };
  PlanMapping.updateMany = async (...args) => calls.push(["mapping.updateMany", ...args]);
  PlanMapping.deleteMany = async (...args) => calls.push(["mapping.deleteMany", ...args]);
  Bus.updateMany = async (...args) => calls.push(["bus.updateMany", ...args]);
  BusRoute.deleteMany = async (...args) => calls.push(["route.deleteMany", ...args]);
  BusLiveLocation.deleteMany = async (...args) => calls.push(["location.deleteMany", ...args]);
  Bus.deleteOne = async (...args) => {
    calls.push(["bus.deleteOne", ...args]);
    return { deletedCount: 1 };
  };
  setIO({
    to(room) {
      return {
        emit(event, payload) {
          notifications.push({ room, event, payload });
        },
      };
    },
  });

  try {
    const response = createResponse();
    await deleteBus(
      {
        params: { busNo: "BUS-12" },
        body: { expectedVersion: 0 },
        user: { id: "64a000000000000000000099" },
        get: (name) =>
          name === "Idempotency-Key" ? "bus-delete-test-001" : undefined,
      },
      response,
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.success, true);
    assert.deepEqual(calls.map(([name]) => name), [
      "bus.findOne",
      "busChange.findOne",
      "user.find",
      "bus.find",
      "user.updateOne",
      "user.updateOne",
      "mapping.updateMany",
      "mapping.deleteMany",
      "route.deleteMany",
      "location.deleteMany",
      "bus.deleteOne",
    ]);
    const userFindCall = calls.find(([name]) => name === "user.find");
    const userUpdateCall = calls.find(([name]) => name === "user.updateOne");
    const assignmentPatterns = userFindCall[1].bus_no.$in;
    assert.equal(assignmentPatterns[0].test("bus-12"), true);
    assert.deepEqual(userUpdateCall[1].$and[0], { _id: "student-1" });
    assert.deepEqual(userUpdateCall[1].$and[1], { bus_no: "BUS-12" });
    assert.deepEqual(userUpdateCall[1].$and[2], {
      $or: [
        { assignmentRevision: 0 },
        { assignmentRevision: { $exists: false } },
      ],
    });
    assert.deepEqual(userUpdateCall[2], {
      $inc: { assignmentRevision: 1 },
      $set: { bus_no: null },
    });
    assert.deepEqual(calls[6][1], { member_bus_ids: bus._id });
    assert.deepEqual(calls[6][2], { $pull: { member_bus_ids: bus._id } });
    assert.deepEqual(calls[7][1], { root_bus_id: bus._id });
    assert.deepEqual(calls[8][1], { bus_id: bus._id });
    assert.deepEqual(calls[9][1], { bus_id: bus._id });
    assert.equal(calls[10][0], "bus.deleteOne");
    assert.deepEqual(notifications, []);
    assert.equal(outboxRecords.at(-1).update.$setOnInsert.operation, "bus-deleted");
    assert.deepEqual(
      outboxRecords.at(-1).update.$setOnInsert.recipients.map((item) => item.user_id),
      ["student-1", "student-2"],
    );
  } finally {
    setIO(null);
    Bus.findOne = originals.busFindOne;
    Bus.find = originals.busFind;
    BusChange.findOne = originals.changeFindOne;
    Bus.updateMany = originals.busUpdateMany;
    Bus.deleteOne = originals.busDeleteOne;
    User.find = originals.userFind;
    User.updateOne = originals.userUpdateOne;
    PlanMapping.updateMany = originals.mappingUpdateMany;
    PlanMapping.deleteMany = originals.mappingDeleteMany;
    BusRoute.deleteMany = originals.routeDeleteMany;
    BusLiveLocation.deleteMany = originals.locationDeleteMany;
  }
});

test("does not delete related records when the bus does not exist", async () => {
  const originalFindOne = Bus.findOne;
  const originalRouteDeleteMany = BusRoute.deleteMany;
  const originalLocationDeleteMany = BusLiveLocation.deleteMany;
  let cleanupCalled = false;
  Bus.findOne = async () => null;
  BusRoute.deleteMany = async () => { cleanupCalled = true; };
  BusLiveLocation.deleteMany = async () => { cleanupCalled = true; };

  try {
    const response = createResponse();
    await deleteBus(
      {
        params: { busNo: "MISSING" },
        body: { expectedVersion: 0 },
        user: { id: "64a000000000000000000099" },
        get: () => "bus-delete-missing-001",
      },
      response,
    );

    assert.equal(response.statusCode, 404);
    assert.equal(cleanupCalled, false);
  } finally {
    Bus.findOne = originalFindOne;
    BusRoute.deleteMany = originalRouteDeleteMany;
    BusLiveLocation.deleteMany = originalLocationDeleteMany;
  }
});
