const assert = require("node:assert/strict");
const { test } = require("node:test");
const normalizeReplacementAssignments = require("../src/utils/normalizeReplacementAssignments");

const riders = [{ _id: "rider-1" }, { _id: "rider-2" }];
const allowedBusNos = new Set(["BUS-1", "BUS-3"]);

test("requires exactly one allowed assignment per replacement-bus rider", () => {
  const assignments = normalizeReplacementAssignments(
    [
      { userId: "rider-1", busNo: "bus-1" },
      { userId: "rider-2", busNo: null },
    ],
    riders,
    allowedBusNos,
  );

  assert.deepEqual([...assignments], [
    ["rider-1", "BUS-1"],
    ["rider-2", null],
  ]);
});

test("rejects missing, duplicate, unknown, and unavailable rider assignments", () => {
  assert.throws(
    () => normalizeReplacementAssignments([], riders, allowedBusNos),
    /Every active replacement-bus rider/,
  );
  assert.throws(
    () => normalizeReplacementAssignments(
      [
        { userId: "rider-1", busNo: "BUS-1" },
        { userId: "rider-1", busNo: "BUS-3" },
      ],
      riders,
      allowedBusNos,
    ),
    /rider list changed/,
  );
  assert.throws(
    () => normalizeReplacementAssignments(
      [
        { userId: "rider-1", busNo: "BUS-1" },
        { userId: "unknown", busNo: "BUS-3" },
      ],
      riders,
      allowedBusNos,
    ),
    /rider list changed/,
  );
  assert.throws(
    () => normalizeReplacementAssignments(
      [
        { userId: "rider-1", busNo: "BUS-9" },
        { userId: "rider-2", busNo: null },
      ],
      riders,
      allowedBusNos,
    ),
    /Choose the original bus/,
  );
});
