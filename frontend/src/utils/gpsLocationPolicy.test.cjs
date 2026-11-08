const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DEFAULT_GPS_OFFLINE_THRESHOLD_MS,
  ROUTE_REFRESH_DISTANCE_METERS,
  SOCKET_RECOVERY_BASE_DELAY_MS,
  SOCKET_RECOVERY_MAX_DELAY_MS,
  distanceMeters,
  getGpsFreshnessDelay,
  getLocationOrder,
  getSocketRecoveryDelay,
  hasKnownLocationOrder,
  hasValidGpsCoordinates,
  isGpsStale,
  isIncomingLocationOlder,
  isLocationForSelection,
  createGpsLocationReconciler,
  compareLocationVersions,
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

test("location versions order snapshots and live events without Number precision loss", () => {
  const current = getLocationOrder({
    locationVersion: "90071992547409930",
    providerTimestamp: "2026-11-07T08:00:00Z",
  });
  assert.equal(
    compareLocationVersions("90071992547409929", current.version),
    -1,
  );
  assert.equal(
    isIncomingLocationOlder({ locationVersion: "90071992547409929" }, current),
    true,
  );
  assert.equal(
    isIncomingLocationOlder({ locationVersion: "90071992547409930" }, current),
    true,
  );
  assert.equal(
    isIncomingLocationOlder({ locationVersion: "90071992547409931" }, current),
    false,
  );
  assert.equal(
    isIncomingLocationOlder(
      { lastSuccessfulGpsUpdate: "2026-11-07T08:01:00Z" },
      current,
    ),
    true,
  );
  assert.equal(hasKnownLocationOrder(current), true);
});

test("legacy location timestamps remain a fallback only before versioned data arrives", () => {
  const current = getLocationOrder({
    lastSuccessfulGpsUpdate: "2026-11-07T08:00:01Z",
  });
  assert.equal(
    isIncomingLocationOlder(
      { lastSuccessfulGpsUpdate: "2026-11-07T08:00:00Z" },
      current,
    ),
    true,
  );
  assert.equal(
    isIncomingLocationOlder(
      {
        locationVersion: "1",
        lastSuccessfulGpsUpdate: "2026-11-07T08:00:00Z",
      },
      current,
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

test("unresolved selections buffer candidates and apply only the snapshot-matched bus", () => {
  const reconciler = createGpsLocationReconciler();
  const key = "bus:KIOT-8";
  const generation = reconciler.select(key);
  reconciler.bufferLive(key, {
    previewNumber: "4",
    locationVersion: "12",
    latitude: 12,
  });

  const result = reconciler.reconcileSnapshot(
    key,
    {
      busNo: "KIOT-8",
      previewNumber: "4",
      locationVersion: "11",
      latitude: 11,
    },
    generation,
  );
  assert.equal(result.accepted, true);
  assert.equal(result.fromBufferedLive, true);
  assert.equal(result.location.latitude, 12);
  assert.equal(result.location.busNo, "KIOT-8");
});

test("unresolved selections discard buffered events for a different preview", () => {
  const reconciler = createGpsLocationReconciler();
  const key = "bus:KIOT-9";
  reconciler.select(key);
  reconciler.bufferLive(key, {
    previewNumber: "4",
    locationVersion: "30",
    latitude: 30,
  });

  const result = reconciler.reconcileSnapshot(key, {
    busNo: "KIOT-9",
    previewNumber: "9",
    locationVersion: "29",
    latitude: 29,
  });
  assert.equal(result.location.latitude, 29);
  assert.equal(result.fromBufferedLive, false);
});

test("pending live candidates stay bounded during snapshot loading", () => {
  const reconciler = createGpsLocationReconciler();
  const key = "bus:KIOT-10";
  reconciler.select(key);
  for (let preview = 0; preview < 20; preview += 1) {
    reconciler.bufferLive(key, {
      previewNumber: String(preview),
      locationVersion: "2",
      latitude: 2,
    });
  }

  const result = reconciler.reconcileSnapshot(key, {
    busNo: "KIOT-10",
    previewNumber: "0",
    locationVersion: "1",
    latitude: 1,
  });
  assert.equal(result.location.latitude, 1);
  assert.equal(result.fromBufferedLive, false);
});

test("unresolved live selection requires bus identity or an authorized assigned-bus room", () => {
  assert.equal(
    isLocationForSelection(
      { previewNumber: "4", locationVersion: "1" },
      "KIOT-1",
      null,
      null,
    ),
    false,
  );
  assert.equal(
    isLocationForSelection(
      { previewNumber: "4", locationVersion: "1" },
      "KIOT-1",
      null,
      null,
      true,
    ),
    true,
  );
  assert.equal(
    isLocationForSelection(
      { busNo: "KIOT-2", locationVersion: "1" },
      "KIOT-1",
      null,
      null,
      true,
    ),
    false,
  );
});

test("live event received before the snapshot wins over an older snapshot", () => {
  const reconciler = createGpsLocationReconciler();
  const key = "bus:KIOT-1";
  const generation = reconciler.select(key);
  reconciler.beginSnapshot(key);

  const live = { locationVersion: "12", latitude: 12 };
  assert.equal(reconciler.acceptLive(key, live).accepted, true);
  const result = reconciler.reconcileSnapshot(
    key,
    { locationVersion: "11", latitude: 11 },
    generation,
  );

  assert.equal(result.accepted, false);
  assert.equal(result.location, live);
  assert.equal(reconciler.getState().snapshotPending, false);
});

test("newer snapshot replaces an older live event", () => {
  const reconciler = createGpsLocationReconciler();
  const key = "preview:4";
  const generation = reconciler.select(key);
  const live = { locationVersion: "20", latitude: 20 };
  reconciler.acceptLive(key, live);

  const snapshot = { locationVersion: "21", latitude: 21 };
  const result = reconciler.reconcileSnapshot(key, snapshot, generation);

  assert.equal(result.accepted, true);
  assert.equal(result.location, snapshot);
});

test("duplicate and out-of-order live versions are rejected", () => {
  const reconciler = createGpsLocationReconciler();
  const key = "bus:KIOT-2";
  reconciler.select(key);
  const first = { locationVersion: "90071992547409930" };
  reconciler.acceptLive(key, first);

  assert.equal(
    reconciler.acceptLive(key, { locationVersion: "90071992547409930" }).accepted,
    false,
  );
  assert.equal(
    reconciler.acceptLive(key, { locationVersion: "90071992547409929" }).accepted,
    false,
  );
  assert.equal(
    reconciler.acceptLive(key, { locationVersion: "90071992547409931" }).accepted,
    true,
  );
});

test("selection changes invalidate a pending snapshot and buffered live event", () => {
  const reconciler = createGpsLocationReconciler();
  const firstKey = "preview:4";
  const firstGeneration = reconciler.select(firstKey);
  reconciler.acceptLive(firstKey, { locationVersion: "3" });

  const secondKey = "preview:9";
  reconciler.select(secondKey);
  const result = reconciler.reconcileSnapshot(
    firstKey,
    { locationVersion: "4" },
    firstGeneration,
  );

  assert.equal(result.accepted, false);
  assert.equal(reconciler.getState().selectionKey, secondKey);
  assert.equal(reconciler.getState().latestLocation, null);
});

test("unmount or logout invalidates pending snapshots", () => {
  const reconciler = createGpsLocationReconciler();
  const key = "bus:KIOT-3";
  const generation = reconciler.select(key);
  reconciler.beginSnapshot(key);
  reconciler.invalidate();

  const result = reconciler.reconcileSnapshot(
    key,
    { locationVersion: "1" },
    generation,
  );
  assert.equal(result.accepted, false);
  assert.equal(reconciler.getState().snapshotPending, false);
});

test("missing and malformed versions cannot overwrite a known newer location", () => {
  const reconciler = createGpsLocationReconciler();
  const key = "bus:KIOT-4";
  reconciler.select(key);
  const current = {
    locationVersion: "8",
    latitude: 8,
    lastSuccessfulGpsUpdate: "2026-11-07T08:00:08Z",
  };
  reconciler.acceptLive(key, current);

  for (const invalidVersion of [undefined, "8x", -1, null]) {
    assert.equal(
      reconciler.acceptLive(key, {
        locationVersion: invalidVersion,
        latitude: 1,
        lastSuccessfulGpsUpdate: "2026-11-07T08:00:01Z",
      }).accepted,
      false,
    );
  }
  assert.equal(
    reconciler.reconcileSnapshot(
      key,
      { locationVersion: "malformed", latitude: 1 },
    ).location,
    current,
  );
});

test("legacy timestamps order locations only while neither state has a version", () => {
  const reconciler = createGpsLocationReconciler();
  const key = "bus:legacy";
  reconciler.select(key);
  const live = {
    providerTimestamp: "2026-11-07T08:00:02Z",
    latitude: 2,
  };
  assert.equal(reconciler.acceptLive(key, live).accepted, true);
  assert.equal(
    reconciler.acceptLive(key, {
      providerTimestamp: "2026-11-07T08:00:01Z",
      latitude: 1,
    }).accepted,
    false,
  );
  assert.equal(
    reconciler.acceptLive(key, { latitude: 3 }).accepted,
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

test("GPS coordinates must be finite and geographically valid", () => {
  assert.equal(hasValidGpsCoordinates({ latitude: 0, longitude: 0 }), true);
  assert.equal(
    hasValidGpsCoordinates({ latitude: "91", longitude: 78 }),
    false,
  );
  assert.equal(
    hasValidGpsCoordinates({ latitude: 11, longitude: "181" }),
    false,
  );
  assert.equal(
    hasValidGpsCoordinates({ latitude: "NaN", longitude: 78 }),
    false,
  );
  assert.equal(
    hasValidGpsCoordinates({ latitude: null, longitude: 78 }),
    false,
  );
});

test("GPS freshness timer expires at the configured offline threshold", () => {
  const now = Date.parse("2026-11-04T00:03:00Z");
  assert.equal(
    getGpsFreshnessDelay(
      {
        lastSuccessfulGpsUpdate: "2026-11-04T00:00:30Z",
        gpsOfflineThresholdMs: 180_000,
      },
      now,
    ),
    30_001,
  );
  assert.equal(
    getGpsFreshnessDelay(
      {
        lastSuccessfulGpsUpdate: "2026-11-04T00:00:00Z",
        gpsOfflineThresholdMs: 180_000,
      },
      now,
    ),
    1,
  );
});
