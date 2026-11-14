const assert = require("node:assert/strict");
const { test } = require("node:test");

let errorHandler;
test.before(async () => {
  errorHandler = await import("./errorHandler.js");
});

test("HTTP errors map to safe, actionable messages", () => {
  const expected = new Map([
    [400, "The request was invalid. Please check the details you entered."],
    [401, "Your session has expired. Please log in again."],
    [403, "You do not have permission to perform this action."],
    [404, "The requested item was not found."],
    [429, "Too many requests. Please wait a moment and try again."],
    [500, "The server encountered an unexpected error. Please try again."],
    [502, "The server is temporarily unavailable. Please try again shortly."],
    [503, "The server is temporarily unavailable. Please try again in a few seconds."],
  ]);
  for (const [status, message] of expected) {
    assert.equal(errorHandler.getErrorMessage({ status }), message);
  }
});

test("revision conflicts are actionable and preserve other conflict messages", () => {
  const busConflict = errorHandler.createHttpError(
    { status: 409 },
    {
      code: "BUS_REVISION_CONFLICT",
      error: "The bus changed. Reload before applying this update.",
    },
  );
  assert.equal(busConflict.code, "BUS_REVISION_CONFLICT");
  assert.equal(
    errorHandler.getErrorMessage(busConflict),
    "Bus details changed since you loaded them. Reload the bus list before trying again.",
  );

  const businessConflict = errorHandler.createHttpError(
    { status: 409 },
    { error: "Choose an active bus." },
  );
  assert.equal(
    errorHandler.getErrorMessage(businessConflict),
    "Choose an active bus.",
  );
});

test("network, timeout, and unavailable-server errors do not expose internals", () => {
  assert.match(
    errorHandler.getErrorMessage(Object.assign(new TypeError("Failed to fetch"))),
    /internet connection/,
  );
  assert.match(
    errorHandler.getErrorMessage(
      Object.assign(new Error("request timed out"), { isNetwork: true, isTimeout: true }),
    ),
    /check your connection/,
  );
  assert.equal(
    errorHandler.getErrorMessage({
      status: 503,
      message: "private database stack trace",
    }),
    "The server is temporarily unavailable. Please try again in a few seconds.",
  );
});

test("technical runtime and database errors are replaced with safe messages", () => {
  const errors = [
    new Error("MongoServerError: E11000 duplicate key"),
    new Error("AxiosError: connect ECONNREFUSED 127.0.0.1"),
    new Error("TypeError: Cannot read properties of undefined"),
    new Error("Error: database failed\n    at runQuery (node:internal/query:1:2)"),
    new Error("java.net.SocketTimeoutException: private host unreachable"),
    new Error("UnknownHostException: internal-api"),
  ];
  for (const error of errors) {
    const message = errorHandler.getErrorMessage(error, "Please try again.");
    assert.ok(message);
    assert.doesNotMatch(
      message,
      /MongoServerError|AxiosError|TypeError|ReferenceError|RangeError|SystemError|SocketTimeoutException|UnknownHostException|ConnectException|java\.net|node:|stack trace/i,
    );
  }
});

test("JSON parsing rejects malformed responses without surfacing server HTML", async () => {
  await assert.rejects(
    errorHandler.parseJsonResponse({
      status: 502,
      text: async () => "<html>private upstream detail</html>",
    }),
    (error) =>
      error.code === "INVALID_RESPONSE" &&
      error.status === 502 &&
      !error.message.includes("private upstream detail"),
  );
});

test("mutation fetches send the stable idempotency key and preserve expected versions", async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true }),
    };
  };
  const payload = {
    expectedVersions: { "user-1": 7 },
    expectedAssignmentRevisions: { "user-1": 3 },
  };

  try {
    await errorHandler.fetchJson("/api/superadmin/users", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      idempotencyKey: "stable-user-operation-001",
    });
    assert.equal(
      request.options.headers["Idempotency-Key"],
      "stable-user-operation-001",
    );
    assert.deepEqual(JSON.parse(request.options.body), payload);
  } finally {
    global.fetch = originalFetch;
  }
});
