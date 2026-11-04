const assert = require("node:assert/strict");
const { test } = require("node:test");
const { restoreCachedSession } = require("./sessionRestore.cjs");
const { shouldClearAuthSession } = require("./sessionPolicy.cjs");

const cached = JSON.stringify({
  id: "student-1",
  email: "student@example.edu",
  role: "student",
});

test("restart restores a valid cached session and refreshed role claims", async () => {
  const session = await restoreCachedSession({
    token: "valid-token",
    storedUser: cached,
    verify: async () => ({
      valid: true,
      user: { id: "student-1", role: "primary_admin" },
    }),
    clear: async () => assert.fail("valid session must not be cleared"),
    shouldClear: shouldClearAuthSession,
  });

  assert.equal(session.token, "valid-token");
  assert.equal(session.user.role, "primary_admin");
  assert.equal(session.user.email, "student@example.edu");
});

test("restart clears explicitly invalid sessions", async () => {
  let clearCount = 0;
  const session = await restoreCachedSession({
    token: "expired-token",
    storedUser: cached,
    verify: async () => ({ valid: false }),
    clear: async () => {
      clearCount += 1;
    },
    shouldClear: shouldClearAuthSession,
  });

  assert.equal(session, null);
  assert.equal(clearCount, 1);
});

test("network, timeout, rate limit, and server failures preserve a cached session", async () => {
  for (const error of [
    Object.assign(new Error("offline"), { isNetwork: true }),
    Object.assign(new Error("timeout"), { isTimeout: true }),
    Object.assign(new Error("rate limited"), { status: 429 }),
    Object.assign(new Error("backend unavailable"), { status: 503 }),
  ]) {
    const session = await restoreCachedSession({
      token: "cached-token",
      storedUser: cached,
      verify: async () => {
        throw error;
      },
      clear: async () => assert.fail("temporary failure must not clear session"),
      shouldClear: shouldClearAuthSession,
    });
    assert.equal(session.token, "cached-token");
  }
});

test("HTTP rate-limit and server responses cannot clear credentials even with valid false bodies", async () => {
  for (const status of [429, 500, 502, 503]) {
    let clearCount = 0;
    const session = await restoreCachedSession({
      token: "cached-token",
      storedUser: cached,
      verify: async () => ({
        status,
        data: { valid: false, error: "temporary service failure" },
      }),
      clear: async () => {
        clearCount += 1;
      },
      shouldClear: shouldClearAuthSession,
    });
    assert.equal(session.token, "cached-token");
    assert.equal(clearCount, 0);
  }
});

test("restart does not restore the web-only superadmin session", async () => {
  let clearCount = 0;
  const session = await restoreCachedSession({
    token: "web-admin-token",
    storedUser: JSON.stringify({ role: "superadmin" }),
    verify: async () => ({
      valid: true,
      user: { role: "superadmin" },
    }),
    clear: async () => {
      clearCount += 1;
    },
    shouldClear: shouldClearAuthSession,
  });
  assert.equal(session, null);
  assert.equal(clearCount, 1);
});

test("a temporary verification failure does not clear a cached superadmin token", async () => {
  let clearCount = 0;
  const session = await restoreCachedSession({
    token: "cached-admin-token",
    storedUser: JSON.stringify({ role: "superadmin" }),
    verify: async () => {
      throw new Error("backend unavailable");
    },
    clear: async () => {
      clearCount += 1;
    },
    shouldClear: shouldClearAuthSession,
  });
  assert.equal(session, null);
  assert.equal(clearCount, 0);
});

test("a session whose current role became superadmin is cleared after verification", async () => {
  let clearCount = 0;
  const session = await restoreCachedSession({
    token: "cached-token",
    storedUser: cached,
    verify: async () => ({
      valid: true,
      user: { role: "superadmin" },
    }),
    clear: async () => {
      clearCount += 1;
    },
    shouldClear: shouldClearAuthSession,
  });
  assert.equal(session, null);
  assert.equal(clearCount, 1);
});
