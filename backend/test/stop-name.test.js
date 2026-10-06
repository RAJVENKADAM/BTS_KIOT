const assert = require("node:assert/strict");
const test = require("node:test");
const normalizeStopName = require("../src/utils/normalizeStopName");

test("normalizes stop names case-insensitively and collapses whitespace", () => {
  assert.equal(normalizeStopName("  North  bus stop "), "NORTH BUS STOP");
  assert.equal(
    normalizeStopName("north BUS   stop"),
    normalizeStopName("NORTH bus stop"),
  );
});
