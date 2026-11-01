const assert = require("node:assert/strict");
const { test } = require("node:test");
const groupBusNumberRecords = require("../src/utils/groupBusNumberRecords");

test("groups zero-padded single-digit bus numbers under the canonical record", () => {
  const buses = [
    { _id: "legacy", bus_no: "02" },
    { _id: "canonical", bus_no: "2" },
    { _id: "unrelated", bus_no: "12" },
  ];

  const groups = groupBusNumberRecords(buses);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].canonicalBusNo, "2");
  assert.equal(groups[0].keeper._id, "canonical");
  assert.deepEqual(groups[0].duplicates.map((bus) => bus._id), ["legacy"]);
});

test("migrates a lone zero-padded number but leaves other buses unchanged", () => {
  const groups = groupBusNumberRecords([
    { _id: "legacy", bus_no: "05" },
    { _id: "zero", bus_no: "00" },
    { _id: "ten", bus_no: "10" },
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].canonicalBusNo, "5");
  assert.equal(groups[0].keeper._id, "legacy");
  assert.deepEqual(groups[0].duplicates, []);
});
