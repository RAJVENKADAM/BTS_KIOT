const assert = require("node:assert/strict");
const test = require("node:test");
const AppSetting = require("../src/models/AppSetting");
const Bus = require("../src/models/Bus");
const BusRoute = require("../src/models/BusRoute");
const PlanMapping = require("../src/models/PlanMapping");
const User = require("../src/models/User");
const { getPlanMappingData } = require("../src/controllers/planMapping.controller");

function query(result) {
  return {
    select() {
      return this;
    },
    sort() {
      return this;
    },
    lean: async () => result,
  };
}

test("plan mapping data resolves raw references through one bus lookup map", async () => {
  const originals = {
    appSettingFindOne: AppSetting.findOne,
    busFind: Bus.find,
    routeFind: BusRoute.find,
    mappingFind: PlanMapping.find,
    userAggregate: User.aggregate,
  };
  const rootId = "root-id";
  const memberId = "member-id";
  let populateCalled = false;
  AppSetting.findOne = () => ({ lean: async () => ({ value: "PLAN B" }) });
  Bus.find = () =>
    query([
      {
        _id: rootId,
        bus_no: "BUS-ROOT",
        preview_number: "1",
        status: "active",
        alteration_type: null,
        combined_route_source: null,
        combined_routes: [],
        alteration_route_source: null,
        alteration_routes: [],
      },
      {
        _id: memberId,
        bus_no: "BUS-MEMBER",
        preview_number: "2",
        status: "active",
        alteration_type: null,
        combined_route_source: null,
        combined_routes: [],
        alteration_route_source: null,
        alteration_routes: [],
      },
    ]);
  BusRoute.find = () =>
    query([
      {
        bus_id: rootId,
        plan_name: "PLAN B",
        stop_name: "Main Gate",
        stopId: "STOP-1",
        stop_order: 2,
        arrival_time: "8:10AM",
      },
      {
        bus_id: rootId,
        plan_name: "PLAN B",
        stop_name: "Library",
        stopId: "STOP-2",
        stop_order: 1,
        arrival_time: "8:00AM",
      },
    ]);
  PlanMapping.find = () => {
    const result = query([
      {
        _id: "cluster-id",
        plan_name: "PLAN B",
        cluster_name: "North",
        root_bus_id: rootId,
        location_bus_id: null,
        member_bus_ids: [memberId],
      },
    ]);
    result.populate = () => {
      populateCalled = true;
      return result;
    };
    return result;
  };
  User.aggregate = async () => [{ _id: "2", count: 2 }];
  const response = {
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

  try {
    await getPlanMappingData({}, response);

    assert.equal(response.statusCode, 200);
    assert.equal(populateCalled, false);
    assert.equal(response.payload.activePlan, "PLAN B");
    assert.deepEqual(response.payload.plans, ["PLAN A", "PLAN B", "PLAN C", "PLAN D"]);
    assert.equal(response.payload.clusters[0].rootBus.id, rootId);
    assert.equal(response.payload.clusters[0].memberBuses[0].id, memberId);
    assert.equal(response.payload.buses[1].assignedUsers, 2);
    assert.deepEqual(
      response.payload.clusters[0].rootStops.map((stop) => stop.stopOrder),
      [1, 2],
    );
    assert.equal(response.payload.buses[0].plans.includes("PLAN B"), true);
  } finally {
    AppSetting.findOne = originals.appSettingFindOne;
    Bus.find = originals.busFind;
    BusRoute.find = originals.routeFind;
    PlanMapping.find = originals.mappingFind;
    User.aggregate = originals.userAggregate;
  }
});
