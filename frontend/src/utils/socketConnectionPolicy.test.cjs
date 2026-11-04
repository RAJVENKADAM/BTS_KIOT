const assert = require("node:assert/strict");
const test = require("node:test");
const {
  isPermanentSocketAuthenticationError,
} = require("./socketConnectionPolicy.cjs");

test("permanent authentication failures stop socket reconnect retries", () => {
  assert.equal(
    isPermanentSocketAuthenticationError(
      new Error("Authentication required"),
    ),
    true,
  );
  assert.equal(
    isPermanentSocketAuthenticationError(
      new Error("Invalid or expired token"),
    ),
    true,
  );
  assert.equal(
    isPermanentSocketAuthenticationError(new Error("network unavailable")),
    false,
  );
  assert.equal(isPermanentSocketAuthenticationError(null), false);
});
