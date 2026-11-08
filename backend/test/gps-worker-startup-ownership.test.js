"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

function createOwnership({ renew = async () => true, onRelease = () => {} } = {}) {
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
    renew,
    async release() {
      onRelease();
      return true;
    },
  };
}

async function createStartupHarness({ mode, activate, workerStart } = {}) {
  const servicesPath = require.resolve("../src/services/startServices");
  const cachedServicesModule = require.cache[servicesPath];
  const originalLoad = Module._load;
  const originalLog = console.log;
  const originalError = console.error;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const envNames = ["NODE_ENV", "TEST_ENVIRONMENT", "NODE_TEST_CONTEXT"];
  const originalEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  const events = [];
  const activation = activate || (async () => createOwnership());
  let renewalCallback;
  let retryCallback;
  let workerLease;

  process.env.NODE_ENV = "development";
  delete process.env.TEST_ENVIRONMENT;
  delete process.env.NODE_TEST_CONTEXT;
  global.setTimeout = (callback) => {
    retryCallback = callback;
    return { unref() {} };
  };
  global.clearTimeout = () => {};
  global.setInterval = (callback) => {
    renewalCallback = callback;
    return { unref() {} };
  };
  global.clearInterval = () => {};
  console.log = () => {};
  console.error = () => {};

  Module._load = function (request, parent, isMain) {
    if (parent?.filename === servicesPath && request === "../config/startup") {
      return { waitForDbReady: async () => true };
    }
    if (parent?.filename === servicesPath && request === "./gpsWorkerOwnership") {
      return {
        getGpsWorkerLeaseTtlMs: () => 90_000,
        activateGpsWorkerOwnership: activation,
      };
    }
    if (parent?.filename === servicesPath && request === "../workers/gpsSyncWorker") {
      return {
        setLeaseGuard(lease) {
          workerLease = lease;
          events.push(lease ? "lease-installed" : "lease-cleared");
        },
        start() {
          events.push("worker-started");
          workerStart?.(workerLease);
        },
        async stop() {
          events.push("worker-stopped");
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[servicesPath];

  try {
    const services = require(servicesPath);
    const start = () =>
      services.startDbDependentServices({
        env: { NODE_ENV: "development", SOCKET_IO_MODE: mode },
        activateGpsWorkerOwnership: async () => {
          events.push("ownership-requested");
          return activation();
        },
        createGpsLocationPublisher: () => ({
          start() {
            events.push("publisher-started");
          },
          async stop() {
            events.push("publisher-stopped");
          },
        }),
        publishGpsLocationEvent: async () => ({ brokerAccepted: false }),
        getSocketClusterStatus: () => ({ state: "ready" }),
      });

    return {
      events,
      start,
      stop: () => services.stopDbDependentServices(),
      getRenewalCallback: () => renewalCallback,
      getRetryCallback: () => retryCallback,
      dispose: async () => {
        try {
          await services.stopDbDependentServices();
        } finally {
          Module._load = originalLoad;
          global.setTimeout = originalSetTimeout;
          global.clearTimeout = originalClearTimeout;
          global.setInterval = originalSetInterval;
          global.clearInterval = originalClearInterval;
          console.log = originalLog;
          console.error = originalError;
          for (const [name, value] of originalEnv) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
          }
          delete require.cache[servicesPath];
          if (cachedServicesModule) require.cache[servicesPath] = cachedServicesModule;
        }
      },
    };
  } catch (error) {
    Module._load = originalLoad;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    console.log = originalLog;
    console.error = originalError;
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    delete require.cache[servicesPath];
    if (cachedServicesModule) require.cache[servicesPath] = cachedServicesModule;
    throw error;
  }
}

for (const mode of ["single-instance", "redis"]) {
  test(`${mode} starts the GPS worker only after MongoDB ownership is installed`, async () => {
    const ownership = createOwnership();
    const harness = await createStartupHarness({
      mode,
      activate: async () => ownership,
      workerStart(lease) {
        assert.equal(lease, ownership);
      },
    });
    try {
      await harness.start();
      assert.deepEqual(
        harness.events.filter((event) =>
          ["ownership-requested", "lease-installed", "worker-started"].includes(event),
        ),
        ["ownership-requested", "lease-installed", "worker-started"],
      );
      await harness.stop();
    } finally {
      await harness.dispose();
    }
  });
}

test("failed MongoDB ownership acquisition prevents GPS worker startup", async () => {
  const harness = await createStartupHarness({
    mode: "single-instance",
    activate: async () => {
      throw new Error("simulated ownership acquisition failure");
    },
  });
  try {
    await harness.start();
    assert.equal(harness.events.includes("worker-started"), false);
    assert.equal(typeof harness.getRetryCallback(), "function");
  } finally {
    await harness.dispose();
  }
});

test("MongoDB renewal rejection stops the worker and releases its acquired lease", async () => {
  let releases = 0;
  const ownership = createOwnership({
    renew: async () => false,
    onRelease: () => {
      releases++;
    },
  });
  const harness = await createStartupHarness({
    mode: "single-instance",
    activate: async () => ownership,
  });
  try {
    await harness.start();
    await harness.getRenewalCallback()();
    assert.ok(harness.events.indexOf("worker-stopped") > harness.events.indexOf("worker-started"));
    assert.equal(releases, 1);
    assert.equal(harness.events.at(-1), "lease-cleared");
  } finally {
    await harness.dispose();
  }
});

test("shutdown releases only the ownership acquired by the active startup", async () => {
  let firstOwnerReleases = 0;
  const ownership = createOwnership({
    onRelease: () => {
      firstOwnerReleases++;
    },
  });
  const harness = await createStartupHarness({
    mode: "single-instance",
    activate: async () => ownership,
  });
  try {
    await harness.start();
    await harness.stop();
    assert.equal(firstOwnerReleases, 1);
  } finally {
    await harness.dispose();
  }
});

test("worker start failure cleans up its own lease without leaving a second worker", async () => {
  let releases = 0;
  let starts = 0;
  const ownership = createOwnership({
    onRelease: () => {
      releases++;
    },
  });
  const harness = await createStartupHarness({
    mode: "single-instance",
    activate: async () => ownership,
    workerStart() {
      starts++;
      throw new Error("simulated worker start failure");
    },
  });
  try {
    await harness.start();
    assert.equal(starts, 1);
    assert.equal(releases, 1);
    assert.equal(typeof harness.getRetryCallback(), "function");
    assert.equal(harness.events.filter((event) => event === "worker-started").length, 1);
  } finally {
    await harness.dispose();
  }
});
