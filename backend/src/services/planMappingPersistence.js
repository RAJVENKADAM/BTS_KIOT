"use strict";

const PlanMapping = require("../models/PlanMapping");
const { runGpsConfigurationMutation } = require("./gpsConfigurationBarrier");

function persistPlanMappingOperations(operations) {
  return runGpsConfigurationMutation((session) =>
    PlanMapping.bulkWrite(operations, {
      ordered: true,
      ...(session ? { session } : {}),
    }),
  );
}

function deletePlanMappingById(id) {
  return runGpsConfigurationMutation((session) =>
    PlanMapping.deleteOne(
      { _id: id },
      session ? { session } : {},
    ),
  );
}

module.exports = {
  deletePlanMappingById,
  persistPlanMappingOperations,
};
