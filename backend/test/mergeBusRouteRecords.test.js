const assert = require("node:assert/strict");
const { test } = require("node:test");
const mergeBusRouteRecords = require("../src/utils/mergeBusRouteRecords");

test("merges canonical and legacy bus routes without losing distinct stops", () => {
  const canonicalBusId = "bus-2";
  const legacyBusId = "bus-02";
  const routes = [
    {
      _id: "canonical-stop-1",
      bus_id: canonicalBusId,
      plan_name: "PLAN A",
      stop_name: "Central",
      stopId: "STOP-CENTRAL",
      stop_order: 1,
      arrival_time: null,
    },
    {
      _id: "canonical-stop-2",
      bus_id: canonicalBusId,
      plan_name: "PLAN A",
      stop_name: "Market",
      stopId: "STOP-MARKET",
      stop_order: 2,
      arrival_time: "8:15AM",
    },
    {
      _id: "legacy-central",
      bus_id: legacyBusId,
      plan_name: "PLAN A",
      stop_name: "Central",
      stopId: "STOP-CENTRAL",
      stop_order: 1,
      arrival_time: "8:00AM",
    },
    {
      _id: "legacy-stop",
      bus_id: legacyBusId,
      plan_name: "PLAN A",
      stop_name: "College",
      stopId: "STOP-COLLEGE",
      stop_order: 2,
      arrival_time: "8:30AM",
    },
  ];

  const merged = mergeBusRouteRecords(routes, [canonicalBusId, legacyBusId]);

  assert.deepEqual(
    merged.retainedRoutes.map(({ route, stopOrder }) => ({
      id: route._id,
      stopOrder,
      arrivalTime: route.arrival_time,
    })),
    [
      { id: "canonical-stop-1", stopOrder: 1, arrivalTime: "8:00AM" },
      { id: "canonical-stop-2", stopOrder: 2, arrivalTime: "8:15AM" },
      { id: "legacy-stop", stopOrder: 3, arrivalTime: "8:30AM" },
    ],
  );
  assert.deepEqual(merged.duplicateIds, ["legacy-central"]);
});

test("keeps stop ordering separate for each route plan", () => {
  const merged = mergeBusRouteRecords(
    [
      { _id: "a1", bus_id: "bus-2", plan_name: "PLAN A", stop_name: "A", stop_order: 1 },
      { _id: "b1", bus_id: "bus-02", plan_name: "PLAN B", stop_name: "B", stop_order: 1 },
    ],
    ["bus-2", "bus-02"],
  );

  assert.deepEqual(
    merged.retainedRoutes.map(({ stopOrder }) => stopOrder),
    [1, 1],
  );
});
