"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  PRODUCTION_API_BASE_URL,
  resolveBackendEnvironment,
} = require("./backendEnvironment.cjs");

test("unit and development configurations default to local backend targets", () => {
  assert.deepEqual(
    resolveBackendEnvironment({ nodeEnvironment: "test", platform: "android" }),
    {
      environment: "local",
      apiBaseUrl: "http://10.0.2.2:5000",
    },
  );
  assert.deepEqual(
    resolveBackendEnvironment({ nodeEnvironment: "development", platform: "ios" }),
    {
      environment: "local",
      apiBaseUrl: "http://127.0.0.1:5000",
    },
  );
});

test("local physical-device configuration accepts a private LAN backend origin", () => {
  assert.equal(
    resolveBackendEnvironment({
      environment: "local",
      platform: "android",
      apiBaseUrl: "http://192.168.1.40:5000/",
    }).apiBaseUrl,
    "http://192.168.1.40:5000",
  );
  assert.equal(
    resolveBackendEnvironment({
      environment: "local",
      apiBaseUrl: "http://10.0.2.2:5000",
    }).apiBaseUrl,
    "http://10.0.2.2:5000",
  );
});

test("local configuration rejects Render, arbitrary remote hosts, and malformed origins", () => {
  for (const apiBaseUrl of [
    PRODUCTION_API_BASE_URL,
    "https://bts-kiot.onrender.com.",
    "https://example.com",
    "http://192.0.2.15:5000",
    "http://192.168.1.40:5001",
    "http://user:password@192.168.1.40:5000",
    "http://192.168.1.40:5000/api",
  ]) {
    assert.throws(
      () => resolveBackendEnvironment({ environment: "local", apiBaseUrl }),
      undefined,
      apiBaseUrl,
    );
  }
});

test("production configuration preserves Render and rejects localhost overrides", () => {
  assert.deepEqual(
    resolveBackendEnvironment({ nodeEnvironment: "production" }),
    {
      environment: "production",
      apiBaseUrl: PRODUCTION_API_BASE_URL,
    },
  );
  assert.throws(
    () =>
      resolveBackendEnvironment({
        environment: "production",
        apiBaseUrl: "http://127.0.0.1:5000",
      }),
    /must use the configured production API origin/,
  );
});

test("remote Render testing is opt-in and remains separate from production builds", () => {
  assert.throws(
    () => resolveBackendEnvironment({ environment: "remote-test" }),
    /EXPO_PUBLIC_ALLOW_REMOTE_TESTS=YES/,
  );
  assert.deepEqual(
    resolveBackendEnvironment({
      environment: "remote-test",
      allowRemoteTests: "YES",
    }),
    {
      environment: "remote-test",
      apiBaseUrl: PRODUCTION_API_BASE_URL,
    },
  );
});
