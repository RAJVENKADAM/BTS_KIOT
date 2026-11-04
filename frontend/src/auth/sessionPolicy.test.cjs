const assert = require("node:assert/strict");
const { test } = require("node:test");
const { shouldClearAuthSession } = require("./sessionPolicy.cjs");

test("clears a session only for explicit invalid-session responses", () => {
  assert.equal(shouldClearAuthSession(200, { valid: false }), true);
  assert.equal(shouldClearAuthSession(200, { deactivated: true }), true);
  assert.equal(shouldClearAuthSession(401, { valid: false }), true);
  assert.equal(shouldClearAuthSession(403, { deactivated: true }), true);
});

test("preserves sessions for rate limits, server errors, and malformed success", () => {
  for (const status of [401, 403, 429, 500, 502, 503]) {
    assert.equal(shouldClearAuthSession(status, {}), false);
  }
  assert.equal(shouldClearAuthSession(200, {}), false);
});

test("clears a verified superadmin session from the mobile application", () => {
  assert.equal(
    shouldClearAuthSession(200, {
      valid: true,
      user: { role: "superadmin" },
    }),
    true,
  );
  assert.equal(
    shouldClearAuthSession(200, {
      valid: true,
      user: { role: "primary_admin" },
    }),
    false,
  );
});
