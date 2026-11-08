"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { test } = require("node:test");
const { validateTarget } = require("../load-tests/student-load-test");

test("legacy runner blocks production and requires the shared staging allowlist", () => {
  for (const target of [
    "https://bts-kiot.onrender.com",
    "https://bts-kiot.onrender.com.",
    "https://BTS-KIOT.ONRENDER.COM",
    "http://bts-kiot.onrender.com",
    "https://bts-kiot.onrender.com:444",
  ]) {
    assert.throws(
      () => validateTarget({
        BTMS_LOAD_TEST_BASE_URL: target,
        BTMS_CAPACITY_STAGING_HOSTS: "bts-kiot.onrender.com",
        BTMS_CAPACITY_CONFIRM_STAGING: "YES",
      }),
      /production host is permanently blocked/,
    );
  }
  assert.equal(
    validateTarget({
      BTMS_LOAD_TEST_BASE_URL: "https://stage.example.invalid",
      BTMS_CAPACITY_STAGING_HOSTS: "stage.example.invalid",
      BTMS_CAPACITY_CONFIRM_STAGING: "YES",
    }),
    "https://stage.example.invalid",
  );
});

test("importing the legacy runner does not execute a load test", () => {
  const runnerPath = path.resolve(
    __dirname,
    "..",
    "load-tests",
    "student-load-test.js",
  );
  const result = spawnSync(
    process.execPath,
    ["-e", `require(${JSON.stringify(runnerPath)})`],
    {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        BTMS_LOAD_TEST_BASE_URL: "https://bts-kiot.onrender.com",
      },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
