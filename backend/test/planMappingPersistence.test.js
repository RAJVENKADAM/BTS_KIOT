"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const PlanMapping = require("../src/models/PlanMapping");
const ownershipService = require("../src/services/gpsWorkerOwnership");
const {
  deletePlanMappingById,
  persistPlanMappingOperations,
} = require("../src/services/planMappingPersistence");

test("PlanMapping create, update, and delete use the GPS barrier in both modes", async () => {
  const originalMode = process.env.SOCKET_IO_MODE;
  const originalTransaction = ownershipService.runGpsConfigurationTransaction;
  const originalBulkWrite = PlanMapping.bulkWrite;
  const originalDeleteOne = PlanMapping.deleteOne;

  try {
    for (const mode of ["single-instance", "redis"]) {
      process.env.SOCKET_IO_MODE = mode;
      const session = { mode };
      const bulkWrites = [];
      const deletes = [];
      let transactionCalls = 0;
      ownershipService.runGpsConfigurationTransaction = async (operation) => {
        transactionCalls += 1;
        return operation(session);
      };
      PlanMapping.bulkWrite = async (operations, options) => {
        bulkWrites.push({ operations, options });
        return { acknowledged: true };
      };
      PlanMapping.deleteOne = async (filter, options) => {
        deletes.push({ filter, options });
        return { deletedCount: 1 };
      };

      await persistPlanMappingOperations([
        {
          updateOne: {
            filter: { _id: "new-mapping" },
            update: { $set: { location_bus_id: "bus-a" } },
            upsert: true,
          },
        },
      ]);
      await persistPlanMappingOperations([
        {
          updateOne: {
            filter: { _id: "existing-mapping" },
            update: { $set: { location_bus_id: "bus-b" } },
          },
        },
      ]);
      await deletePlanMappingById("existing-mapping");

      assert.equal(bulkWrites.length, 2);
      assert.equal(deletes.length, 1);
      assert.deepEqual(deletes[0].filter, { _id: "existing-mapping" });
      assert.equal(transactionCalls, 3);
      assert.equal(bulkWrites[0].options.session, session);
      assert.equal(bulkWrites[1].options.session, session);
      assert.equal(deletes[0].options.session, session);
    }
  } finally {
    PlanMapping.bulkWrite = originalBulkWrite;
    PlanMapping.deleteOne = originalDeleteOne;
    ownershipService.runGpsConfigurationTransaction = originalTransaction;
    if (originalMode === undefined) delete process.env.SOCKET_IO_MODE;
    else process.env.SOCKET_IO_MODE = originalMode;
  }
});
