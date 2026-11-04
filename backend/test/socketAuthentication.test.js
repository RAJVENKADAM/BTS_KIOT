const assert = require("node:assert/strict");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const {
  createSocketAuthentication,
} = require("../src/socket/authenticateSocket");

const SECRET = "socket-auth-test-secret";

function authenticate(token, overrides = {}) {
  const socket = {
    handshake: {
      auth: token ? { token } : {},
      headers: {},
      ...overrides,
    },
  };
  const middleware = createSocketAuthentication(jwt, () => SECRET);
  return new Promise((resolve) => {
    middleware(socket, (error) => resolve({ error, socket }));
  });
}

test("socket authentication accepts valid JWT identity and normalizes its id", async () => {
  const token = jwt.sign(
    { id: 123, role: "student" },
    SECRET,
    { expiresIn: "1h" },
  );
  const { error, socket } = await authenticate(token);
  assert.equal(error, undefined);
  assert.equal(socket.user.id, "123");
  assert.equal(socket.user.role, "student");
});

test("socket authentication rejects invalid and expired JWTs", async () => {
  const invalid = await authenticate("not-a-jwt");
  assert.equal(invalid.error.message, "Invalid or expired token");

  const expiredToken = jwt.sign({ id: "student-1" }, SECRET, {
    expiresIn: -1,
  });
  const expired = await authenticate(expiredToken);
  assert.equal(expired.error.message, "Invalid or expired token");
});

test("socket authentication accepts the bearer header and rejects missing identity", async () => {
  const token = jwt.sign({ id: "admin-1", role: "primary_admin" }, SECRET);
  const { error, socket } = await authenticate(null, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(error, undefined);
  assert.equal(socket.user.id, "admin-1");

  const missingIdentity = await authenticate(jwt.sign({ role: "student" }, SECRET));
  assert.equal(missingIdentity.error.message, "Invalid or expired token");

  const missingToken = await authenticate(null);
  assert.equal(missingToken.error.message, "Authentication required");
});
