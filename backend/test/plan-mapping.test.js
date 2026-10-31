const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getEffectiveBusId,
  findUncoveredAssignments,
  normalizeArrivalTime,
  validateCluster,
} = require("../src/utils/planMapping");
const {
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

test("plan changes notify only riders whose bus changes or becomes inactive", () => {
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
    ["user-member", true],
    ["user-inactive", false],
    ["user-deleted", false],
  ]);
  assert.match(notifications[0].message, /Use Bus 3/);
  assert.match(notifications[0].message, /View stops/);
  assert.equal(notifications[0].new_preview, "3");
  assert.match(notifications[1].message, /inactive today/);
  assert.match(notifications[2].message, /no longer available/);
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
  assert.match(notifications[0].message, /View stops/);
});

test("normalizes imported stop times and rejects malformed values", () => {
  assert.equal(normalizeArrivalTime("8:10AM"), "8:10AM");
  assert.equal(normalizeArrivalTime("08:10am"), "8:10AM");
  assert.throws(() => normalizeArrivalTime("8:10 AM"), /format/i);
  assert.throws(() => normalizeArrivalTime("13:10PM"), /format/i);
});
