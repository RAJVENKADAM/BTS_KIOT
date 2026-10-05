const assert = require("node:assert/strict");
const test = require("node:test");
const mergeBusRoutes = require("../src/utils/mergeBusRoutes");

test("merges plans and unique stops, keeping source stops before target-only stops", () => {
  const routes = mergeBusRoutes(
    [
      { plan_name: "Plan A", stop_name: "Main Gate", stop_order: 1 },
      { plan_name: "Plan A", stop_name: "Library", stop_order: 2 },
    ],
    [
      { plan_name: "PLAN A", stop_name: "main gate", stop_order: 1 },
      { plan_name: "Plan A", stop_name: "Cafeteria", stop_order: 2 },
      { plan_name: "Plan B", stop_name: "Hostel", stop_order: 1 },
    ],
  );

  assert.deepEqual(routes, [
    { plan_name: "Plan A", stop_name: "Main Gate", stop_order: 1 },
    { plan_name: "Plan A", stop_name: "Library", stop_order: 2 },
    { plan_name: "Plan A", stop_name: "Cafeteria", stop_order: 3 },
    { plan_name: "Plan B", stop_name: "Hostel", stop_order: 1 },
  ]);
});

test("returns source routes when the replacement bus has no routes", () => {
  assert.deepEqual(
    mergeBusRoutes(
      [{ plan_name: "Plan A", stop_name: "Main Gate", stop_order: 1 }],
      [],
    ),
    [{ plan_name: "Plan A", stop_name: "Main Gate", stop_order: 1 }],
  );
});
