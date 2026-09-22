const test = require("node:test");
const assert = require("node:assert/strict");
const { authenticateToken, authorizeRoles } = require("../src/middleware/auth");

function responseDouble() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

test("authenticateToken rejects missing authorization", () => {
  const response = responseDouble();
  let nextCalled = false;
  authenticateToken({ headers: {} }, response, () => {
    nextCalled = true;
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.error, "Access token required");
  assert.equal(nextCalled, false);
});

test("authorizeRoles rejects a non-authorized role", () => {
  const response = responseDouble();
  let nextCalled = false;
  authorizeRoles("superadmin")(
    { user: { role: "student" } },
    response,
    () => {
      nextCalled = true;
    },
  );

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error, "Insufficient permissions");
  assert.equal(nextCalled, false);
});
