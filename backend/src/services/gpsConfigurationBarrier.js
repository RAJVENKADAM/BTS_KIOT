"use strict";

let singleInstanceConfigVersion = 0n;
let singleInstanceQueue = Promise.resolve();

// This queue coordinates one process only; single-instance mode must use one backend process.
function isSingleInstanceMode(env) {
  const mode =
    env.SOCKET_IO_MODE ||
    (env.NODE_ENV === "production" ? "" : "single-instance");
  return mode === "single-instance";
}

function withSingleInstanceLock(operation) {
  const result = singleInstanceQueue.then(operation, operation);
  singleInstanceQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function assertSingleInstanceMode(env) {
  if (!isSingleInstanceMode(env)) {
    throw new Error("Process-local GPS configuration fencing requires single-instance mode.");
  }
}

async function runGpsConfigurationMutation(operation) {
  const { runGpsConfigurationTransaction } = require("./gpsWorkerOwnership");
  return runGpsConfigurationTransaction(operation);
}

async function captureSingleInstanceGpsConfigurationVersion({ env = process.env } = {}) {
  assertSingleInstanceMode(env);
  return withSingleInstanceLock(() => singleInstanceConfigVersion);
}

async function runSingleInstanceGpsPersistence(
  expectedConfigVersion,
  operation,
  { env = process.env } = {},
) {
  assertSingleInstanceMode(env);
  if (typeof expectedConfigVersion !== "bigint" || expectedConfigVersion < 0n) {
    throw new Error("Single-instance GPS configuration version is invalid.");
  }
  return withSingleInstanceLock(async () => {
    if (singleInstanceConfigVersion !== expectedConfigVersion) {
      const error = new Error("GPS configuration changed during the worker cycle.");
      error.code = "GPS_CONFIGURATION_CHANGED";
      error.gpsConfigurationError = true;
      throw error;
    }
    return operation();
  });
}

module.exports = {
  captureSingleInstanceGpsConfigurationVersion,
  runGpsConfigurationMutation,
  runSingleInstanceGpsPersistence,
};
