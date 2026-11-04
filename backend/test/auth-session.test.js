const assert = require("node:assert/strict");
const { test } = require("node:test");
const jwt = require("jsonwebtoken");
const User = require("../src/models/User");
const { verifyTokenPublic, logout } = require("../src/controllers/auth.controller");

const originalSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = "test-only-auth-session-secret";

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

async function verify(authorization, currentUser) {
  const originalFindById = User.findById;
  User.findById = () => ({
    select() {
      return this;
    },
    lean: async () => {
      if (currentUser instanceof Error) throw currentUser;
      return currentUser;
    },
  });
  const res = responseDouble();
  try {
    await verifyTokenPublic({ headers: { authorization } }, res);
  } finally {
    User.findById = originalFindById;
  }
  return res;
}

test("public verification preserves the valid response and uses the current database role", async () => {
  const token = jwt.sign(
    { id: "64b000000000000000000001", role: "student" },
    process.env.JWT_SECRET,
    { expiresIn: "24h" },
  );
  const response = await verify(`Bearer ${token}`, {
    role: "primary_admin",
    is_active: true,
    deleted_by_user: false,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.valid, true);
  assert.equal(response.body.user.role, "primary_admin");
});

test("public verification returns explicit invalid-session results for missing, malformed, and expired tokens", async () => {
  const expired = jwt.sign({ id: "64b000000000000000000001" }, process.env.JWT_SECRET, {
    expiresIn: "-1s",
  });
  for (const authorization of [undefined, "Bearer malformed", `Bearer ${expired}`]) {
    const response = await verify(authorization, null);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.valid, false);
  }
});

test("public verification identifies deactivated accounts but keeps database failures temporary", async () => {
  const token = jwt.sign({ id: "64b000000000000000000001" }, process.env.JWT_SECRET);
  const inactive = await verify(`Bearer ${token}`, {
    role: "student",
    is_active: false,
    deleted_by_user: false,
  });
  assert.equal(inactive.statusCode, 200);
  assert.equal(inactive.body.valid, false);
  assert.equal(inactive.body.deactivated, true);

  const failed = await verify(`Bearer ${token}`, new Error("private database detail"));
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.body.valid, false);
  assert.equal(JSON.stringify(failed.body).includes("private database detail"), false);
});

test("stateless logout preserves its established success response", async () => {
  const response = responseDouble();
  await logout({}, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.message, "Logout successful");
});

test.after(() => {
  if (originalSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
});
