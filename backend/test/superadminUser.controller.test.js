const assert = require("node:assert/strict");
const { test } = require("node:test");
const User = require("../src/models/User");
const { getUsers, updateUser } = require("../src/controllers/superadminUser.controller");

test("lists active, inactive, and legacy users", async () => {
  const originalFind = User.find;
  const records = [
    { _id: "active-id", name: "Active", is_active: true },
    { _id: "inactive-id", name: "Inactive", is_active: false },
    { _id: "legacy-id", name: "Legacy" },
  ];
  let filter;
  User.find = (query) => {
    filter = query;
    return {
      select: () => ({
        sort: () => ({
          lean: async () => records,
        }),
      }),
    };
  };
  const response = {
    statusCode: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };

  try {
    await getUsers({}, response);

    assert.deepEqual(filter, {});
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.payload.users.map((user) => user.id), [
      "active-id",
      "inactive-id",
      "legacy-id",
    ]);
  } finally {
    User.find = originalFind;
  }
});

test("reactivates an inactive user through the update endpoint", async () => {
  const originalFindByIdAndUpdate = User.findByIdAndUpdate;
  const updatedUser = {
    _id: "inactive-id",
    name: "Inactive",
    email: "inactive@example.test",
    role: "student",
    is_active: true,
    deleted_by_user: false,
    select: () => updatedUser,
  };
  let update;
  User.findByIdAndUpdate = (_id, fields) => {
    update = fields;
    return {
      select: async () => updatedUser,
    };
  };
  const response = {
    statusCode: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };

  try {
    await updateUser(
      { params: { id: "inactive-id" }, body: { is_active: true } },
      response,
    );

    assert.deepEqual(update, { is_active: true, deleted_by_user: false });
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.user.is_active, true);
  } finally {
    User.findByIdAndUpdate = originalFindByIdAndUpdate;
  }
});
