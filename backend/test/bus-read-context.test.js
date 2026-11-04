const assert = require("node:assert/strict");
const test = require("node:test");
const Bus = require("../src/models/Bus");
const BusRoute = require("../src/models/BusRoute");
const StopMaster = require("../src/models/StopMaster");
const { loadBusReadContext, getRoutesForBus } = require("../src/utils/busReadContext");

function query(result) {
  return {
    select() {
      return this;
    },
    sort() {
      return this;
    },
    limit() {
      return this;
    },
    lean: async () => result,
  };
}

test("route context batches route reads and does not write legacy stopId repairs", async () => {
  const originals = {
    busFind: Bus.find,
    routeFind: BusRoute.find,
    routeUpdateOne: BusRoute.updateOne,
    stopFind: StopMaster.find,
    stopFindOne: StopMaster.findOne,
  };
  const buses = [
    { _id: "bus-1", bus_no: "BUS-1", status: "active" },
    { _id: "bus-2", bus_no: "BUS-2", status: "active" },
  ];
  const routeReads = [];
  let legacyStopReads = 0;
  let routeWrites = 0;
  Bus.find = (filter) => query(
    filter.altered_to_bus_id
      ? []
      : filter._id
        ? []
        : [],
  );
  BusRoute.find = (filter) => {
    routeReads.push(filter);
    return query([
      {
        _id: "route-1",
        bus_id: "bus-1",
        plan_name: "PLAN A",
        stop_name: "College",
        stop_order: 1,
        stopId: null,
        arrival_time: null,
      },
      {
        _id: "route-2",
        bus_id: "bus-2",
        plan_name: "PLAN B",
        stop_name: "College",
        stop_order: 1,
        stopId: "STOP-2",
        arrival_time: "8:00AM",
      },
      {
        _id: "route-3",
        bus_id: "bus-2",
        plan_name: "PLAN B",
        stop_name: "Library",
        stop_order: 2,
        stopId: null,
        arrival_time: null,
      },
    ]);
  };
  BusRoute.updateOne = async () => {
    routeWrites += 1;
    throw new Error("Read requests must not repair route records.");
  };
  StopMaster.find = (filter) => {
    if (filter.stopId?.$in) {
      return query([
        {
          stopId: "STOP-2",
          name: "College",
          latitude: 11,
          longitude: 78,
          status: "VERIFIED",
        },
      ]);
    }
    legacyStopReads += 1;
    assert.equal(filter.$or.length, 2);
    return query([
      {
        stopId: "STOP-1",
        name: "College",
        aliases: [],
        latitude: 10,
        longitude: 77,
        status: "VERIFIED",
      },
      {
        stopId: "STOP-3",
        name: "Library",
        aliases: [],
        latitude: 12,
        longitude: 78,
        status: "PENDING",
      },
    ]);
  };
  StopMaster.findOne = () => {
    throw new Error("Legacy route resolution must use batched reads.");
  };

  try {
    const context = await loadBusReadContext(buses);
    const firstRoutes = getRoutesForBus(context, buses[0]);
    const secondRoutes = getRoutesForBus(context, buses[1]);

    assert.equal(routeReads.length, 1);
    assert.deepEqual(routeReads[0].bus_id.$in, ["bus-1", "bus-2"]);
    assert.equal(firstRoutes[0].stopId, "STOP-1");
    assert.equal(firstRoutes[0].latitude, 10);
    assert.equal(secondRoutes[0].stopId, "STOP-2");
    assert.equal(secondRoutes[1].stopId, "STOP-3");
    assert.equal(legacyStopReads, 1);
    assert.equal(routeWrites, 0);
  } finally {
    Bus.find = originals.busFind;
    BusRoute.find = originals.routeFind;
    BusRoute.updateOne = originals.routeUpdateOne;
    StopMaster.find = originals.stopFind;
    StopMaster.findOne = originals.stopFindOne;
  }
});

test("incoming bus lookup has a compound index declaration", () => {
  const indexes = Bus.schema.indexes().map(([fields]) => fields);
  assert.ok(
    indexes.some(
      (fields) => fields.altered_to_bus_id === 1 && fields.alteration_type === 1,
    ),
  );
});
