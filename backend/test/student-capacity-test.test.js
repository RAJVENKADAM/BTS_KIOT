"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  STAGES,
  assignVirtualClients,
  cleanupSockets,
  getStopReasons,
  summarizeLatencies,
  validateCapacityLimits,
  validateAccounts,
} = require("../load-tests/capacity-test-core.cjs");
const {
  loadConfiguration,
  plannedHttpRequests,
  runCapacityTest,
} = require("../load-tests/student-capacity-test");

function fixtures(count) {
  return Array.from({ length: count }, (_, index) => ({
    email: `test-${index + 1}@example.invalid`,
    password: `secret-${index + 1}`,
  }));
}

test("virtual assignment cycles through accounts without exposing identities in labels", () => {
  const clients = assignVirtualClients(fixtures(20), 500);
  assert.equal(clients.length, 500);
  assert.equal(new Set(clients.map(({ accountIndex }) => accountIndex)).size, 20);
  assert.equal(clients[0].label, "virtual-student-001");
  assert.equal(clients[20].label, "virtual-student-021");
  assert.equal(clients[20].accountIndex, clients[0].accountIndex);
  assert.deepEqual(STAGES, [20, 50, 100, 250, 500]);
});

test("fixture validation rejects duplicate account identities", () => {
  assert.throws(
    () => validateAccounts([{ email: "A@example.invalid", password: "x" }, { email: "a@example.invalid", password: "y" }]),
    /unique accounts/,
  );
});

test("latency summary uses nearest-rank percentiles", () => {
  assert.deepEqual(summarizeLatencies([1, 2, 3, 4, 5]), {
    count: 5,
    averageMs: 3,
    minMs: 1,
    p50Ms: 3,
    p90Ms: 5,
    p95Ms: 5,
    p99Ms: 5,
    maxMs: 5,
  });
});

test("stop thresholds include auth, server errors, socket failures, recovery, and readiness", () => {
  const reasons = getStopReasons({
    plannedClients: 100,
    authenticationAttempts: 100,
    authenticationFailures: 2,
    apiRequests: 100,
    api5xxErrors: 2,
    connectionFailures: 2,
    successfulSocketConnections: 100,
    unexpectedDisconnections: 2,
    reconnectionFailures: 3,
  }, "MongoDB unavailable");
  assert.equal(reasons.length, 6);
  assert.match(reasons.join(" "), /authentication failures/);
  assert.match(reasons.join(" "), /API 5xx/);
  assert.match(reasons.join(" "), /reconnection failures/);
  assert.match(reasons.join(" "), /MongoDB/);
});

test("production target cannot pass under formatting or confirmation variations", () => {
  for (const target of [
    "https://bts-kiot.onrender.com",
    "https://bts-kiot.onrender.com.",
    "https://BTS-KIOT.ONRENDER.COM",
    "http://bts-kiot.onrender.com",
    "https://bts-kiot.onrender.com:444",
  ]) {
    assert.throws(
      () => loadConfiguration(
        { scenario: "active", clients: "50" },
        {
          BTMS_CAPACITY_BASE_URL: target,
          BTMS_CAPACITY_STAGING_HOSTS: "bts-kiot.onrender.com",
          BTMS_CAPACITY_CONFIRM_STAGING: "YES",
          BTMS_CAPACITY_PRODUCTION_CONFIRMATION: "anything",
        },
      ),
      /production host is permanently blocked/,
    );
  }
});

test("remote staging requires allowlist and confirmation; local loopback allows HTTP", () => {
  assert.equal(
    loadConfiguration(
      { scenario: "active", clients: "20" },
      {
        BTMS_CAPACITY_BASE_URL: "https://stage.example.invalid",
        BTMS_CAPACITY_STAGING_HOSTS: "STAGE.EXAMPLE.INVALID.",
        BTMS_CAPACITY_CONFIRM_STAGING: "YES",
      },
    ).baseUrl,
    "https://stage.example.invalid",
  );
  assert.throws(
    () => loadConfiguration(
      { scenario: "active", clients: "20" },
      {
        BTMS_CAPACITY_BASE_URL: "https://unlisted.example.invalid",
        BTMS_CAPACITY_CONFIRM_STAGING: "YES",
      },
    ),
    /not in BTMS_CAPACITY_STAGING_HOSTS/,
  );
  assert.throws(
    () => loadConfiguration(
      { scenario: "active", clients: "20" },
      {
        BTMS_CAPACITY_BASE_URL: "https://stage.example.invalid",
        BTMS_CAPACITY_STAGING_HOSTS: "stage.example.invalid",
      },
    ),
    /require BTMS_CAPACITY_CONFIRM_STAGING=YES/,
  );
  assert.equal(
    loadConfiguration(
      { scenario: "active", clients: "20" },
      { BTMS_CAPACITY_BASE_URL: "http://[::1]:5000" },
    ).baseUrl,
    "http://[::1]:5000",
  );
});

test("capacity limits reject invalid, excessive, and inconsistent durations", () => {
  for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 600_001]) {
    assert.throws(
      () => loadConfiguration(
        { scenario: "active", clients: "20", "ramp-ms": String(value) },
        {},
      ),
    );
  }
  for (const options of [
    { scenario: "active", clients: "501" },
    { scenario: "active", clients: "20", "hold-ms": "0" },
    { scenario: "active", clients: "20", "hold-ms": "7200001" },
    { scenario: "active", clients: "20", "hold-ms": "9000000" },
    { scenario: "recovery", clients: "20", "hold-ms": "0" },
    { scenario: "login", clients: "20", "ramp-ms": "1" },
  ]) {
    assert.throws(() => loadConfiguration(options, {}));
  }
  assert.throws(
    () => validateCapacityLimits({
      clients: 20,
      rampMs: 1,
      holdMs: 1,
      requestTimeoutMs: 120_001,
      reconnectionAttempts: 1,
    }),
    /Request timeout/,
  );
  assert.throws(
    () => validateCapacityLimits({
      clients: 20,
      rampMs: 1,
      holdMs: 1,
      requestTimeoutMs: 1000,
      reconnectionAttempts: 6,
    }),
    /Reconnection attempts/,
  );
});

test("endurance requires a 60-minute hold and active planning accounts for recovery calls", () => {
  assert.throws(
    () => loadConfiguration(
      { scenario: "endurance", clients: "500", "hold-ms": "3599999" },
      {},
    ),
    /at least 60 minutes/,
  );
  const config = loadConfiguration(
    { scenario: "recovery", clients: "20", "hold-ms": "60000" },
    {},
  );
  assert.equal(plannedHttpRequests(config, fixtures(20)), 20 + 20 * 3 + 20 * 4 + 3);
});

test("cleanup emits room leaves and disconnects without issuing logout or account mutations", () => {
  const operations = [];
  const session = {
    previewRoomIds: ["4"],
    socket: {
      connected: true,
      emit: (...args) => operations.push(["emit", ...args]),
      disconnect: () => operations.push(["disconnect"]),
    },
  };
  cleanupSockets([session]);
  assert.deepEqual(operations, [
    ["emit", "leave-bus", "4"],
    ["disconnect"],
  ]);
});

test("login stage releases 100 requests together and keeps account reuse explicit", async () => {
  const accounts = fixtures(20);
  const config = loadConfiguration(
    { scenario: "login", clients: "100" },
    {},
  );
  let inFlight = 0;
  let maxInFlight = 0;
  const methods = [];
  const report = await runCapacityTest({
    config,
    accounts,
    fetchImpl: async (_url, options) => {
      methods.push(options.method);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          token: "synthetic-token",
          user: { role: "student", is_active: true },
        }),
      };
    },
  });

  assert.equal(report.authentication.attempts, 100);
  assert.equal(report.authentication.successful, 100);
  assert.equal(report.authentication.concurrentRequestsMaximum, 100);
  assert.equal(maxInFlight, 100);
  assert.equal(report.uniqueAccountsUsed, 20);
  assert.equal(report.accountReuseCount, 80);
  assert.ok(methods.every((method) => method === "POST"));
  assert.doesNotMatch(JSON.stringify(report), /test-\d+@example\.invalid|secret-\d+|synthetic-token/);
});

test("active stage stops before opening sockets when login failures exceed threshold", async () => {
  const accounts = fixtures(20);
  const config = loadConfiguration(
    { scenario: "active", clients: "20", "ramp-ms": "0", "hold-ms": "1000" },
    {},
  );
  let socketFactoryCalls = 0;
  let loginIndex = 0;
  const report = await runCapacityTest({
    config,
    accounts,
    ioFactory: () => {
      socketFactoryCalls += 1;
      throw new Error("Sockets must not start after the threshold is breached.");
    },
    fetchImpl: async () => {
      loginIndex += 1;
      if (loginIndex === 1) {
        return { ok: false, status: 401, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          token: "synthetic-token",
          user: { role: "student", is_active: true, bus_no: "4" },
        }),
      };
    },
  });

  assert.equal(report.authentication.failed, 1);
  assert.equal(socketFactoryCalls, 0);
  assert.ok(report.stopReasons.includes("authentication failures exceeded 1%"));
});

test("direct runner invocation still rejects production before calling fetch", async () => {
  const config = {
    ...loadConfiguration({ scenario: "login", clients: "20" }, {}),
    baseUrl: "https://bts-kiot.onrender.com.",
  };
  let fetchCalls = 0;
  await assert.rejects(
    () => runCapacityTest({
      config,
      accounts: fixtures(20),
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("Network access must not occur.");
      },
    }),
    /production host is permanently blocked/,
  );
  assert.equal(fetchCalls, 0);
});

test("active flow uses read-only app endpoints and receives the real socket event contract", async () => {
  const accounts = fixtures(20);
  const config = loadConfiguration(
    { scenario: "active", clients: "20", "ramp-ms": "0", "hold-ms": "5" },
    {},
  );
  const requests = [];
  const socketEvents = [];
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.connected = false;
      this.id = "synthetic-socket";
      this.io = new EventEmitter();
      this.io.engine = { transport: { name: "websocket" } };
    }

    connect() {
      this.connected = true;
      queueMicrotask(() => this.emit("connect"));
    }

    emit(event, ...args) {
      if (event === "request-bus-location") {
        socketEvents.push(event);
        queueMicrotask(() => super.emit("locationUpdate", {
          previewNumber: "4",
          latitude: 0,
          longitude: 0,
          lastUpdated: new Date().toISOString(),
        }));
        return true;
      }
      if (event === "join-bus" || event === "leave-bus") {
        socketEvents.push(event);
        return true;
      }
      return super.emit(event, ...args);
    }

    disconnect() {
      this.connected = false;
      super.emit("disconnect", "io client disconnect");
    }
  }

  const report = await runCapacityTest({
    config,
    accounts,
    ioFactory: () => new FakeSocket(),
    fetchImpl: async (url, options) => {
      requests.push({ url, method: options.method });
      if (url.endsWith("/ready")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            database: "CONNECTED",
            gpsWorker: {
              started: true,
              activeCycle: false,
              syncIntervalMs: 35000,
              lastCycleCompletedAt: new Date().toISOString(),
            },
            socketClients: 20,
          }),
        };
      }
      if (url.endsWith("/api/auth/login")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            token: "synthetic-token",
            user: {
              role: "student",
              is_active: true,
              bus_no: "4",
              previewNumber: "4",
            },
          }),
        };
      }
      if (url.endsWith("/api/bus/get-all-buses")) {
        return { ok: true, status: 200, json: async () => ({ buses: [] }) };
      }
      if (url.includes("/api/bus/location/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, previewNumber: "4" }),
        };
      }
      if (url.includes("/api/bus/routes/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, plans: {}, stops: [] }),
        };
      }
      throw new Error("Unexpected request endpoint");
    },
  });

  assert.equal(report.pass, true);
  assert.equal(report.sockets.successfulConnections, 20);
  assert.equal(report.sockets.locationUpdates, 20);
  assert.equal(report.sockets.clientsReceivingZeroUpdates, 0);
  assert.equal(socketEvents.filter((event) => event === "join-bus").length, 20);
  assert.equal(socketEvents.filter((event) => event === "request-bus-location").length, 20);
  assert.ok(
    requests.every(
      ({ url, method }) =>
        (method === "GET" && !url.endsWith("/api/auth/logout")) ||
        (method === "POST" && url.endsWith("/api/auth/login")) ||
        (method === undefined && url.endsWith("/ready")),
    ),
  );
  assert.equal(requests.filter(({ url }) => url.endsWith("/api/auth/logout")).length, 0);
  assert.equal(requests.filter(({ url }) => url.includes("/api/bus/")).length, 60);
});
