"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const ownershipService = require("../src/services/gpsWorkerOwnership");
const {
  runGpsConfigurationMutation,
} = require("../src/services/gpsConfigurationBarrier");

test("single-instance GPS administration uses the MongoDB ownership transaction", async () => {
  const original = ownershipService.runGpsConfigurationTransaction;
  let transactionCalls = 0;
  const session = { transaction: true };
  let callbackSession;
  ownershipService.runGpsConfigurationTransaction = async (operation) => {
    transactionCalls++;
    return operation(session);
  };
  try {
    const result = await runGpsConfigurationMutation(
      async (receivedSession) => {
        callbackSession = receivedSession;
        return "saved";
      },
      { env: { SOCKET_IO_MODE: "single-instance" } },
    );
    assert.equal(result, "saved");
    assert.equal(callbackSession, session);
    assert.equal(transactionCalls, 1);
  } finally {
    ownershipService.runGpsConfigurationTransaction = original;
  }
});

test("Redis-mode GPS administration receives the MongoDB transaction session", async () => {
  const original = ownershipService.runGpsConfigurationTransaction;
  const session = { transaction: true };
  let callbackSession;
  ownershipService.runGpsConfigurationTransaction = async (operation) =>
    operation(session);
  try {
    const result = await runGpsConfigurationMutation(
      async (receivedSession) => {
        callbackSession = receivedSession;
        return "saved";
      },
      { env: { SOCKET_IO_MODE: "redis" } },
    );
    assert.equal(result, "saved");
    assert.equal(callbackSession, session);
  } finally {
    ownershipService.runGpsConfigurationTransaction = original;
  }
});

test("GPS configuration mutation delegates to MongoDB in either socket mode", async () => {
  const original = ownershipService.runGpsConfigurationTransaction;
  const modes = ["single-instance", "redis"];
  const receivedModes = [];
  ownershipService.runGpsConfigurationTransaction = async (operation) => {
    receivedModes.push(operation);
    return operation({ transaction: true });
  };
  try {
    for (const mode of modes) {
      let callbackSession;
      await runGpsConfigurationMutation(
        async (session) => {
          callbackSession = session;
        },
        { env: { SOCKET_IO_MODE: mode } },
      );
      assert.deepEqual(callbackSession, { transaction: true });
    }
    assert.equal(receivedModes.length, modes.length);
  } finally {
    ownershipService.runGpsConfigurationTransaction = original;
  }
});
