"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { buildReadiness } = require("../src/utils/readiness");
const {
  closeSocketServices,
  createSocketCluster,
  getSharedServiceConfig,
} = require("../src/config/sharedServices");

function createRedisFixture({
  fail = null,
  publish = async () => 1,
} = {}) {
  const clients = [];
  const adapters = [];
  let publisherClient = null;
  const io = {
    adapter: (adapter) => adapters.push(adapter),
    to() {
      return {
        emit() {
          return publisherClient.publish("socket.io#test", Buffer.from("event"));
        },
      };
    },
  };
  class Client extends EventEmitter {
    constructor(name) {
      super();
      this.name = name;
      this.isReady = false;
      this.isOpen = false;
      this.quitCalls = 0;
      this.closeCalls = 0;
      clients.push(this);
    }

    duplicate() {
      return new Client("subscriber");
    }

    async connect() {
      if (fail === this.name) throw new Error(`${this.name} connect failed`);
      this.isOpen = true;
      this.isReady = true;
      this.emit("ready");
    }

    publish(...args) {
      return publish(...args);
    }

    async quit() {
      this.quitCalls += 1;
      this.closeCalls += 1;
      this.isOpen = false;
      this.isReady = false;
    }

    disconnect() {
      this.closeCalls += 1;
    }
  }
  const createClient = () => {
    publisherClient = new Client("publisher");
    return publisherClient;
  };
  return {
    io,
    clients,
    adapters,
    options: {
      env: {
        NODE_ENV: "production",
        SOCKET_IO_MODE: "redis",
        SOCKET_IO_REDIS_URL: "redis://redis.example.invalid:6379",
      },
      loadDependencies: () => ({
        createClient,
        createAdapter: (publisher, subscriber) => ({
          publisher,
          subscriber,
        }),
      }),
      logger: () => {},
    },
  };
}

test("Redis publisher and subscriber connect before cluster readiness is reported", async () => {
  const fixture = createRedisFixture();
  const cluster = createSocketCluster(fixture.io, fixture.options);
  assert.equal(cluster.getStatus().state, "connecting");
  await cluster.ready;
  assert.equal(cluster.getStatus().enabled, true);
  assert.equal(cluster.getStatus().state, "ready");
  assert.equal(fixture.adapters.length, 1);
  assert.equal(fixture.clients.length, 2);
});

test("Redis event publication awaits the adapter Redis publish command", async () => {
  let publishFinished = false;
  const fixture = createRedisFixture({
    publish: async () => {
      await Promise.resolve();
      publishFinished = true;
      return 1;
    },
  });
  const cluster = createSocketCluster(fixture.io, fixture.options);
  await cluster.ready;

  const result = await cluster.publishSocketEvent(
    ["preview_4"],
    "locationUpdate",
    { eventId: "bus-1:7" },
  );

  assert.equal(publishFinished, true);
  assert.deepEqual(result, { brokerAccepted: true });
});

test("asynchronous Redis publish failures reject the publication boundary", async () => {
  const fixture = createRedisFixture({
    publish: async () => {
      throw new Error("asynchronous Redis failure");
    },
  });
  const cluster = createSocketCluster(fixture.io, fixture.options);
  await cluster.ready;

  await assert.rejects(
    cluster.publishSocketEvent(["preview_4"], "locationUpdate", {}),
    /asynchronous Redis failure/,
  );
});

test("zero Redis adapter subscribers do not count as broker acceptance", async () => {
  const fixture = createRedisFixture({ publish: async () => 0 });
  const cluster = createSocketCluster(fixture.io, fixture.options);
  await cluster.ready;

  await assert.rejects(
    cluster.publishSocketEvent(["preview_4"], "locationUpdate", {}),
    /accepted no adapter subscribers/,
  );
});

for (const failingClient of ["publisher", "subscriber"]) {
  test(`Redis ${failingClient} connection failure blocks readiness and startup`, async () => {
    const fixture = createRedisFixture({ fail: failingClient });
    const cluster = createSocketCluster(fixture.io, fixture.options);
    await assert.rejects(cluster.ready, /connect failed/);
    assert.equal(cluster.getStatus().enabled, false);
    assert.equal(cluster.getStatus().state, "failed");
    assert.equal(fixture.adapters.length, 0);
    assert.ok(fixture.clients.every((client) => client.closeCalls === 1));
  });
}

test("disconnection changes readiness and a recovered pair restores it", async () => {
  const fixture = createRedisFixture();
  const cluster = createSocketCluster(fixture.io, fixture.options);
  await cluster.ready;
  fixture.clients[0].isReady = false;
  fixture.clients[0].emit("end");
  assert.equal(cluster.getStatus().enabled, false);
  assert.equal(cluster.getStatus().state, "disconnected");
  assert.equal(
    buildReadiness({
      databaseReadyState: 1,
      gpsWorker: {},
      socketClients: 0,
      socketCluster: cluster.getStatus(),
    }).httpStatus,
    503,
  );

  fixture.clients[0].emit("reconnecting");
  assert.equal(cluster.getStatus().state, "recovering");
  fixture.clients[0].isReady = true;
  fixture.clients[0].emit("ready");
  fixture.clients[1].emit("ready");
  assert.equal(cluster.getStatus().enabled, true);
  assert.equal(cluster.getStatus().state, "ready");
  assert.equal(cluster.getConnectionGeneration(), 2);
});

test("graceful shutdown closes both Redis clients once and updates status", async () => {
  const fixture = createRedisFixture();
  const cluster = createSocketCluster(fixture.io, fixture.options);
  await cluster.ready;
  await cluster.close();
  await cluster.close();
  assert.deepEqual(fixture.clients.map((client) => client.quitCalls), [1, 1]);
  assert.equal(cluster.getStatus().enabled, false);
  assert.equal(cluster.getStatus().state, "closed");
});

test("graceful Socket.IO shutdown closes transports before shared Redis clients", async () => {
  const operations = [];
  await closeSocketServices(
    {
      close(callback) {
        operations.push("io");
        callback();
      },
    },
    {
      async close() {
        operations.push("redis");
      },
    },
  );
  assert.deepEqual(operations, ["io", "redis"]);
});

test("missing Redis packages fail explicitly instead of using the memory adapter", async () => {
  const fixture = createRedisFixture();
  const cluster = createSocketCluster(fixture.io, {
    ...fixture.options,
    loadDependencies: () => {
      throw new Error("Redis packages unavailable");
    },
  });
  await assert.rejects(cluster.ready, /Redis packages unavailable/);
  assert.equal(cluster.getStatus().enabled, false);
  assert.equal(cluster.getStatus().state, "failed");
  assert.equal(fixture.adapters.length, 0);
});

test("single-instance mode is explicit outside production and does not load Redis", async () => {
  const fixture = createRedisFixture();
  const cluster = createSocketCluster(fixture.io, {
    env: { NODE_ENV: "development", SOCKET_IO_MODE: "single-instance" },
    loadDependencies: () => {
      throw new Error("Redis must not be loaded.");
    },
  });
  await cluster.ready;
  assert.deepEqual(cluster.getStatus(), {
    mode: "single-instance",
    gpsDeviceRegistryMode: "legacy",
    state: "disabled",
    enabled: false,
    reason: "Single-instance mode is explicitly selected.",
  });
  assert.equal(fixture.adapters.length, 0);
});

test("production requires an explicit socket mode and Redis mode requires a URL", () => {
  assert.throws(
    () => getSharedServiceConfig({ NODE_ENV: "production" }),
    /SOCKET_IO_MODE/,
  );
  assert.throws(
    () => getSharedServiceConfig({
      NODE_ENV: "production",
      SOCKET_IO_MODE: "redis",
    }),
    /requires SOCKET_IO_REDIS_URL or REDIS_URL/,
  );
  assert.equal(
    getSharedServiceConfig({
      NODE_ENV: "production",
      SOCKET_IO_MODE: "single-instance",
    }).mode,
    "single-instance",
  );
});
