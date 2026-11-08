"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "config.js"), "utf8");

function loadConfig(location, options = {}) {
  const window = { location, ...options };
  vm.runInNewContext(source, {
    window,
    URLSearchParams,
    Object,
    String,
  });
  return window.BTMS_CONFIG;
}

test("deployed static dashboard defaults to the existing Render production API", () => {
  assert.deepEqual(
    { ...loadConfig({ hostname: "rajvenkadam.github.io", protocol: "https:", search: "" }) },
    {
      ENVIRONMENT: "production",
      API_BASE_URL: "https://bts-kiot.onrender.com",
      SOCKET_BASE_URL: "https://bts-kiot.onrender.com",
    },
  );
});

test("locally served dashboard uses the local backend on the same host", () => {
  const config = loadConfig({
    hostname: "192.168.1.40",
    protocol: "http:",
    search: "",
  });
  assert.equal(config.ENVIRONMENT, "local");
  assert.equal(config.API_BASE_URL, "http://192.168.1.40:5000");
  assert.equal(config.SOCKET_BASE_URL, config.API_BASE_URL);
});

test("IPv6 loopback dashboard selects a valid local backend origin", () => {
  const config = loadConfig({
    hostname: "::1",
    protocol: "http:",
    search: "",
  });
  assert.equal(config.API_BASE_URL, "http://[::1]:5000");
  assert.equal(config.SOCKET_BASE_URL, config.API_BASE_URL);
});

test("a local file dashboard never silently selects production", () => {
  assert.throws(
    () =>
      loadConfig({
        hostname: "",
        protocol: "file:",
        search: "",
      }),
    /must be opened from loopback or a private LAN address/,
  );
});

test("remote Render dashboard mode requires explicit opt-in", () => {
  assert.throws(
    () =>
      loadConfig({
        hostname: "localhost",
        protocol: "http:",
        search: "?btmsEnvironment=remote-test",
      }),
    /explicit allowRemoteTests=YES opt-in/,
  );
  const config = loadConfig(
    {
      hostname: "localhost",
      protocol: "http:",
      search: "?btmsEnvironment=remote-test&allowRemoteTests=YES",
    },
  );
  assert.equal(config.ENVIRONMENT, "remote-test");
  assert.equal(config.API_BASE_URL, "https://bts-kiot.onrender.com");
});
