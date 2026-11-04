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
