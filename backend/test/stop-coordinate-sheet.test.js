const assert = require("node:assert/strict");
const test = require("node:test");
const uniqueStopCoordinateRows = require("../src/utils/uniqueStopCoordinateRows");

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
