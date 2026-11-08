"use strict";

const ownershipService = require("../../src/services/gpsWorkerOwnership");

function mockGpsOwnershipTransactions() {
  const original = ownershipService.runGpsConfigurationTransaction;
  let calls = 0;
  ownershipService.runGpsConfigurationTransaction = async (operation) => {
    calls += 1;
    return operation(null);
  };
  return {
    get calls() {
      return calls;
    },
    restore() {
      ownershipService.runGpsConfigurationTransaction = original;
    },
  };
}

module.exports = { mockGpsOwnershipTransactions };
