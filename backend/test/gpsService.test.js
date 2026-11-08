"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeLocationResponse } = require("../src/services/gpsService");

function providerRecord(overrides = {}) {
  return {
    deviceId: "device-1",
    regNo: "BUS-1",
    latitude: 11.55,
    longitude: 78.02,
    speed: 20,
    timestamp: "2026-11-07T08:00:00.000Z",
    ...overrides,
  };
}

test("provider normalization retains provider event time and does not synthesize arrival time", () => {
  const timestamp = "2026-11-07T08:00:00.000Z";
  const locations = normalizeLocationResponse([
    providerRecord({ timestamp }),
    providerRecord({ deviceId: "device-2", timestamp: "invalid" }),
    providerRecord({ deviceId: "device-3", timestamp: undefined }),
  ]);

  assert.equal(locations.get("device-1").providerTimestamp, timestamp);
  assert.equal(locations.get("device-2").providerTimestamp, null);
  assert.equal(locations.get("device-3").providerTimestamp, null);
  assert.equal("timestamp" in locations.get("device-1"), false);
});

test("duplicate provider records select the newest provider time independent of list order", () => {
  const older = providerRecord({
    latitude: 11.5,
    timestamp: "2026-11-07T08:00:00.000Z",
  });
  const newer = providerRecord({
    latitude: 11.6,
    timestamp: "2026-11-07T08:00:01.000Z",
  });

  for (const response of [[older, newer], [newer, older]]) {
    const locations = normalizeLocationResponse(response);
    assert.equal(locations.get("device-1").latitude, 11.6);
    assert.equal(
      locations.get("device-1").providerTimestamp,
      newer.timestamp,
    );
  }
});

test("conflicting duplicate coordinates with an equal provider timestamp are excluded", () => {
  const first = providerRecord();
  const conflict = providerRecord({ latitude: 11.6 });
  const locations = normalizeLocationResponse([first, conflict]);

  assert.equal(locations, null);
});

test("identical duplicate provider records are coalesced", () => {
  const record = providerRecord();
  const locations = normalizeLocationResponse([record, { ...record }]);

  assert.ok(locations instanceof Map);
  assert.equal(locations.size, 2);
  assert.equal(locations.get("device-1").latitude, record.latitude);
});

test("malformed coordinates are rejected and invalid speeds normalize to zero", () => {
  const locations = normalizeLocationResponse([
    providerRecord({ latitude: "11.55north" }),
    providerRecord({ deviceId: "device-2", speed: "Infinity" }),
    providerRecord({ deviceId: "device-3", speed: -1 }),
  ]);

  assert.equal(locations.has("device-1"), false);
  assert.equal(locations.get("device-2").speed, 0);
  assert.equal(locations.get("device-3").speed, 0);
});
