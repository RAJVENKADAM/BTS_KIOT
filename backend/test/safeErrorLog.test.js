"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  attachStartupStage,
  logSafeError,
  sanitizeDiagnosticText,
} = require("../src/utils/safeErrorLog");

function captureLog(action) {
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...values) => logged.push(values);
  try {
    action();
  } finally {
    console.error = originalConsoleError;
  }
  return logged;
}

test("safe error logging omits diagnostic text by default", () => {
  const logged = captureLog(() =>
    logSafeError("API request failed", {
      name: "MongoServerError",
      code: 11000,
      message: "duplicate key private.student@example.test ******",
    }),
  );
  assert.deepEqual(logged, [[
    "API request failed",
    { name: "MongoServerError", code: 11000 },
  ]]);
});

test("startup diagnostics retain useful message and stack while redacting sensitive data", () => {
  const priorJwtSecret = process.env.JWT_SECRET;
  const priorMongoUri = process.env.MONGODB_URI;
  const jwtSecret = "startup-test-secret-value";
  const mongoUri =
    "mongodb+srv://startup-user:startup-password@cluster.example.mongodb.net/bts_staging_db";
  process.env.JWT_SECRET = jwtSecret;
  process.env.MONGODB_URI = mongoUri;
  try {
    const error = attachStartupStage(
      new Error(
        `Socket.IO mode invalid; secret=${jwtSecret}; URI=${mongoUri}; Bearer abc.def.ghi`,
      ),
      "Socket.IO shared-transport configuration",
    );
    const logged = captureLog(() =>
      logSafeError("Server startup failed", error, undefined, {
        includeDiagnostics: true,
      }),
    );
    const details = logged[0][1];
    assert.equal(details.name, "Error");
    assert.equal(details.startupStage, "Socket.IO shared-transport configuration");
    assert.match(details.message, /Socket.IO mode invalid/);
    assert.match(details.stack, /Error: Socket\.IO mode invalid/);
    assert.equal(details.message.includes(jwtSecret), false);
    assert.equal(details.message.includes("startup-password"), false);
    assert.equal(details.message.includes("cluster.example.mongodb.net"), false);
    assert.equal(details.message.includes("abc.def.ghi"), false);
    assert.equal(details.stack.includes(jwtSecret), false);
    assert.equal(details.stack.includes("startup-password"), false);
    assert.equal(details.stack.includes("cluster.example.mongodb.net"), false);
  } finally {
    if (priorJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = priorJwtSecret;
    if (priorMongoUri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = priorMongoUri;
  }
});

test("diagnostic sanitizer redacts labeled credentials and limits output size", () => {
  const sanitized = sanitizeDiagnosticText(
    `password=private-value authorization: Bearer abc123 ${"x".repeat(9000)}`,
    {},
  );
  assert.equal(sanitized.includes("private-value"), false);
  assert.equal(sanitized.includes("abc123"), false);
  assert.equal(sanitized.length, 8000);
});

test("logging failures do not interrupt request handling", () => {
  const originalConsoleError = console.error;
  console.error = () => {
    throw new Error("logging transport failed");
  };
  try {
    assert.doesNotThrow(() => logSafeError("API request failed", new Error()));
  } finally {
    console.error = originalConsoleError;
  }
});

test("safe error logging rejects untrusted name and code strings", () => {
  const logged = captureLog(() =>
    logSafeError("API request failed", {
      name: "Sensitive Student",
      code: "student@example.test",
    }),
  );
  assert.deepEqual(logged, [[
    "API request failed",
    { name: "Error", code: null },
  ]]);
});

test("safe error logging includes only a validated request correlation ID", () => {
  const logged = captureLog(() =>
    logSafeError(
      "API request failed",
      { name: "Error", code: null },
      "123e4567-e89b-42d3-a456-426614174000",
    ),
  );
  assert.deepEqual(logged, [[
    "API request failed",
    {
      name: "Error",
      code: null,
      requestId: "123e4567-e89b-42d3-a456-426614174000",
    },
  ]]);
});
