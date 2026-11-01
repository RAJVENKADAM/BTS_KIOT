const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getEffectiveBusId,
  findUncoveredAssignments,
  normalizeArrivalTime,
  validateCluster,
} = require("../src/utils/planMapping");
const {
  getClusterChangeNotifications,
  getInUseLocationBusIds,
  getPlanChangeNotifications,
  getPlanMappingChangeNotifications,
} = require("../src/services/planMappingService");

const buses = {
  "root-b": { plans: ["PLAN B"] },
  "root-c": { plans: ["PLAN C"] },
  "student-1": { plans: ["PLAN A"] },
  "student-2": { plans: ["PLAN A"] },
  "other": { plans: ["PLAN A", "PLAN B"] },
};

test("validates a cluster root and Plan A-only member buses", () => {
  assert.deepEqual(
    validateCluster(
      {
        planName: "PLAN B",
        rootBusId: "root-b",
        memberBusIds: ["student-1", "student-2"],
      },
      buses,
      [],
    ),
    [],
  );
});

test("rejects a root without the target plan and members that are not Plan A-only", () => {
  const errors = validateCluster(
    {
      planName: "PLAN B",
      rootBusId: "student-1",
      memberBusIds: ["other"],
    },
    buses,
    [],
  );

  assert.equal(errors.length, 2);
});

test("rejects a bus mapped into multiple clusters for one plan", () => {
  const errors = validateCluster(
    {
      planName: "PLAN B",
      rootBusId: "root-b",
      memberBusIds: ["student-1"],
    },
    buses,
    [
      {
        plan_name: "PLAN B",
        root_bus_id: "another-root",
        member_bus_ids: ["student-1"],
      },
    ],
  );

  assert.ok(errors.some((error) => error.includes("already mapped")));
});

test("resolves mapped buses to the selected plan root only", () => {
  const clusters = [
    {
      plan_name: "PLAN B",
      root_bus_id: "root-b",
      member_bus_ids: ["student-1"],
    },
    {
      plan_name: "PLAN C",
      root_bus_id: "root-c",
      member_bus_ids: ["student-1"],
    },
  ];

  assert.equal(getEffectiveBusId("student-1", "PLAN B", clusters), "root-b");
  assert.equal(getEffectiveBusId("student-1", "PLAN C", clusters), "root-c");
  assert.equal(getEffectiveBusId("student-1", "PLAN A", clusters), "student-1");
});

test("reports assigned buses without an effective route before a plan change", () => {
  const clusters = [
    {
      plan_name: "PLAN B",
      root_bus_id: "root-b",
      member_bus_ids: ["student-1"],
    },
  ];
  const busesWithRoutes = {
    ...buses,
    "student-1": { plans: ["PLAN A"] },
  };

  assert.deepEqual(
    findUncoveredAssignments(
      ["student-1", "student-2"],
      "PLAN B",
      clusters,
      busesWithRoutes,
    ),
    ["student-2"],
  );
});

test("global plan changes notify all riders without exposing plan names", () => {
  const state = {
    buses: [
      { _id: "direct", bus_no: "BUS-DIRECT", preview_number: "1", status: "active" },
      { _id: "member", bus_no: "BUS-MEMBER", preview_number: "2", status: "active" },
      { _id: "root", bus_no: "BUS-ROOT", preview_number: "3", status: "active" },
      { _id: "inactive", bus_no: "BUS-INACTIVE", preview_number: "4", status: "active" },
    ],
    busesById: {
      direct: { plans: ["PLAN B"], status: "active" },
      member: { plans: ["PLAN A"], status: "active" },
      root: { plans: ["PLAN B"], status: "active" },
      inactive: { plans: ["PLAN A"], status: "active" },
    },
    busIdsByUser: ["direct", "member", "inactive", null],
    clusters: [
      { plan_name: "PLAN B", root_bus_id: "root", member_bus_ids: ["member"] },
    ],
    users: [
      { _id: "user-direct", bus_no: "BUS-DIRECT" },
      { _id: "user-member", bus_no: "BUS-MEMBER" },
      { _id: "user-inactive", bus_no: "BUS-INACTIVE" },
      { _id: "user-deleted", bus_no: "BUS-DELETED" },
    ],
  };

  const notifications = getPlanChangeNotifications(state, "PLAN B");

  assert.deepEqual(notifications.map(({ user_id, is_bus_active }) => [user_id, is_bus_active]), [
    ["user-direct", true],
    ["user-member", true],
    ["user-inactive", false],
    ["user-deleted", false],
  ]);
  assert.equal(
    notifications[0].message,
    "Bus: No bus change\nStops: No change\nIf you have any doubts, ask your administration.",
  );
  assert.equal(
    notifications[1].message,
    "Bus: Uses Bus 3 location\nStops: Uses Bus 3 stops; find them on the Home page.\nIf you have any doubts, ask your administration.",
  );
  assert.doesNotMatch(notifications[0].message, /PLAN B/i);
  assert.equal(notifications[1].new_preview, "3");
  assert.match(notifications[2].message, /Bus: Assigned Bus 4 has no service/);
  assert.doesNotMatch(notifications[2].message, /PLAN B/i);
  assert.equal(
    notifications[3].message,
    "Bus: No assigned buses\nStops: No assigned stops\nIf you have any doubts, ask your administration.",
  );

  const normalPlanNotifications = getPlanChangeNotifications(state, "PLAN A");
  assert.equal(normalPlanNotifications.length, 4);
  assert.deepEqual(
    normalPlanNotifications.map(({ user_id, is_bus_active }) => [
      user_id,
      is_bus_active,
    ]),
    [
      ["user-direct", false],
      ["user-member", true],
      ["user-inactive", true],
      ["user-deleted", false],
    ],
  );
  assert.ok(normalPlanNotifications.every(({ message }) => !/PLAN A/i.test(message)));
  assert.equal(
    normalPlanNotifications[1].message,
    "Bus: No bus change\nStops: No change\nIf you have any doubts, ask your administration.",
  );
});

test("cluster edits notify riders when service changes but never block for uncovered riders", () => {
  const state = {
    buses: [
      { _id: "direct", bus_no: "BUS-DIRECT", preview_number: "1" },
      { _id: "member", bus_no: "BUS-MEMBER", preview_number: "2" },
      { _id: "root", bus_no: "BUS-ROOT", preview_number: "3" },
    ],
    busesById: {
      direct: { plans: ["PLAN B"], status: "active" },
      member: { plans: ["PLAN A"], status: "active" },
      root: { plans: ["PLAN B"], status: "active" },
    },
    busIdsByUser: ["direct", "member"],
    clusters: [
      { plan_name: "PLAN B", root_bus_id: "root", member_bus_ids: ["member"] },
    ],
    users: [
      { _id: "user-direct", bus_no: "BUS-DIRECT" },
      { _id: "user-member", bus_no: "BUS-MEMBER" },
    ],
  };
  const oldClusters = [];

  const notifications = getPlanMappingChangeNotifications(
    state,
    "PLAN B",
    oldClusters,
  );

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].user_id, "user-member");
  assert.equal(notifications[0].new_preview, "3");
  assert.equal(notifications[0].is_bus_active, true);
  assert.match(notifications[0].message, /Stops: Uses Bus 3 stops/);
});

test("temporary location swaps keep root stops and notify all root and member riders", () => {
  const state = {
    buses: [
      { _id: "root", bus_no: "BUS-ROOT", preview_number: "3" },
      { _id: "member", bus_no: "BUS-MEMBER", preview_number: "2" },
      { _id: "spare", bus_no: "BUS-SPARE", preview_number: "8" },
    ],
    busIdsByUser: ["root", "member"],
    users: [
      { _id: "root-rider", bus_no: "BUS-ROOT" },
      { _id: "member-rider", bus_no: "BUS-MEMBER" },
    ],
  };
  const cluster = {
    plan_name: "PLAN B",
    root_bus_id: "root",
    location_bus_id: "spare",
    member_bus_ids: ["member"],
  };
  const notifications = getClusterChangeNotifications(
    state,
    cluster,
    "PLAN B",
    true,
  );

  assert.equal(notifications.length, 2);
  assert.deepEqual(
    notifications.map(({ user_id, message }) => [
      user_id,
      message.split("\n").slice(0, 2),
    ]),
    [
      [
        "root-rider",
        ["Bus: Uses Bus 8 location", "Stops: Uses Bus 3 stops; find them on the Home page."],
      ],
      [
        "member-rider",
        ["Bus: Uses Bus 8 location", "Stops: Uses Bus 3 stops; find them on the Home page."],
      ],
    ],
  );
});

test("saving a temporary bus swap notifies root and mapped riders with separate route and location buses", () => {
  const state = {
    buses: [
      { _id: "root", bus_no: "BUS-ROOT", preview_number: "3" },
      { _id: "member", bus_no: "BUS-MEMBER", preview_number: "2" },
      { _id: "spare", bus_no: "BUS-SPARE", preview_number: "8" },
    ],
    busesById: {
      root: { plans: ["PLAN B"], status: "active" },
      member: { plans: ["PLAN A"], status: "active" },
      spare: { plans: [], status: "active" },
    },
    busIdsByUser: ["root", "member"],
    users: [
      { _id: "root-rider", bus_no: "BUS-ROOT" },
      { _id: "member-rider", bus_no: "BUS-MEMBER" },
    ],
    clusters: [
      {
        plan_name: "PLAN B",
        root_bus_id: "root",
        location_bus_id: "spare",
        member_bus_ids: ["member"],
      },
    ],
  };
  const previousClusters = [
    {
      plan_name: "PLAN B",
      root_bus_id: "root",
      member_bus_ids: ["member"],
    },
  ];

  const notifications = getPlanMappingChangeNotifications(
    state,
    "PLAN B",
    previousClusters,
  );
  assert.equal(notifications.length, 2);
  assert.ok(
    notifications.every((notification) =>
      notification.message.includes(
        "Bus: Uses Bus 8 location\nStops: Uses Bus 3 stops",
      ),
    ),
  );
  assert.ok(notifications.every(({ new_preview }) => new_preview === "8"));
});

test("global plan activation uses the swapped bus for location and the root bus for stops", () => {
  const state = {
    buses: [
      { _id: "root", bus_no: "BUS-ROOT", preview_number: "3" },
      { _id: "member", bus_no: "BUS-MEMBER", preview_number: "2" },
      { _id: "spare", bus_no: "BUS-SPARE", preview_number: "8" },
    ],
    busesById: {
      root: { plans: ["PLAN B"], status: "active" },
      member: { plans: ["PLAN A"], status: "active" },
      spare: { plans: [], status: "active" },
    },
    busIdsByUser: ["root", "member"],
    users: [
      { _id: "root-rider", bus_no: "BUS-ROOT" },
      { _id: "member-rider", bus_no: "BUS-MEMBER" },
    ],
    clusters: [
      {
        plan_name: "PLAN B",
        root_bus_id: "root",
        location_bus_id: "spare",
        member_bus_ids: ["member"],
      },
    ],
  };
  const notifications = getPlanChangeNotifications(state, "PLAN B");

  assert.equal(notifications.length, 2);
  assert.match(notifications[0].message, /Bus: Uses Bus 8 location/);
  assert.match(notifications[0].message, /Stops: No change/);
  assert.match(notifications[1].message, /Bus: Uses Bus 8 location/);
  assert.match(notifications[1].message, /Stops: Uses Bus 3 stops/);
  assert.ok(notifications.every(({ new_preview }) => new_preview === "8"));
});

test("spare bus eligibility counts assigned, route-source, and location buses as in use", () => {
  const inUse = getInUseLocationBusIds(
    ["member", "spare"],
    "PLAN B",
    [
      {
        plan_name: "PLAN B",
        root_bus_id: "root",
        location_bus_id: "spare",
        member_bus_ids: ["member"],
      },
    ],
  );

  assert.deepEqual([...inUse].sort(), ["member", "root", "spare"]);
});

test("normalizes imported stop times and rejects malformed values", () => {
  assert.equal(normalizeArrivalTime("8:10AM"), "8:10AM");
  assert.equal(normalizeArrivalTime("08:10am"), "8:10AM");
  assert.throws(() => normalizeArrivalTime("8:10 AM"), /format/i);
  assert.throws(() => normalizeArrivalTime("13:10PM"), /format/i);
});
