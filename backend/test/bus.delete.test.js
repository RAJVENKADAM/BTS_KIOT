const assert = require("node:assert/strict");
const { test } = require("node:test");
const Bus = require("../src/models/Bus");
const BusLiveLocation = require("../src/models/BusLiveLocation");
const BusRoute = require("../src/models/BusRoute");
const PlanMapping = require("../src/models/PlanMapping");
const User = require("../src/models/User");
const BusChange = require("../src/models/BusChange");
const { deleteBus } = require("../src/controllers/bus.controller");

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
    changeFindOne: BusChange.findOne,
    busUpdateMany: Bus.updateMany,
    busDeleteOne: Bus.deleteOne,
    userUpdateMany: User.updateMany,
    mappingUpdateMany: PlanMapping.updateMany,
    mappingDeleteMany: PlanMapping.deleteMany,
    routeDeleteMany: BusRoute.deleteMany,
    locationDeleteMany: BusLiveLocation.deleteMany,
  };
  const bus = { _id: "bus-id", bus_no: "BUS-12" };
  const calls = [];

  Bus.findOne = async (filter) => {
    calls.push(["bus.findOne", filter]);
    return bus;
  };
  BusChange.findOne = (filter) => ({
    select: async () => {
      calls.push(["busChange.findOne", filter]);
      return null;
    },
  });
  User.updateMany = async (...args) => calls.push(["user.updateMany", ...args]);
  PlanMapping.updateMany = async (...args) => calls.push(["mapping.updateMany", ...args]);
  PlanMapping.deleteMany = async (...args) => calls.push(["mapping.deleteMany", ...args]);
  Bus.updateMany = async (...args) => calls.push(["bus.updateMany", ...args]);
  BusRoute.deleteMany = async (...args) => calls.push(["route.deleteMany", ...args]);
  BusLiveLocation.deleteMany = async (...args) => calls.push(["location.deleteMany", ...args]);
  Bus.deleteOne = async (...args) => calls.push(["bus.deleteOne", ...args]);

  try {
    const response = createResponse();
    await deleteBus({ params: { busNo: "BUS-12" } }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.success, true);
    assert.deepEqual(calls.map(([name]) => name), [
      "bus.findOne",
      "busChange.findOne",
      "user.updateMany",
      "mapping.updateMany",
      "mapping.deleteMany",
      "bus.updateMany",
      "route.deleteMany",
      "location.deleteMany",
      "bus.deleteOne",
    ]);
    assert.equal(calls[2][1].bus_no.test("bus-12"), true);
    assert.deepEqual(calls[2][2], { $set: { bus_no: null } });
    assert.deepEqual(calls[3][1], { member_bus_ids: bus._id });
    assert.deepEqual(calls[3][2], { $pull: { member_bus_ids: bus._id } });
    assert.deepEqual(calls[4][1], { root_bus_id: bus._id });
    assert.deepEqual(calls[6][1], { bus_id: bus._id });
    assert.deepEqual(calls[7][1], { bus_id: bus._id });
    assert.deepEqual(calls[8][1], { _id: bus._id });
  } finally {
    Bus.findOne = originals.busFindOne;
    BusChange.findOne = originals.changeFindOne;
    Bus.updateMany = originals.busUpdateMany;
    Bus.deleteOne = originals.busDeleteOne;
    User.updateMany = originals.userUpdateMany;
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
    await deleteBus({ params: { busNo: "MISSING" } }, response);

    assert.equal(response.statusCode, 404);
    assert.equal(cleanupCalled, false);
  } finally {
    Bus.findOne = originalFindOne;
    BusRoute.deleteMany = originalRouteDeleteMany;
    BusLiveLocation.deleteMany = originalLocationDeleteMany;
  }
});
