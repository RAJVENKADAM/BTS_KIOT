const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const AdministrativeChangeAudit = require("../src/models/AdministrativeChangeAudit");
const AssignmentPropagationOutbox = require("../src/models/AssignmentPropagationOutbox");
const User = require("../src/models/User");
const Notification = require("../src/models/Notification");
const {
  deleteSelectedUsers,
  getUsers,
  updateUser,
  updateUsersRole,
} = require("../src/controllers/superadminUser.controller");
const { mockGpsOwnershipTransactions } = require("./helpers/gpsOwnershipTransactionMock.cjs");
const { mockMutationIdempotency } = require("./helpers/mutationIdempotencyMock.cjs");

const gpsOwnershipTransactions = mockGpsOwnershipTransactions();
const mutationIdempotency = mockMutationIdempotency();
after(() => {
  gpsOwnershipTransactions.restore();
  mutationIdempotency.restore();
});

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
    assert.deepEqual(
      response.payload.users.map((user) => [
        user.resourceVersion,
        user.assignmentRevision,
      ]),
      [[0, 0], [0, 0]],
    );
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

test("cursor user listing applies server filters and bounds the database read", async () => {
  const originalFind = User.find;
  const originalCountDocuments = User.countDocuments;
  const records = [
    { _id: "64a000000000000000000001", name: "One" },
    { _id: "64a000000000000000000002", name: "Two" },
    { _id: "64a000000000000000000003", name: "Three" },
  ];
  let filter;
  let sort;
  let limit;
  User.find = (query) => {
    filter = query;
    return {
      select: () => ({
        sort: (value) => {
          sort = value;
          return {
            limit: (value) => {
              limit = value;
              return { lean: async () => records };
            },
          };
        },
      }),
    };
  };
  User.countDocuments = async () => 6;
  const response = {
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
      {
        query: {
          cursorMode: "true",
          limit: "2",
          role: "student",
          busNo: "bus-4",
          search: "student",
        },
      },
      response,
    );

    assert.equal(response.statusCode, 200);
    assert.deepEqual(filter, {
      is_active: { $ne: false },
      $or: [
        { name: /student/i },
        { email: /student/i },
        { role: /student/i },
        { bus_no: /student/i },
      ],
      role: "student",
      bus_no: "BUS-4",
    });
    assert.deepEqual(sort, { _id: 1 });
    assert.equal(limit, 3);
    assert.deepEqual(
      response.payload.users.map((user) => user.id),
      ["64a000000000000000000001", "64a000000000000000000002"],
    );
    assert.equal(
      response.payload.pagination.nextCursor,
      "64a000000000000000000002",
    );
    assert.equal(response.payload.pagination.hasNextPage, true);
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

test("rejects invalid cursor before querying users", async () => {
  const originalFind = User.find;
  User.find = () => {
    throw new Error("Must not query users for an invalid cursor.");
  };
  const response = {
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
    await getUsers({ query: { cursor: "invalid" } }, response);
    assert.equal(response.statusCode, 400);
    assert.equal(response.payload.success, false);
  } finally {
    User.find = originalFind;
  }
});

test("updates one authorized user's editable fields", async () => {
  const originalFindById = User.findById;
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  const originalAuditCreate = AdministrativeChangeAudit.create;
  const originalOutboxUpdateOne = AssignmentPropagationOutbox.updateOne;
  const updatedUser = {
    _id: "64a000000000000000000001",
    name: "Updated",
    email: "updated@example.test",
    role: "student",
    is_active: true,
    resourceVersion: 1,
    assignmentRevision: 1,
  };
  let write;
  User.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: "64a000000000000000000001",
        role: "student",
        is_active: true,
        bus_no: null,
        resourceVersion: 0,
        assignmentRevision: 0,
      }),
    }),
  });
  User.findOneAndUpdate = (filter, update, options) => {
    write = { filter, update, options };
    return { select: async () => updatedUser };
  };
  AdministrativeChangeAudit.create = async () => [];
  AssignmentPropagationOutbox.updateOne = async () => ({ upsertedCount: 1 });
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
        headers: { "idempotency-key": "edit-user-0001" },
        body: {
          name: "Updated",
          role: "student",
          bus_no: "12",
          expectedVersion: 0,
          expectedAssignmentRevision: 0,
        },
        user: { id: "64a000000000000000000099" },
      },
      response,
    );

    assert.deepEqual(write.filter, {
      $and: [
        { _id: "64a000000000000000000001" },
        { $or: [{ resourceVersion: 0 }, { resourceVersion: { $exists: false } }] },
        { $or: [{ assignmentRevision: 0 }, { assignmentRevision: { $exists: false } }] },
      ],
    });
    assert.deepEqual(write.update, {
      $set: { name: "Updated", role: "student", bus_no: "12" },
      $inc: { resourceVersion: 1, assignmentRevision: 1 },
    });
    assert.equal(write.options.new, true);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.user.name, "Updated");
  } finally {
    User.findById = originalFindById;
    User.findOneAndUpdate = originalFindOneAndUpdate;
    AdministrativeChangeAudit.create = originalAuditCreate;
    AssignmentPropagationOutbox.updateOne = originalOutboxUpdateOne;
  }
});

test("profile-only edits leave assignmentRevision unchanged", async () => {
  const originalFindById = User.findById;
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  let write;
  User.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: "64a000000000000000000003",
        role: "student",
        is_active: true,
        bus_no: "12",
        resourceVersion: 4,
        assignmentRevision: 2,
      }),
    }),
  });
  User.findOneAndUpdate = (filter, update) => {
    write = { filter, update };
    return {
      select: async () => ({
        _id: "64a000000000000000000003",
        name: "Updated",
        email: "student@example.test",
        role: "student",
        bus_no: "12",
        resourceVersion: 5,
        assignmentRevision: 2,
      }),
    };
  };
  const response = {
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
        params: { id: "64a000000000000000000003" },
        headers: { "idempotency-key": "edit-profile-0001" },
        body: { name: "Updated", expectedVersion: 4 },
        user: { id: "64a000000000000000000099" },
      },
      response,
    );
    assert.equal(response.statusCode, 200);
    assert.deepEqual(write.filter, {
      $and: [
        { _id: "64a000000000000000000003" },
        { resourceVersion: 4 },
      ],
    });
    assert.deepEqual(write.update, {
      $set: { name: "Updated" },
      $inc: { resourceVersion: 1 },
    });
  } finally {
    User.findById = originalFindById;
    User.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("rejects demoting the last active super admin through the edit endpoint", async () => {
  const originalFindById = User.findById;
  const originalCountDocuments = User.countDocuments;
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  let countReads = 0;
  User.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: "64a000000000000000000001",
        role: "superadmin",
        is_active: true,
        resourceVersion: 0,
        assignmentRevision: 0,
      }),
    }),
  });
  User.countDocuments = async () => (++countReads === 1 ? 2 : 1);
  User.findOneAndUpdate = () => {
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
        headers: { "idempotency-key": "edit-user-0002" },
        body: {
          role: "student",
          expectedVersion: 0,
          expectedAssignmentRevision: 0,
        },
        user: { id: "64a000000000000000000099" },
      },
      response,
    );

    assert.equal(response.statusCode, 409);
    assert.match(response.payload.error, /At least one active super admin/);
    assert.equal(countReads, 2);
  } finally {
    User.findById = originalFindById;
    User.countDocuments = originalCountDocuments;
    User.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("permanently deletes selected users and their notifications", async () => {
  const originalFind = User.find;
  const originalDeleteOne = User.deleteOne;
  const originalAuditCreate = AdministrativeChangeAudit.create;
  const originalOutboxUpdateOne = AssignmentPropagationOutbox.updateOne;
  const originalNotificationDeleteMany = Notification.deleteMany;
  const firstId = "64a000000000000000000001";
  const secondId = "64a000000000000000000002";
  const userDeleteFilters = [];
  let notificationDeleteFilter;
  User.find = () => ({
    select: () => ({
      lean: async () => [
        { _id: firstId, role: "student", is_active: true, resourceVersion: 2 },
        { _id: secondId, role: "primary_admin", is_active: true, resourceVersion: 4 },
      ],
    }),
  });
  User.deleteOne = async (filter) => {
    userDeleteFilters.push(filter);
    return { deletedCount: 1 };
  };
  AdministrativeChangeAudit.create = async () => [];
  AssignmentPropagationOutbox.updateOne = async () => ({ upsertedCount: 1 });
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
      {
        headers: { "idempotency-key": "delete-users-0001" },
        body: {
          ids: [firstId, secondId],
          expectedVersions: { [firstId]: 2, [secondId]: 4 },
        },
        user: { id: "64a000000000000000000099" },
      },
      response,
    );

    assert.deepEqual(userDeleteFilters, [
      { _id: firstId, $or: [{ resourceVersion: 2 }] },
      { _id: secondId, $or: [{ resourceVersion: 4 }] },
    ]);
    assert.deepEqual(notificationDeleteFilter, { user_id: { $in: [firstId, secondId] } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.deletedCount, 2);
  } finally {
    User.find = originalFind;
    User.deleteOne = originalDeleteOne;
    AdministrativeChangeAudit.create = originalAuditCreate;
    AssignmentPropagationOutbox.updateOne = originalOutboxUpdateOne;
    Notification.deleteMany = originalNotificationDeleteMany;
  }
});

test("rejects bulk role changes that would remove the last super admin", async () => {
  const originalFind = User.find;
  const originalCountDocuments = User.countDocuments;
  const firstId = "64a000000000000000000001";
  let countReads = 0;
  User.find = () => ({
    select: () => ({
      lean: async () => [{
        _id: firstId,
        role: "superadmin",
        is_active: true,
        resourceVersion: 0,
        assignmentRevision: 0,
      }],
    }),
  });
  User.countDocuments = async () => (++countReads === 1 ? 2 : 1);
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
      {
        headers: { "idempotency-key": "bulk-role-0001" },
        body: {
          ids: [firstId],
          role: "student",
          expectedVersions: { [firstId]: 0 },
          expectedAssignmentRevisions: { [firstId]: 0 },
        },
        user: { id: "64a000000000000000000099" },
      },
      response,
    );

    assert.equal(response.statusCode, 409);
    assert.match(response.payload.error, /At least one active super admin/);
    assert.equal(countReads, 2);
  } finally {
    User.find = originalFind;
    User.countDocuments = originalCountDocuments;
  }
});

test("rechecks superadmin access inside bulk deletion transaction", async () => {
  const originalFind = User.find;
  const originalCountDocuments = User.countDocuments;
  const originalDeleteOne = User.deleteOne;
  const firstId = "64a000000000000000000001";
  let countReads = 0;
  User.find = () => ({
    select: () => ({
      lean: async () => [{
        _id: firstId,
        role: "superadmin",
        is_active: true,
        resourceVersion: 0,
      }],
    }),
  });
  User.countDocuments = async () => (++countReads === 1 ? 2 : 1);
  User.deleteOne = () => {
    throw new Error("Must not delete the last super admin.");
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
      {
        headers: { "idempotency-key": "delete-admin-0001" },
        body: {
          ids: [firstId],
          expectedVersions: { [firstId]: 0 },
        },
        user: { id: "64a000000000000000000099" },
      },
      response,
    );

    assert.equal(response.statusCode, 409);
    assert.match(response.payload.error, /At least one active super admin/);
    assert.equal(countReads, 2);
  } finally {
    User.find = originalFind;
    User.countDocuments = originalCountDocuments;
    User.deleteOne = originalDeleteOne;
  }
});
