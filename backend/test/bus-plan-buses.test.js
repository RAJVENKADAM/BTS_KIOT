const assert = require("node:assert/strict");
const test = require("node:test");
const AppSetting = require("../src/models/AppSetting");
const Bus = require("../src/models/Bus");
const BusLiveLocation = require("../src/models/BusLiveLocation");
const BusRoute = require("../src/models/BusRoute");
const PlanMapping = require("../src/models/PlanMapping");
const StopMaster = require("../src/models/StopMaster");
const { getBusesForPlan } = require("../src/controllers/bus.controller");

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

function response() {
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

test("plan bus reads batch route and mapping lookups and preserve all plan relationships", async () => {
  const originals = {
    appSettingFindOne: AppSetting.findOne,
    busFind: Bus.find,
    routeFind: BusRoute.find,
    locationFind: BusLiveLocation.find,
    mappingFind: PlanMapping.find,
    stopFind: StopMaster.find,
  };
  const buses = [
    { _id: "a", bus_no: "BUS-A", preview_number: "1", status: "active" },
    { _id: "b", bus_no: "BUS-B", preview_number: "2", status: "active" },
    { _id: "br", bus_no: "BUS-BR", preview_number: "3", status: "active" },
    { _id: "cr", bus_no: "BUS-CR", preview_number: "4", status: "active" },
    { _id: "dr", bus_no: "BUS-DR", preview_number: "5", status: "active" },
  ];
  const routes = [
    { bus_id: "a", plan_name: "PLAN A", stop_name: "A", stop_order: 1, stopId: "SA" },
    { bus_id: "b", plan_name: "PLAN A", stop_name: "B", stop_order: 1, stopId: "SB" },
    { bus_id: "br", plan_name: "PLAN B", stop_name: "BR", stop_order: 1, stopId: "SBR" },
    { bus_id: "cr", plan_name: "PLAN C", stop_name: "CR", stop_order: 1, stopId: "SCR" },
    { bus_id: "dr", plan_name: "PLAN D", stop_name: "DR", stop_order: 1, stopId: "SDR" },
  ];
  const mappings = [
    { plan_name: "PLAN B", root_bus_id: "br", member_bus_ids: ["b"] },
    { plan_name: "PLAN C", root_bus_id: "cr", member_bus_ids: ["a"] },
    { plan_name: "PLAN D", root_bus_id: "dr", member_bus_ids: ["a", "b"] },
  ];
  const stops = routes.map((route) => ({
    stopId: route.stopId,
    name: route.stop_name,
    latitude: 10,
    longitude: 77,
    status: "VERIFIED",
  }));
  const queryCounts = { routes: 0, mappings: 0, candidateBusQueries: 0 };

  AppSetting.findOne = () => ({ lean: async () => null });
  Bus.find = (filter) => {
    let rows = [];
    if (filter.$or) {
      queryCounts.candidateBusQueries += 1;
      rows = buses;
    } else if (filter._id?.$in) {
      rows = buses.filter((bus) =>
        filter._id.$in.map(String).includes(String(bus._id)),
      );
    }
    return query(rows);
  };
  BusRoute.find = (filter) => {
    queryCounts.routes += 1;
    const ids = filter.bus_id.$in.map(String);
    return query(routes.filter((route) => ids.includes(String(route.bus_id))));
  };
  BusLiveLocation.find = (filter) =>
    query(
      filter.bus_id.$in.map((id) => ({
        bus_id: id,
        latitude: 11,
        longitude: 78,
        speed: 10,
        is_online: true,
        source: "gps",
      })),
    );
  PlanMapping.find = (filter) => {
    queryCounts.mappings += 1;
    return query(mappings.filter((mapping) => mapping.plan_name === filter.plan_name));
  };
  StopMaster.find = (filter) =>
    query(
      filter.stopId?.$in
        ? stops.filter((stop) => filter.stopId.$in.includes(stop.stopId))
        : [],
    );

  try {
    const requests = ["PLAN A", "PLAN B", "PLAN C", "PLAN D"].map((plan) => {
      const res = response();
      return getBusesForPlan(
        { params: { plan }, user: { role: "superadmin" } },
        res,
      ).then(() => res);
    });
    const responses = await Promise.all(requests);

    assert.deepEqual(
      responses.map((res) => res.payload.buses.map((bus) => bus.busNo)),
      [
        ["BUS-A", "BUS-B"],
        ["BUS-BR"],
        ["BUS-CR"],
        ["BUS-DR"],
      ],
    );
    assert.ok(responses.every((res) => res.statusCode === 200));
    assert.ok(responses.every((res, index) => res.payload.plan === `PLAN ${"ABCD"[index]}`));
    assert.equal(queryCounts.routes, 4);
    assert.equal(queryCounts.mappings, 3);
    assert.equal(queryCounts.candidateBusQueries, 4);
  } finally {
    AppSetting.findOne = originals.appSettingFindOne;
    Bus.find = originals.busFind;
    BusRoute.find = originals.routeFind;
    BusLiveLocation.find = originals.locationFind;
    PlanMapping.find = originals.mappingFind;
    StopMaster.find = originals.stopFind;
  }
});

test("plan bus read returns a compatible empty response when no buses have routes", async () => {
  const originals = {
    busFind: Bus.find,
    routeFind: BusRoute.find,
    locationFind: BusLiveLocation.find,
    mappingFind: PlanMapping.find,
  };
  Bus.find = () => query([]);
  BusRoute.find = () => query([]);
  BusLiveLocation.find = () => query([]);
  PlanMapping.find = () => query([]);
  const res = response();

  try {
    await getBusesForPlan(
      { params: { plan: "PLAN B" }, user: { role: "superadmin" } },
      res,
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload, {
      success: true,
      plan: "PLAN B",
      buses: [],
      count: 0,
    });
  } finally {
    Bus.find = originals.busFind;
    BusRoute.find = originals.routeFind;
    BusLiveLocation.find = originals.locationFind;
    PlanMapping.find = originals.mappingFind;
  }
});
