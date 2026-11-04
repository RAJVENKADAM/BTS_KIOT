const assert = require("node:assert/strict");
const { test } = require("node:test");
const User = require("../src/models/User");
const Notification = require("../src/models/Notification");
const {
  deleteSelectedUsers,
  getUsers,
  updateUser,
  updateUsersRole,
} = require("../src/controllers/superadminUser.controller");

test("lists authorized users and excludes deactivated accounts", async () => {
  const originalFind = User.find;
  const originalCountDocuments = User.countDocuments;
  const records = [
    { _id: "active-id", name: "Active", is_active: true },
    { _id: "legacy-id", name: "Legacy" },
  ];
  let filter;
  User.find = (query) => {
    filter = query;
    return {
      select: () => ({
        sort: () => ({
          skip: () => ({
            limit: () => ({ lean: async () => records }),
          }),
        }),
      }),
    };
  };
  User.countDocuments = async () => records.length;
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
    await getUsers({ query: {} }, response);

    assert.deepEqual(filter, { is_active: { $ne: false } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.payload.users.map((user) => user.id), [
      "active-id",
      "legacy-id",
    ]);
    assert.deepEqual(response.payload.pagination, {
      page: 1,
      limit: 100,
      total: 2,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
    });
  } finally {
    User.find = originalFind;
    User.countDocuments = originalCountDocuments;
  }
});

test("paginates superadmin users, clamps limits, and escapes search input", async () => {
  const originalFind = User.find;
  const originalCountDocuments = User.countDocuments;
  let filter;
  let skip;
  let limit;
  User.find = (query) => {
    filter = query;
    return {
      select: () => ({
        sort: () => ({
          skip: (value) => {
            skip = value;
            return {
              limit: (pageSize) => {
                limit = pageSize;
                return { lean: async () => [] };
              },
            };
          },
        }),
      }),
    };
  };
  User.countDocuments = async () => 0;
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
    await getUsers(
      { query: { page: "3", limit: "500", search: ".*" } },
      response,
    );

    assert.equal(response.statusCode, 200);
    assert.equal(skip, 400);
    assert.equal(limit, 200);
    assert.equal(filter.$or[0].name.source, "\\.\\*");
    assert.equal(response.payload.pagination.limit, 200);
    assert.equal(response.payload.pagination.hasPreviousPage, true);
  } finally {
    User.find = originalFind;
    User.countDocuments = originalCountDocuments;
  }
});

test("rejects invalid superadmin user pagination", async () => {
  const originalFind = User.find;
  User.find = () => {
    throw new Error("Must not query users for invalid pagination.");
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
    await getUsers({ query: { limit: "nope" } }, response);
    assert.equal(response.statusCode, 400);
    assert.equal(response.payload.success, false);
  } finally {
    User.find = originalFind;
  }
});

test("updates one authorized user's editable fields", async () => {
  const originalFindById = User.findById;
  const originalFindByIdAndUpdate = User.findByIdAndUpdate;
  const updatedUser = {
    _id: "64a000000000000000000001",
    name: "Updated",
    email: "updated@example.test",
    role: "student",
    is_active: true,
    select: () => updatedUser,
  };
  let update;
  User.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: "64a000000000000000000001",
        role: "student",
        is_active: true,
      }),
    }),
  });
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
      {
        params: { id: "64a000000000000000000001" },
        body: { name: "Updated", role: "student", bus_no: "12" },
        user: { id: "64a000000000000000000099" },
      },
      response,
    );

    assert.deepEqual(update, { name: "Updated", role: "student", bus_no: "12" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.user.name, "Updated");
  } finally {
    User.findById = originalFindById;
    User.findByIdAndUpdate = originalFindByIdAndUpdate;
  }
});

test("rejects demoting the last active super admin through the edit endpoint", async () => {
  const originalFindById = User.findById;
  const originalCountDocuments = User.countDocuments;
  const originalFindByIdAndUpdate = User.findByIdAndUpdate;
  User.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: "64a000000000000000000001",
        role: "superadmin",
        is_active: true,
      }),
    }),
  });
  User.countDocuments = async () => 1;
  User.findByIdAndUpdate = () => {
    throw new Error("Must not update the last super admin.");
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
      {
        params: { id: "64a000000000000000000001" },
        body: { role: "student" },
        user: { id: "64a000000000000000000099" },
      },
      response,
    );

    assert.equal(response.statusCode, 409);
    assert.match(response.payload.error, /At least one active super admin/);
  } finally {
    User.findById = originalFindById;
    User.countDocuments = originalCountDocuments;
    User.findByIdAndUpdate = originalFindByIdAndUpdate;
  }
});

test("permanently deletes selected users and their notifications", async () => {
  const originalFind = User.find;
  const originalDeleteMany = User.deleteMany;
  const originalNotificationDeleteMany = Notification.deleteMany;
  const firstId = "64a000000000000000000001";
  const secondId = "64a000000000000000000002";
  let userDeleteFilter;
  let notificationDeleteFilter;
  User.find = () => ({
    select: () => ({
      lean: async () => [
        { _id: firstId, role: "student", is_active: true },
        { _id: secondId, role: "primary_admin", is_active: true },
      ],
    }),
  });
  User.deleteMany = async (filter) => {
    userDeleteFilter = filter;
    return { deletedCount: 2 };
  };
  Notification.deleteMany = async (filter) => {
    notificationDeleteFilter = filter;
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
    await deleteSelectedUsers(
      { body: { ids: [firstId, secondId] }, user: { id: "64a000000000000000000099" } },
      response,
    );

    assert.deepEqual(userDeleteFilter, { _id: { $in: [firstId, secondId] } });
    assert.deepEqual(notificationDeleteFilter, { user_id: { $in: [firstId, secondId] } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.deletedCount, 2);
  } finally {
    User.find = originalFind;
    User.deleteMany = originalDeleteMany;
    Notification.deleteMany = originalNotificationDeleteMany;
  }
});

test("rejects bulk role changes that would remove the last super admin", async () => {
  const originalFind = User.find;
  const originalCountDocuments = User.countDocuments;
  const firstId = "64a000000000000000000001";
  User.find = () => ({
    select: () => ({
      lean: async () => [{ _id: firstId, role: "superadmin", is_active: true }],
    }),
  });
  User.countDocuments = async () => 1;
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
    await updateUsersRole(
      { body: { ids: [firstId], role: "student" }, user: { id: "64a000000000000000000099" } },
      response,
    );

    assert.equal(response.statusCode, 409);
    assert.match(response.payload.error, /At least one active super admin/);
  } finally {
    User.find = originalFind;
    User.countDocuments = originalCountDocuments;
  }
});
