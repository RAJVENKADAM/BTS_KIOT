const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildReadiness } = require("../src/utils/readiness");

const healthyWorker = {
  started: true,
  stopping: false,
  syncIntervalMs: 35000,
  activeCycleId: null,
  lastCycle: {
    status: "COMPLETED",
    completedAt: "2026-11-04T00:00:00.000Z",
    providerFailures: 0,
    databaseReadFailures: 0,
  },
};

test("readiness requires MongoDB but remains ready when GPS is degraded or stopped", () => {
  const ready = buildReadiness({
    databaseReadyState: 1,
    gpsWorker: {
      ...healthyWorker,
      started: false,
      lastCycle: {
        ...healthyWorker.lastCycle,
        providerFailures: 1,
        status: "FAILED",
      },
    },
    socketClients: 3,
  });

  assert.equal(ready.httpStatus, 200);
  assert.equal(ready.payload.status, "READY");
  assert.equal(ready.payload.gpsProvider.status, "DEGRADED");
  assert.equal(ready.payload.gpsWorker.started, false);
  assert.equal(ready.payload.socketClients, 3);
});

test("readiness reports disconnected, connecting, and disconnecting database states", () => {
  for (const [state, expected] of [
    [0, "DISCONNECTED"],
    [2, "CONNECTING"],
    [3, "DISCONNECTING"],
  ]) {
    const readiness = buildReadiness({
      databaseReadyState: state,
      gpsWorker: healthyWorker,
      socketClients: 0,
    });
    assert.equal(readiness.httpStatus, 503);
    assert.equal(readiness.payload.status, "NOT_READY");
    assert.equal(readiness.payload.database, expected);
  }
});

test("readiness diagnostics expose no credentials, coordinates, or provider payload", () => {
  const readiness = buildReadiness({
    databaseReadyState: 1,
    gpsWorker: healthyWorker,
    socketClients: 0,
  });
  const serialized = JSON.stringify(readiness.payload);
  assert.doesNotMatch(serialized, /password|token|latitude|longitude|providerPayload/i);
});
