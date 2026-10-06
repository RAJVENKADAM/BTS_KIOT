const assert = require("node:assert/strict");
const test = require("node:test");
const mergeBusRoutes = require("../src/utils/mergeBusRoutes");
const resolveBusServiceRoutes = require("../src/utils/resolveBusServiceRoutes");
const {
  resolveAssignedBusRoutes,
} = require("../src/utils/resolveBusServiceRoutes");

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

test("an active assigned bus keeps its own route despite another bus altering into it", () => {
  const assignedBusRoutes = [
    { plan_name: "PLAN A", stop_name: "Bus 4 stop", stop_order: 1 },
  ];
  const incomingBusRoutes = [
    { plan_name: "PLAN A", stop_name: "Bus 2 stop", stop_order: 1 },
  ];

  assert.deepEqual(
    resolveAssignedBusRoutes(
      { status: "active", alteration_type: null },
      assignedBusRoutes,
      incomingBusRoutes,
    ),
    assignedBusRoutes,
  );
});

test("an assigned altered bus uses the explicitly selected replacement route", () => {
  const originalRoutes = [
    { plan_name: "PLAN A", stop_name: "Bus 4 stop", stop_order: 1 },
  ];
  const replacementRoutes = [
    { plan_name: "PLAN A", stop_name: "Bus 2 stop", stop_order: 1 },
  ];

  assert.deepEqual(
    resolveAssignedBusRoutes(
      { alteration_type: "alter", alteration_route_source: "target" },
      originalRoutes,
      replacementRoutes,
    ),
    replacementRoutes,
  );
});

test("an altered replacement uses the original bus routes instead of its own", () => {
  const bus12Routes = [
    { plan_name: "PLAN A", stop_name: "North Gate", stop_order: 1 },
  ];
  const bus4Routes = [
    { plan_name: "PLAN A", stop_name: "South Gate", stop_order: 1 },
  ];

  assert.deepEqual(
    resolveBusServiceRoutes(bus4Routes, [
      { alterationType: "alter", routes: bus12Routes },
    ]),
    bus12Routes,
  );
});

test("alteration routes exclude replacement routes and combined routes", () => {
  const bus12Routes = [
    { plan_name: "PLAN A", stop_name: "North Gate", stop_order: 1 },
  ];
  const replacementRoutes = [
    { plan_name: "PLAN A", stop_name: "South Gate", stop_order: 1 },
  ];
  const otherCombinedRoutes = [
    { plan_name: "PLAN A", stop_name: "Library", stop_order: 1 },
  ];

  assert.deepEqual(
    resolveBusServiceRoutes(replacementRoutes, [
      { alterationType: "alter", routes: bus12Routes },
      { alterationType: "combine", routes: otherCombinedRoutes },
    ]),
    bus12Routes,
  );
});

test("combined bus routes still include both buses' stops", () => {
  const bus12Routes = [
    { plan_name: "PLAN A", stop_name: "North Gate", stop_order: 1 },
  ];
  const bus4Routes = [
    { plan_name: "PLAN A", stop_name: "South Gate", stop_order: 1 },
  ];

  assert.deepEqual(
    resolveBusServiceRoutes(bus4Routes, [
      { alterationType: "combine", routes: bus12Routes },
    ]),
    [
      { plan_name: "PLAN A", stop_name: "South Gate", stop_order: 1 },
      { plan_name: "PLAN A", stop_name: "North Gate", stop_order: 2 },
    ],
  );
});

test("an explicitly selected combined route set replaces the replacement bus routes", () => {
  const replacementRoutes = [
    { plan_name: "PLAN A", stop_name: "Replacement stop", stop_order: 1 },
  ];
  const selectedOriginalRoutes = [
    { plan_name: "PLAN A", stop_name: "Selected original stop", stop_order: 1 },
  ];

  assert.deepEqual(
    resolveBusServiceRoutes(replacementRoutes, [
      {
        alterationType: "combine",
        hasRouteSelection: true,
        routes: selectedOriginalRoutes,
      },
    ]),
    selectedOriginalRoutes,
  );
});

test("an explicitly selected uploaded route set replaces both buses' routes", () => {
  const replacementRoutes = [
    { plan_name: "PLAN A", stop_name: "Replacement stop", stop_order: 1 },
  ];
  const uploadedRoutes = [
    { plan_name: "PLAN B", stop_name: "Uploaded stop", stop_order: 1 },
  ];

  assert.deepEqual(
    resolveBusServiceRoutes(replacementRoutes, [
      {
        alterationType: "combine",
        hasRouteSelection: true,
        routes: uploadedRoutes,
      },
    ]),
    uploadedRoutes,
  );
});

test("merged routes deduplicate by physical stopId and preserve central references", () => {
  const routes = mergeBusRoutes(
    [
      {
        plan_name: "PLAN A",
        stop_name: "KIOT Main Gate",
        stop_order: 1,
        stopId: "STOP-045",
        latitude: 11.55,
        longitude: 78.01,
      },
    ],
    [
      {
        plan_name: "PLAN A",
        stop_name: "KIOT College",
        stop_order: 2,
        stopId: "STOP-045",
        latitude: 11.55,
        longitude: 78.01,
      },
      {
        plan_name: "PLAN A",
        stop_name: "Market",
        stop_order: 3,
        stopId: "STOP-046",
      },
    ],
  );

  assert.deepEqual(routes, [
    {
      plan_name: "PLAN A",
      stop_name: "KIOT Main Gate",
      stop_order: 1,
      stopId: "STOP-045",
      latitude: 11.55,
      longitude: 78.01,
    },
    {
      plan_name: "PLAN A",
      stop_name: "Market",
      stop_order: 2,
      stopId: "STOP-046",
    },
  ]);
});
