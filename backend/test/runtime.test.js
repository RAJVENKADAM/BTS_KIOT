"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createRuntime } = require("../src/runtime");

async function withNonTestEnvironment(action) {
  const names = ["NODE_ENV", "TEST_ENVIRONMENT", "NODE_TEST_CONTEXT"];
  const original = new Map(names.map((name) => [name, process.env[name]]));
  process.env.NODE_ENV = "development";
  delete process.env.TEST_ENVIRONMENT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    return await action();
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function createRuntimeFixture({
  socketReady = Promise.resolve(),
  env = { NODE_ENV: "test", SOCKET_IO_MODE: "single-instance" },
} = {}) {
  const operations = [];
  const server = {
    listening: false,
    once() {},
    close(callback) {
      operations.push("stop-http-admission");
      this.listening = false;
      callback();
    },
  };
  const io = {
    engine: { clientsCount: 0 },
    use() {
      operations.push("authenticate-socket");
    },
  };
  const cluster = {
    ready: socketReady,
    getStatus: () => ({
      mode: "single-instance",
      state: "disabled",
      enabled: false,
      reason: "Single-instance mode is explicitly selected.",
    }),
    async close() {
      operations.push("close-redis");
    },
  };
  const runtime = createRuntime({
    env,
    dependencies: {
      createApplication: () => {
        operations.push("construct-app");
        return () => {};
      },
      createHttpServer: () => {
        operations.push("construct-http-server");
        return server;
      },
      createSocketServer: () => {
        operations.push("construct-socket");
        return io;
      },
      createSocketAuthentication: () => () => {},
      socketModule: {
        setIO() {
          operations.push("set-socket");
        },
      },
      registerTrackSocketHandlers() {
        operations.push("register-socket-handlers");
      },
      jwt: {},
      configureSocketCluster() {
        operations.push("construct-cluster");
        return cluster;
      },
      listen: async () => {
        operations.push("listen");
        server.listening = true;
      },
      startBackgroundServices: async () => {
        operations.push("start-workers");
      },
      stopBackgroundServices: async () => {
        operations.push("stop-worker-scheduling");
      },
      stopGpsWorker: async () => {
        operations.push("await-active-worker");
      },
      closeSocketServices: async (_io, _cluster, options) => {
        assert.equal(options.httpServerCloseStarted, true);
        operations.push("close-sockets-and-redis");
      },
      disconnectDatabase: async () => {
        operations.push("close-database");
      },
      mongoose: { connection: { readyState: 0 } },
      getGpsWorker: () => ({ getStatus: () => ({ started: false }) }),
      logSafeError: (message, error) => {
        operations.push(`logged:${message}:${error.message}`);
      },
    },
  });
  return { operations, runtime, server };
}

test("runtime explicitly constructs and starts services in dependency order", async () => {
  await withNonTestEnvironment(async () => {
    const fixture = createRuntimeFixture({
      env: { NODE_ENV: "development", SOCKET_IO_MODE: "single-instance" },
    });
    await fixture.runtime.start();
    await Promise.resolve();

    assert.deepEqual(fixture.operations, [
      "construct-app",
      "construct-http-server",
      "construct-socket",
      "authenticate-socket",
      "set-socket",
      "register-socket-handlers",
      "construct-cluster",
      "listen",
      "start-workers",
    ]);
    assert.equal(fixture.server.listening, true);
    await fixture.runtime.shutdown("TEST");
  });
});

test("shutdown stops request admission before services and drains dependencies", async () => {
  const fixture = createRuntimeFixture();
  await fixture.runtime.start();
  await fixture.runtime.shutdown("TEST");

  assert.deepEqual(fixture.operations.slice(-5), [
    "stop-http-admission",
    "stop-worker-scheduling",
    "await-active-worker",
    "close-sockets-and-redis",
    "close-database",
  ]);
  assert.equal(fixture.server.listening, false);
});

test("Redis startup failure rejects startup and closes initialized resources", async () => {
  const fixture = createRuntimeFixture({
    socketReady: Promise.reject(new Error("Redis unavailable")),
  });
  await assert.rejects(fixture.runtime.start(), /Redis unavailable/);
  assert.equal(fixture.server.listening, false);
  assert.ok(fixture.operations.includes("stop-worker-scheduling"));
  assert.ok(fixture.operations.includes("close-sockets-and-redis"));
  assert.ok(fixture.operations.includes("close-database"));
});
