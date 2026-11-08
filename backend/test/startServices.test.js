const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

function allowMockedWorkerStartup() {
  const names = ["NODE_ENV", "TEST_ENVIRONMENT", "NODE_TEST_CONTEXT"];
  const original = new Map(names.map((name) => [name, process.env[name]]));
  process.env.NODE_ENV = "development";
  delete process.env.TEST_ENVIRONMENT;
  delete process.env.NODE_TEST_CONTEXT;
  return () => {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function createMockOwnership(onRelease = () => {}) {
  return {
    fencingToken: 1n,
    ttlMs: 90_000,
    async assertOwned() {
      return true;
    },
    async getConfigurationVersion() {
      return 0n;
    },
    async runTransaction(operation) {
      return operation(null);
    },
    async renew() {
      return true;
    },
    async release() {
      onRelease();
      return true;
    },
  };
}

test("GPS worker starts only after database readiness succeeds", async () => {
  const servicesPath = require.resolve("../src/services/startServices");
  const cachedServicesModule = require.cache[servicesPath];
  const originalLoad = Module._load;
  const originalLog = console.log;
  const originalError = console.error;
  const readinessResolvers = [];
  let workerStarts = 0;
  let ownershipActivations = 0;
  let publisherStarts = 0;
  let publisherStops = 0;
  let ownershipReleases = 0;
  const options = {
    activateGpsWorkerOwnership: async () => {
      ownershipActivations++;
      return createMockOwnership(() => ownershipReleases++);
    },
    createGpsLocationPublisher: () => ({
      start() {
        publisherStarts++;
      },
      async stop() {
        publisherStops++;
      },
    }),
  };
  const restoreTestEnvironment = allowMockedWorkerStartup();

  Module._load = function (request, parent, isMain) {
    if (parent?.filename === servicesPath && request === "../config/startup") {
      return {
        waitForDbReady: () =>
          new Promise((resolve) => readinessResolvers.push(resolve)),
      };
    }
    if (parent?.filename === servicesPath && request === "../workers/gpsSyncWorker") {
      return {
        setLeaseGuard() {},
        start: () => workerStarts++,
        async stop() {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[servicesPath];
  console.log = () => {};
  console.error = () => {};

  try {
    const { startDbDependentServices } = require(servicesPath);

    const notReady = startDbDependentServices(options);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(workerStarts, 0);
    const duplicateWhileWaiting = startDbDependentServices(options);
    assert.equal(readinessResolvers.length, 1);
    readinessResolvers.shift()(false);
    await Promise.all([notReady, duplicateWhileWaiting]);
    assert.equal(workerStarts, 0);
    assert.equal(ownershipActivations, 0);

    const ready = startDbDependentServices(options);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(workerStarts, 0);
    readinessResolvers.shift()(true);
    await ready;
    assert.equal(workerStarts, 1);
    assert.equal(ownershipActivations, 1);
    assert.equal(publisherStarts, 1);
    await require(servicesPath).stopDbDependentServices();
    assert.equal(ownershipReleases, 1);
    assert.equal(publisherStops, 1);
  } finally {
    Module._load = originalLoad;
    console.log = originalLog;
    console.error = originalError;
    restoreTestEnvironment();
    delete require.cache[servicesPath];
    if (cachedServicesModule) require.cache[servicesPath] = cachedServicesModule;
  }
});

test("local integration startup does not load or start the GPS worker", async () => {
  const servicesPath = require.resolve("../src/services/startServices");
  const cachedServicesModule = require.cache[servicesPath];
  const originalLoad = Module._load;
  const originalLog = console.log;
  let gpsWorkerLoads = 0;
  let publisherStarts = 0;
  const restoreTestEnvironment = allowMockedWorkerStartup();
  process.env.TEST_ENVIRONMENT = "local-integration";

  Module._load = function (request, parent, isMain) {
    if (parent?.filename === servicesPath && request === "../config/startup") {
      return { waitForDbReady: async () => true };
    }
    if (parent?.filename === servicesPath && request === "../workers/gpsSyncWorker") {
      gpsWorkerLoads++;
      return { start() {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[servicesPath];
  console.log = () => {};

  try {
    const { startDbDependentServices, stopDbDependentServices } =
      require(servicesPath);

    await startDbDependentServices({
      startGpsWorker: false,
      createGpsLocationPublisher: () => ({
        start() {
          publisherStarts++;
        },
        async stop() {},
      }),
    });
    assert.equal(gpsWorkerLoads, 0);
    assert.equal(publisherStarts, 1);
    await stopDbDependentServices();
  } finally {
    Module._load = originalLoad;
    console.log = originalLog;
    restoreTestEnvironment();
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
  let publisherStops = 0;
  const restoreTestEnvironment = allowMockedWorkerStartup();

  Module._load = function (request, parent, isMain) {
    if (parent?.filename === servicesPath && request === "../config/startup") {
      return { waitForDbReady: async () => true };
    }
    if (parent?.filename === servicesPath && request === "../workers/gpsSyncWorker") {
      return {
        setLeaseGuard() {},
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

    const options = {
      activateGpsWorkerOwnership: async () => createMockOwnership(),
      createGpsLocationPublisher: () => ({
        start() {},
        async stop() {
          publisherStops++;
        },
      }),
    };
    await startDbDependentServices(options);
    assert.equal(startAttempts, 1);
    assert.equal(stopAttempts, 1);
    assert.equal(timerActive, false);

    await startDbDependentServices(options);
    assert.equal(startAttempts, 2);
    assert.equal(timerActive, true);

    await startDbDependentServices(options);
    assert.equal(startAttempts, 2);
    assert.equal(timerActive, true);
    await require(servicesPath).stopDbDependentServices();
    assert.equal(publisherStops, 1);
  } finally {
    Module._load = originalLoad;
    console.log = originalLog;
    console.error = originalError;
    restoreTestEnvironment();
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
  let publisherStops = 0;
  const options = {
    activateGpsWorkerOwnership: async () => createMockOwnership(),
    createGpsLocationPublisher: () => ({
      start() {},
      async stop() {
        publisherStops++;
      },
    }),
  };
  const restoreTestEnvironment = allowMockedWorkerStartup();

  Module._load = function (request, parent, isMain) {
    if (parent?.filename === servicesPath && request === "../config/startup") {
      return {
        waitForDbReady: () =>
          new Promise((resolve) => readinessResolvers.push(resolve)),
      };
    }
    if (parent?.filename === servicesPath && request === "../workers/gpsSyncWorker") {
      return {
        setLeaseGuard() {},
        start: () => workerStarts++,
        async stop() {},
      };
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

    const initialStart = startDbDependentServices(options);
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
    assert.equal(publisherStops, 1);
  } finally {
    Module._load = originalLoad;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    console.log = originalLog;
    console.error = originalError;
    restoreTestEnvironment();
    delete require.cache[servicesPath];
    if (cachedServicesModule) require.cache[servicesPath] = cachedServicesModule;
  }
});
