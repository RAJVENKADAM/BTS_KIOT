"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const Module = require("node:module");
const { test } = require("node:test");

test("importing the application factory performs no runtime initialization", () => {
  const appPath = require.resolve("../src/app");
  const originalLoad = Module._load;
  const appDependencies = [];
  delete require.cache[appPath];

  Module._load = function (request, parent, isMain) {
    if (parent?.filename === appPath) appDependencies.push(request);
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const application = require(appPath);
    assert.deepEqual(Object.keys(application), ["createApplication"]);
    assert.deepEqual(appDependencies, []);
  } finally {
    Module._load = originalLoad;
  }
});

test("application construction and health checks do not start external services", async () => {
  const { createApplication } = require("../src/app");
  const mongoose = require("mongoose");
  const initialReadyState = mongoose.connection.readyState;
  const app = createApplication({
    env: { NODE_ENV: "test", SOCKET_IO_MODE: "single-instance" },
  });
  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const response = await new Promise((resolve, reject) => {
      http
        .get(
          {
            hostname: "127.0.0.1",
            port: server.address().port,
            path: "/health",
          },
          resolve,
        )
        .on("error", reject);
    });
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
      status: "OK",
      message: "BTMS Backend is running",
    });
    assert.equal(mongoose.connection.readyState, initialReadyState);
    assert.equal(require.cache[require.resolve("../src/services/gpsService")], undefined);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
