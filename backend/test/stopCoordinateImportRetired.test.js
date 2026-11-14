"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const StopMaster = require("../src/models/StopMaster");
const { importCoordinates } = require("../src/controllers/stopMaster.controller");

test("retired stop-coordinate replacement returns 410 without database writes", async () => {
  const originalBulkWrite = StopMaster.bulkWrite;
  const originalDeleteMany = StopMaster.deleteMany;
  StopMaster.bulkWrite = async () => {
    throw new Error("Retired endpoint must not write stops.");
  };
  StopMaster.deleteMany = async () => {
    throw new Error("Retired endpoint must not delete stops.");
  };
  const response = {
    statusCode: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };

  try {
    await importCoordinates(
      { body: { stops: [{ name: "Synthetic Stop", latitude: 0, longitude: 0 }] } },
      response,
    );
    assert.equal(response.statusCode, 410);
    assert.equal(response.payload.code, "STOP_COORDINATE_IMPORT_RETIRED");
  } finally {
    StopMaster.bulkWrite = originalBulkWrite;
    StopMaster.deleteMany = originalDeleteMany;
  }
});
