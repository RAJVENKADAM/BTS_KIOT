const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

test("GPS worker starts only after database readiness succeeds", async () => {
  const servicesPath = require.resolve("../src/services/startServices");
  const cachedServicesModule = require.cache[servicesPath];
  const originalLoad = Module._load;
  const originalLog = console.log;
  const originalError = console.error;
  const readinessResolvers = [];
  let workerStarts = 0;

  Module._load = function (request, parent, isMain) {
    if (parent?.filename === servicesPath && request === "../config/startup") {
      return {
        waitForDbReady: () =>
          new Promise((resolve) => readinessResolvers.push(resolve)),
      };
    }
    if (parent?.filename === servicesPath && request === "../workers/gpsSyncWorker") {
      return { start: () => workerStarts++ };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[servicesPath];
  console.log = () => {};
  console.error = () => {};

  try {
    const { startDbDependentServices } = require(servicesPath);

    const notReady = startDbDependentServices();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(workerStarts, 0);
    const duplicateWhileWaiting = startDbDependentServices();
    await duplicateWhileWaiting;
    assert.equal(readinessResolvers.length, 1);
    readinessResolvers.shift()(false);
    await notReady;
    assert.equal(workerStarts, 0);

    const ready = startDbDependentServices();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(workerStarts, 0);
    readinessResolvers.shift()(true);
    await ready;
    assert.equal(workerStarts, 1);
  } finally {
    Module._load = originalLoad;
    console.log = originalLog;
    console.error = originalError;
    delete require.cache[servicesPath];
    if (cachedServicesModule) require.cache[servicesPath] = cachedServicesModule;
  }
});

test("synchronous worker startup failure is cleaned up and can be retried", async () => {
  const servicesPath = require.resolve("../src/services/startServices");
  const cachedServicesModule = require.cache[servicesPath];
  const originalLoad = Module._load;
  const originalLog = console.log;
  const originalError = console.error;
  let startAttempts = 0;
  let stopAttempts = 0;
  let timerActive = false;

  Module._load = function (request, parent, isMain) {
    if (parent?.filename === servicesPath && request === "../config/startup") {
      return { waitForDbReady: async () => true };
    }
    if (parent?.filename === servicesPath && request === "../workers/gpsSyncWorker") {
      return {
        start() {
          startAttempts++;
          timerActive = true;
          if (startAttempts === 1) throw new Error("simulated startup failure");
        },
        async stop() {
          stopAttempts++;
          timerActive = false;
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[servicesPath];
  console.log = () => {};
  console.error = () => {};

  try {
    const { startDbDependentServices } = require(servicesPath);

    await startDbDependentServices();
    assert.equal(startAttempts, 1);
    assert.equal(stopAttempts, 1);
    assert.equal(timerActive, false);

    await startDbDependentServices();
    assert.equal(startAttempts, 2);
    assert.equal(timerActive, true);

    await startDbDependentServices();
    assert.equal(startAttempts, 2);
    assert.equal(timerActive, true);
  } finally {
    Module._load = originalLoad;
    console.log = originalLog;
    console.error = originalError;
    delete require.cache[servicesPath];
    if (cachedServicesModule) require.cache[servicesPath] = cachedServicesModule;
  }
});

test("database readiness failure schedules an automatic startup retry", async () => {
  const servicesPath = require.resolve("../src/services/startServices");
  const cachedServicesModule = require.cache[servicesPath];
  const originalLoad = Module._load;
  const originalLog = console.log;
  const originalError = console.error;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const readinessResolvers = [];
  let retryCallback;
  let workerStarts = 0;

  Module._load = function (request, parent, isMain) {
    if (parent?.filename === servicesPath && request === "../config/startup") {
      return {
        waitForDbReady: () =>
          new Promise((resolve) => readinessResolvers.push(resolve)),
      };
    }
    if (parent?.filename === servicesPath && request === "../workers/gpsSyncWorker") {
      return { start: () => workerStarts++ };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  global.setTimeout = (callback) => {
    retryCallback = callback;
    return { unref() {} };
  };
  global.clearTimeout = () => {};
  delete require.cache[servicesPath];
  console.log = () => {};
  console.error = () => {};

  try {
    const { startDbDependentServices, stopDbDependentServices } =
      require(servicesPath);

    const initialStart = startDbDependentServices();
    await new Promise((resolve) => setImmediate(resolve));
    readinessResolvers.shift()(false);
    await initialStart;
    assert.equal(typeof retryCallback, "function");

    retryCallback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(readinessResolvers.length, 1);
    readinessResolvers.shift()(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(workerStarts, 1);
    await stopDbDependentServices();
  } finally {
    Module._load = originalLoad;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    console.log = originalLog;
    console.error = originalError;
    delete require.cache[servicesPath];
    if (cachedServicesModule) require.cache[servicesPath] = cachedServicesModule;
  }
});
