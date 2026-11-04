const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const User = require("../src/models/User");
const {
  authenticateToken,
  authorizeRoles,
} = require("../src/middleware/auth");

const originalSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = "test-only-auth-middleware-secret";

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

function makeToken(claims = {}, options = {}) {
  return jwt.sign(
    { id: "64b000000000000000000001", role: "student", ...claims },
    process.env.JWT_SECRET,
    options,
  );
}

async function authenticate(authorization, currentUser) {
  const originalFindById = User.findById;
  let selectedFields;
  User.findById = () => ({
    select(fields) {
      selectedFields = fields;
      return this;
    },
    lean: async () => currentUser,
  });

  const req = { headers: { authorization } };
  const res = responseDouble();
  let nextCalled = false;
  try {
    await authenticateToken(req, res, () => {
      nextCalled = true;
    });
  } finally {
    User.findById = originalFindById;
  }
  return { req, res, nextCalled, selectedFields };
}

test("authenticateToken rejects missing and non-Bearer authorization", async () => {
  for (const authorization of [undefined, "Basic valid-token", "Bearer token extra"]) {
    const { res, nextCalled } = await authenticate(authorization, null);
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
  }
});

test("authenticateToken rejects malformed and expired JWTs with 401", async () => {
  const malformed = await authenticate("Bearer not-a-jwt", null);
  const expired = await authenticate(
    `Bearer ${makeToken({}, { expiresIn: "-1s" })}`,
    null,
  );
  assert.equal(malformed.res.statusCode, 401);
  assert.equal(malformed.res.body.code, "INVALID_TOKEN");
  assert.equal(expired.res.statusCode, 401);
  assert.equal(expired.res.body.code, "INVALID_TOKEN");
});

test("authenticateToken uses current database account state and role", async () => {
  const valid = await authenticate(`Bearer ${makeToken({ role: "superadmin" })}`, {
    role: "student",
    is_active: true,
    deleted_by_user: false,
  });
  assert.equal(valid.res.statusCode, 200);
  assert.equal(valid.nextCalled, true);
  assert.equal(valid.req.user.role, "student");
  assert.equal(valid.req.user.id, "64b000000000000000000001");
  assert.match(valid.selectedFields, /role/);
  assert.match(valid.selectedFields, /is_active/);

  for (const user of [
    null,
    { role: "student", is_active: false, deleted_by_user: false },
    { role: "student", is_active: true, deleted_by_user: true },
  ]) {
    const rejected = await authenticate(`Bearer ${makeToken()}`, user);
    assert.equal(rejected.res.statusCode, 401);
    assert.equal(rejected.nextCalled, false);
  }
});

test("database failures return a safe authentication service error", async () => {
  const originalFindById = User.findById;
  User.findById = () => ({
    select() {
      return this;
    },
    lean: async () => {
      throw new Error("private database detail");
    },
  });
  const res = responseDouble();
  try {
    await authenticateToken(
      { headers: { authorization: `Bearer ${makeToken()}` } },
      res,
      () => assert.fail("next must not be called"),
    );
  } finally {
    User.findById = originalFindById;
  }
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, "AUTH_UNAVAILABLE");
  assert.equal(JSON.stringify(res.body).includes("private database detail"), false);
});

test("authorizeRoles allows each existing role and rejects other roles", () => {
  for (const role of ["student", "primary_admin", "superadmin"]) {
    const res = responseDouble();
    let nextCalled = false;
    authorizeRoles(role)(
      { user: { role: role.toUpperCase() } },
      res,
      () => {
        nextCalled = true;
      },
    );
    assert.equal(nextCalled, true);
  }

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

test.after(() => {
  if (originalSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
});
