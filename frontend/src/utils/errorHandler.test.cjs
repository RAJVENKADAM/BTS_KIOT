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
