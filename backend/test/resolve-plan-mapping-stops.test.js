const assert = require("node:assert/strict");
const test = require("node:test");
const StopMaster = require("../src/models/StopMaster");
const resolvePlanMappingStops = require("../src/utils/resolvePlanMappingStops");

test("resolves route stop IDs, verified aliases, and exact pending names in one read", async () => {
  const originalFind = StopMaster.find;
  const records = [
    { stopId: "VERIFIED-1", name: "Main Gate", aliases: ["Front Gate"], status: "VERIFIED" },
    { stopId: "PENDING-1", name: "Temporary Stop", aliases: [], status: "PENDING" },
    { stopId: "ID-STOP", name: "Stop By ID", aliases: [], status: "PENDING" },
  ];
  let queries = 0;
  StopMaster.find = (filter) => {
    queries += 1;
    assert.equal(filter.$or.length, 3);
    return {
      select: () => ({ lean: async () => records }),
    };
  };

  try {
    const resolved = await resolvePlanMappingStops([
      { stopName: "Front Gate" },
      { stopName: "Temporary Stop" },
      { stopId: "ID-STOP", stopName: "Stop By ID" },
    ]);

    assert.equal(queries, 1);
    assert.deepEqual(
      resolved.map(({ stop, ambiguous }) => [stop?.stopId || null, ambiguous]),
      [
        ["VERIFIED-1", false],
        ["PENDING-1", false],
        ["ID-STOP", false],
      ],
    );
  } finally {
    StopMaster.find = originalFind;
  }
});

test("preserves ambiguity rejection for duplicate verified aliases", async () => {
  const originalFind = StopMaster.find;
  StopMaster.find = () => ({
    select: () => ({
      lean: async () => [
        { stopId: "ONE", name: "North Gate", aliases: [], status: "VERIFIED" },
        { stopId: "TWO", name: "Second Stop", aliases: ["North Gate"], status: "VERIFIED" },
      ],
    }),
  });

  try {
    assert.deepEqual(await resolvePlanMappingStops([{ stopName: "North Gate" }]), [
      { stop: null, ambiguous: true },
    ]);
  } finally {
    StopMaster.find = originalFind;
  }
});
