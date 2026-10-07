const assert = require("node:assert/strict");
const test = require("node:test");
const uniqueStopCoordinateRows = require("../src/utils/uniqueStopCoordinateRows");
const buildStopCoordinateOperations = require("../src/utils/buildStopCoordinateOperations");

test("exports each stop name once regardless of casing and whitespace", () => {
  const rows = uniqueStopCoordinateRows([
    { stopId: "STOP-1", name: "North Stop", latitude: null, longitude: null },
    {
      stopId: "STOP-2",
      name: " north   stop ",
      latitude: 11.5,
      longitude: 78.2,
      status: "VERIFIED",
    },
    { stopId: "STOP-3", name: "South Stop", latitude: null, longitude: null },
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].stopId, "STOP-2");
  assert.equal(rows[1].name, "South Stop");
});

test("upserts only the stops present in the replacement sheet", () => {
  const verifiedAt = new Date("2026-10-07T00:00:00.000Z");
  const operations = buildStopCoordinateOperations(
    [
      {
        stopId: "STOP-1",
        name: "North Stop",
        latitude: 11.5,
        longitude: 78.2,
      },
      {
        stopId: "STOP-NEW",
        name: "New Stop",
        latitude: null,
        longitude: null,
      },
    ],
    "admin-id",
    verifiedAt,
  );

  assert.equal(operations.length, 2);
  assert.deepEqual(operations[0], {
    updateOne: {
      filter: { stopId: "STOP-1" },
      update: {
        $set: {
          name: "North Stop",
          latitude: 11.5,
          longitude: 78.2,
          source: "ADMIN",
          status: "VERIFIED",
          verifiedBy: "admin-id",
          verifiedAt,
        },
        $setOnInsert: {
          stopId: "STOP-1",
          aliases: [],
        },
      },
      upsert: true,
    },
  });
  assert.deepEqual(operations[1], {
    updateOne: {
      filter: { stopId: "STOP-NEW" },
      update: {
        $set: {
          name: "New Stop",
          latitude: null,
          longitude: null,
          source: "EXISTING_STOP",
          status: "PENDING",
          verifiedBy: null,
          verifiedAt: null,
        },
        $setOnInsert: {
          stopId: "STOP-NEW",
          aliases: [],
        },
      },
      upsert: true,
    },
  });
});
