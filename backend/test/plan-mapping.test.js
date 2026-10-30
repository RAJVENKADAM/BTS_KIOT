const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getEffectiveBusId,
  findUncoveredAssignments,
  normalizeArrivalTime,
  validateCluster,
} = require("../src/utils/planMapping");

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

test("normalizes imported stop times and rejects malformed values", () => {
  assert.equal(normalizeArrivalTime("8:10AM"), "8:10AM");
  assert.equal(normalizeArrivalTime("08:10am"), "8:10AM");
  assert.throws(() => normalizeArrivalTime("8:10 AM"), /format/i);
  assert.throws(() => normalizeArrivalTime("13:10PM"), /format/i);
});
