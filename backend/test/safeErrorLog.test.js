const assert = require("node:assert/strict");
const test = require("node:test");
const { logSafeError } = require("../src/utils/safeErrorLog");

test("safe error logging omits messages that could contain request data", () => {
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...values) => logged.push(values);
  try {
    logSafeError("API request failed", {
      name: "MongoServerError",
      code: 11000,
      message: "duplicate key private.student@example.test password=secret",
    });
    assert.deepEqual(logged, [[
      "API request failed",
      { name: "MongoServerError", code: 11000 },
    ]]);
  } finally {
    console.error = originalConsoleError;
  }
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
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...values) => logged.push(values);
  try {
    logSafeError("API request failed", {
      name: "Sensitive Student",
      code: "student@example.test",
    });

    test("safe error logging includes only a validated request correlation ID", () => {
      const originalConsoleError = console.error;
      const logged = [];
      console.error = (...values) => logged.push(values);
      try {
        logSafeError(
          "API request failed",
          { name: "Error", code: null },
          "123e4567-e89b-42d3-a456-426614174000",
        );
        assert.deepEqual(logged, [[
          "API request failed",
          {
            name: "Error",
            code: null,
            requestId: "123e4567-e89b-42d3-a456-426614174000",
          },
        ]]);
      } finally {
        console.error = originalConsoleError;
      }
    });
    assert.deepEqual(logged, [[
      "API request failed",
      { name: "Error", code: null },
    ]]);
  } finally {
    console.error = originalConsoleError;
  }
});
