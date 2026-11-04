const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DEFAULT_GPS_OFFLINE_THRESHOLD_MS,
  ROUTE_REFRESH_DISTANCE_METERS,
  SOCKET_RECOVERY_BASE_DELAY_MS,
  SOCKET_RECOVERY_MAX_DELAY_MS,
  distanceMeters,
  getSocketRecoveryDelay,
  isGpsStale,
  isIncomingLocationOlder,
  isLocationForSelection,
  shouldRefreshRoute,
} = require("./gpsLocationPolicy.cjs");

test("GPS freshness uses the backend threshold and defaults to three minutes", () => {
  const now = Date.parse("2026-11-04T00:03:00Z");
  assert.equal(DEFAULT_GPS_OFFLINE_THRESHOLD_MS, 180_000);
  assert.equal(
    isGpsStale(
      {
        status: "online",
        is_online: true,
        lastSuccessfulGpsUpdate: "2026-11-04T00:00:30Z",
        gpsOfflineThresholdMs: 180_000,
      },
      now,
    ),
    false,
  );
  assert.equal(
    isGpsStale(
      {
        status: "online",
        is_online: true,
        lastSuccessfulGpsUpdate: "2026-11-04T00:00:00Z",
        gpsOfflineThresholdMs: 120_000,
      },
      now,
    ),
    true,
  );
  assert.equal(
    isGpsStale(
      {
        status: "online",
        is_online: true,
        lastSuccessfulGpsUpdate: "2026-11-04T00:00:30Z",
      },
      now,
    ),
    false,
  );
});

test("older or timestamp-less updates cannot replace a known newer location", () => {
  const currentTimestamp = Date.parse("2026-11-04T00:01:00Z");
  assert.equal(
    isIncomingLocationOlder(
      { lastSuccessfulGpsUpdate: "2026-11-04T00:00:59Z" },
      currentTimestamp,
    ),
    true,
  );
  assert.equal(
    isIncomingLocationOlder({ lastSuccessfulGpsUpdate: null }, currentTimestamp),
    true,
  );
  assert.equal(
    isIncomingLocationOlder(
      { lastSuccessfulGpsUpdate: "2026-11-04T00:01:00Z" },
      currentTimestamp,
    ),
    false,
  );
});

test("route refresh threshold suppresses small movement but permits significant movement", () => {
  const origin = { latitude: 11.55, longitude: 78.02 };
  const smallMove = { latitude: 11.5501, longitude: 78.02 };
  const largeMove = { latitude: 11.552, longitude: 78.02 };
  assert.equal(ROUTE_REFRESH_DISTANCE_METERS, 100);
  assert.ok(distanceMeters(origin, smallMove) < ROUTE_REFRESH_DISTANCE_METERS);
  assert.equal(shouldRefreshRoute(origin, smallMove), false);
  assert.equal(shouldRefreshRoute(origin, largeMove), true);
  assert.equal(shouldRefreshRoute(null, origin), true);
});

test("preview-only selections accept their room updates and reject unrelated buses", () => {
  const selectedBus = { previewNumber: "4" };
  assert.equal(
    isLocationForSelection(
      { previewNumber: "4", latitude: 11 },
      null,
      "4",
      selectedBus,
    ),
    true,
  );
  assert.equal(
    isLocationForSelection(
      { previewNumber: "9", latitude: 11 },
      null,
      "4",
      selectedBus,
    ),
    false,
  );
  assert.equal(
    isLocationForSelection(
      { previewNumber: "4" },
      null,
      null,
      selectedBus,
    ),
    false,
  );
});

test("socket snapshot retries use bounded exponential backoff with jitter", () => {
  assert.equal(SOCKET_RECOVERY_BASE_DELAY_MS, 5_000);
  assert.equal(SOCKET_RECOVERY_MAX_DELAY_MS, 60_000);
  assert.equal(getSocketRecoveryDelay(0, 0), 2_500);
  assert.equal(getSocketRecoveryDelay(1, 1), 10_000);
  assert.equal(getSocketRecoveryDelay(20, 1), 60_000);
  assert.equal(getSocketRecoveryDelay(-1, 0.5), 3_750);
});
