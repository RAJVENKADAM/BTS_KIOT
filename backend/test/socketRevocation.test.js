const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const AdministrativeChangeAudit = require("../src/models/AdministrativeChangeAudit");
const AssignmentPropagationOutbox = require("../src/models/AssignmentPropagationOutbox");
const jwt = require("jsonwebtoken");
const User = require("../src/models/User");
const Notification = require("../src/models/Notification");
const ExcelUpload = require("../src/models/ExcelUpload");
const { setIO, disconnectUserSockets } = require("../src/socket");
const { deleteUserAccount } = require("../src/controllers/auth.controller");
const {
  deleteSelectedUsers,
  updateUser,
  updateUsersRole,
} = require("../src/controllers/superadminUser.controller");
const { deleteExcelUpload } = require("../src/controllers/excelManagement.controller");
const { createSocketAuthentication } = require("../src/socket/authenticateSocket");
const ownershipService = require("../src/services/gpsWorkerOwnership");
const { mockGpsOwnershipTransactions } = require("./helpers/gpsOwnershipTransactionMock.cjs");
const { mockMutationIdempotency } = require("./helpers/mutationIdempotencyMock.cjs");

const gpsOwnershipTransactions = mockGpsOwnershipTransactions();
const mutationIdempotency = mockMutationIdempotency();
const originalAuditCreate = AdministrativeChangeAudit.create;
const originalOutboxUpdateOne = AssignmentPropagationOutbox.updateOne;
const outboxRecords = [];
AdministrativeChangeAudit.create = async () => [];
AssignmentPropagationOutbox.updateOne = async (filter, update) => {
  outboxRecords.push({ filter, update });
  return { upsertedCount: 1 };
};
after(() => {
  gpsOwnershipTransactions.restore();
  mutationIdempotency.restore();
  AdministrativeChangeAudit.create = originalAuditCreate;
  AssignmentPropagationOutbox.updateOne = originalOutboxUpdateOne;
});

const SECRET = "socket-revocation-tests-only";
const firstId = "64a000000000000000000001";
const secondId = "64a000000000000000000002";
const adminId = "64a000000000000000000099";
const uploadId = "64a000000000000000000010";

function createRevocationSpy() {
  const calls = [];
  const operator = {
    rooms: new Set(),
    to(room) {
      this.rooms.add(room);
      return this;
    },
    disconnectSockets(close) {
      calls.push({ rooms: [...this.rooms], close });
      this.rooms.clear();
    },
  };
  setIO({
    to: operator.to.bind(operator),
  });
  return calls;
}

function responseDouble() {
  return {
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
}

function uploadDeleteRequest(key, expectedVersion = 0) {
  const headers = { "idempotency-key": key };
  return {
    params: { id: uploadId },
    user: { id: adminId, role: "superadmin" },
    body: { expectedVersion },
    headers,
    get(name) {
      return headers[name.toLowerCase()];
    },
  };
}

function queryDouble(value, onSession = () => {}) {
  return {
    select() {
      return this;
    },
    session(session) {
      onSession(session);
      return this;
    },
    lean() {
      return this;
    },
    then(resolve, reject) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
}

function setSelectedUsers(users) {
  const original = User.find;
  User.find = () => ({
    select() {
      return this;
    },
    lean: async () => users,
  });
  return () => {
    User.find = original;
  };
}

test("socket revocation disconnects only the union of targeted user rooms", () => {
  const calls = createRevocationSpy();
  assert.equal(disconnectUserSockets([firstId, firstId, null, secondId]), 2);
  assert.deepEqual(calls, [
    {
      rooms: [`user_${firstId}`, `user_${secondId}`],
      close: true,
    },
  ]);
});

test("self-deactivated account sockets are disconnected only after a successful update", async () => {
  const calls = createRevocationSpy();
  const transactionsBefore = gpsOwnershipTransactions.calls;
  const originalUpdateOne = User.updateOne;
  const res = responseDouble();
  User.updateOne = async () => ({ modifiedCount: 1 });
  try {
    await deleteUserAccount({ user: { id: firstId } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls[0].rooms, [`user_${firstId}`]);
    assert.equal(gpsOwnershipTransactions.calls, transactionsBefore + 1);
  } finally {
    User.updateOne = originalUpdateOne;
  }

  const failedCalls = createRevocationSpy();
  User.updateOne = async () => {
    throw new Error("database write failed");
  };
  const failedResponse = responseDouble();
  try {
    await deleteUserAccount({ user: { id: firstId } }, failedResponse);
    assert.equal(failedResponse.statusCode, 500);
    assert.deepEqual(failedCalls, []);
  } finally {
    User.updateOne = originalUpdateOne;
  }
});

test("Redis-mode account deactivation uses the ownership transaction session", async () => {
  const originalMode = process.env.SOCKET_IO_MODE;
  const originalTransaction = ownershipService.runGpsConfigurationTransaction;
  const originalUpdateOne = User.updateOne;
  const session = { transaction: "gps-configuration" };
  let updateOptions;
  process.env.SOCKET_IO_MODE = "redis";
  ownershipService.runGpsConfigurationTransaction = async (operation) =>
    operation(session);
  User.updateOne = async (_filter, _update, options) => {
    updateOptions = options;
    return { modifiedCount: 1 };
  };
  const res = responseDouble();

  try {
    await deleteUserAccount({ user: { id: firstId } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(updateOptions.session, session);
  } finally {
    ownershipService.runGpsConfigurationTransaction = originalTransaction;
    User.updateOne = originalUpdateOne;
    if (originalMode === undefined) delete process.env.SOCKET_IO_MODE;
    else process.env.SOCKET_IO_MODE = originalMode;
  }
});

test("successful bulk deletion revokes selected users but leaves other user rooms alone", async () => {
  const calls = createRevocationSpy();
  const restoreFind = setSelectedUsers([
    { _id: firstId, role: "student", is_active: true, resourceVersion: 0 },
    { _id: secondId, role: "primary_admin", is_active: true, resourceVersion: 0 },
  ]);
  const originalDeleteOne = User.deleteOne;
  const originalNotificationDeleteMany = Notification.deleteMany;
  User.deleteOne = async () => ({ deletedCount: 1 });
  Notification.deleteMany = async () => ({ deletedCount: 2 });
  const res = responseDouble();
  try {
    await deleteSelectedUsers(
      {
        headers: { "idempotency-key": "socket-delete-0001" },
        body: {
          ids: [firstId, secondId],
          expectedVersions: { [firstId]: 0, [secondId]: 0 },
        },
        user: { id: adminId },
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls[0].rooms, [`user_${firstId}`, `user_${secondId}`]);
  } finally {
    restoreFind();
    User.deleteOne = originalDeleteOne;
    Notification.deleteMany = originalNotificationDeleteMany;
  }
});

test("bulk role changes revoke only users whose role actually changed", async () => {
  const calls = createRevocationSpy();
  const restoreFind = setSelectedUsers([
    { _id: firstId, role: "student", is_active: true, resourceVersion: 0, assignmentRevision: 0 },
    { _id: secondId, role: "primary_admin", is_active: true, resourceVersion: 0, assignmentRevision: 0 },
  ]);
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  const writes = [];
  User.findOneAndUpdate = (filter, update, options) => {
    writes.push({ filter, update, options });
    return { select: async () => ({
      _id: filter.$and[0]._id,
      role: update.$set.role,
      resourceVersion: 1,
      assignmentRevision: filter.$and.length > 2 ? 1 : 0,
    }) };
  };
  const res = responseDouble();
  try {
    await updateUsersRole(
      {
        headers: { "idempotency-key": "socket-role-0001" },
        body: {
          ids: [firstId, secondId],
          role: "student",
          expectedVersions: { [firstId]: 0, [secondId]: 0 },
          expectedAssignmentRevisions: { [firstId]: 0, [secondId]: 0 },
        },
        user: { id: adminId },
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls[0].rooms, [`user_${secondId}`]);
    assert.equal(writes.length, 2);
    for (const write of writes) {
      assert.deepEqual(write.filter.$and[1], {
        $or: [{ resourceVersion: 0 }, { resourceVersion: { $exists: false } }],
      });
      assert.deepEqual(write.update.$inc.resourceVersion, 1);
    }
    assert.deepEqual(writes[0].update.$inc, { resourceVersion: 1 });
    assert.deepEqual(writes[1].update.$inc, {
      resourceVersion: 1,
      assignmentRevision: 1,
    });
  } finally {
    restoreFind();
    User.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("single-user role change revokes that user's existing socket", async () => {
  const calls = createRevocationSpy();
  const originalFindById = User.findById;
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  User.findById = () => ({
    select() {
      return this;
    },
    lean: async () => ({
      _id: firstId,
      role: "student",
      is_active: true,
      resourceVersion: 0,
      assignmentRevision: 0,
    }),
  });
  let write;
  User.findOneAndUpdate = (filter, update, options) => {
    write = { filter, update, options };
    return { select: async () => ({
      _id: firstId,
      name: "Student",
      email: "student@example.test",
      role: "primary_admin",
      bus_no: null,
      resourceVersion: 1,
      assignmentRevision: 1,
    }) };
  };
  const res = responseDouble();
  try {
    await updateUser(
      {
        params: { id: firstId },
        headers: { "idempotency-key": "socket-single-role-0001" },
        body: { role: "primary_admin", expectedVersion: 0, expectedAssignmentRevision: 0 },
        user: { id: adminId },
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls[0].rooms, [`user_${firstId}`]);
    assert.deepEqual(write.filter.$and, [
      { _id: firstId },
      { $or: [{ resourceVersion: 0 }, { resourceVersion: { $exists: false } }] },
      { $or: [{ assignmentRevision: 0 }, { assignmentRevision: { $exists: false } }] },
    ]);
    assert.deepEqual(write.update.$inc, { resourceVersion: 1, assignmentRevision: 1 });
  } finally {
    User.findById = originalFindById;
    User.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("bus assignment changes are durably queued for the affected user", async () => {
  const notifications = [];
  const originalFindById = User.findById;
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  User.findById = () => ({
    select() {
      return this;
    },
    lean: async () => ({
      _id: firstId,
      role: "student",
      is_active: true,
      bus_no: "BUS-4",
      resourceVersion: 0,
      assignmentRevision: 0,
    }),
  });
  let write;
  User.findOneAndUpdate = (filter, update, options) => {
    write = { filter, update, options };
    return { select: async () => ({
      _id: firstId,
      name: "Student",
      email: "student@example.test",
      role: "student",
      bus_no: "BUS-9",
      resourceVersion: 1,
      assignmentRevision: 1,
    }) };
  };
  setIO({
    to(room) {
      return {
        emit(event, payload) {
          notifications.push({ room, event, payload });
        },
      };
    },
  });
  const res = responseDouble();
  try {
    await updateUser(
      {
        params: { id: firstId },
        headers: { "idempotency-key": "socket-bus-change-0001" },
        body: {
          bus_no: "BUS-9",
          expectedVersion: 0,
          expectedAssignmentRevision: 0,
        },
        user: { id: adminId },
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(write.filter.$and, [
      { _id: firstId },
      { $or: [{ resourceVersion: 0 }, { resourceVersion: { $exists: false } }] },
      { $or: [{ assignmentRevision: 0 }, { assignmentRevision: { $exists: false } }] },
    ]);
    assert.deepEqual(write.update.$inc, { resourceVersion: 1, assignmentRevision: 1 });
    assert.deepEqual(notifications, []);
    assert.equal(
      outboxRecords.at(-1).update.$setOnInsert.operation,
      "student-assignment-updated",
    );
    assert.equal(
      String(outboxRecords.at(-1).update.$setOnInsert.recipients[0].user_id),
      firstId,
    );
    assert.equal(
      outboxRecords.at(-1).update.$setOnInsert.recipients[0].notification.type,
      "bus_reassigned",
    );
  } finally {
    User.findById = originalFindById;
    User.findOneAndUpdate = originalFindOneAndUpdate;
    setIO(null);
  }
});

test("failed bulk role mutation does not revoke any sockets", async () => {
  const calls = createRevocationSpy();
  const restoreFind = setSelectedUsers([
    { _id: firstId, role: "student", is_active: true, resourceVersion: 0, assignmentRevision: 0 },
  ]);
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  User.findOneAndUpdate = async () => {
    throw new Error("database write failed");
  };
  const res = responseDouble();
  try {
    await updateUsersRole(
      {
        headers: { "idempotency-key": "socket-role-fail-0001" },
        body: {
          ids: [firstId],
          role: "primary_admin",
          expectedVersions: { [firstId]: 0 },
          expectedAssignmentRevisions: { [firstId]: 0 },
        },
        user: { id: adminId },
      },
      res,
    );
    assert.equal(res.statusCode, 500);
    assert.deepEqual(calls, []);
  } finally {
    restoreFind();
    User.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("failed bulk account deactivation does not revoke sockets", async () => {
  const calls = createRevocationSpy();
  const originalUploadFindById = ExcelUpload.findById;
  const originalUploadFindOneAndUpdate = ExcelUpload.findOneAndUpdate;
  const originalUserFind = User.find;
  ExcelUpload.findById = () =>
    queryDouble({ uploaded_by: adminId, is_active: true, revision: 0 });
  ExcelUpload.findOneAndUpdate = () => {
    throw new Error("database write failed");
  };
  User.find = () => ({
    select() {
      return this;
    },
    lean: async () => [{ _id: firstId }],
  });
  const res = responseDouble();
  try {
    await deleteExcelUpload(uploadDeleteRequest("socket-delete-fail-0001"), res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(calls, []);
  } finally {
    ExcelUpload.findById = originalUploadFindById;
    ExcelUpload.findOneAndUpdate = originalUploadFindOneAndUpdate;
    User.find = originalUserFind;
  }
});

test("bulk spreadsheet deactivation revokes only linked users after the update succeeds", async () => {
  const calls = createRevocationSpy();
  const transactionsBefore = gpsOwnershipTransactions.calls;
  const linkedUsers = [{ _id: firstId }, { _id: secondId }];
  const originalUploadFindById = ExcelUpload.findById;
  const originalUploadFindOneAndUpdate = ExcelUpload.findOneAndUpdate;
  const originalUserFind = User.find;
  const originalBulkWrite = User.bulkWrite;
  ExcelUpload.findById = () =>
    queryDouble({ uploaded_by: adminId, is_active: true, revision: 0 });
  ExcelUpload.findOneAndUpdate = () =>
    queryDouble({ _id: uploadId, is_active: false, revision: 1 });
  User.find = () => ({
    select() {
      return this;
    },
    lean: async () => linkedUsers,
  });
  User.bulkWrite = async (operations) => ({
    matchedCount: operations.length,
  });
  const res = responseDouble();
  try {
    await deleteExcelUpload(uploadDeleteRequest("socket-delete-ok-0001"), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, [
      { rooms: [`user_${firstId}`, `user_${secondId}`], close: true },
    ]);
    assert.equal(
      outboxRecords.at(-1).update.$setOnInsert.operation,
      'spreadsheet-users-deactivated',
    );
    assert.deepEqual(
      outboxRecords.at(-1).update.$setOnInsert.recipients.map((item) =>
        String(item.user_id),
      ),
      [firstId, secondId],
    );
    assert.equal(gpsOwnershipTransactions.calls, transactionsBefore + 1);
  } finally {
    ExcelUpload.findById = originalUploadFindById;
    ExcelUpload.findOneAndUpdate = originalUploadFindOneAndUpdate;
    User.find = originalUserFind;
    User.bulkWrite = originalBulkWrite;
  }
});

test("Redis-mode spreadsheet deactivation uses one ownership session for all mutations", async () => {
  const originalMode = process.env.SOCKET_IO_MODE;
  const originalTransaction = ownershipService.runGpsConfigurationTransaction;
  const originals = {
    uploadFind: ExcelUpload.findById,
    uploadUpdate: ExcelUpload.findOneAndUpdate,
    userFind: User.find,
    userBulkWrite: User.bulkWrite,
  };
  const session = { transaction: "gps-configuration" };
  let querySession;
  let updateOptions;
  let uploadOptions;
  process.env.SOCKET_IO_MODE = "redis";
  ownershipService.runGpsConfigurationTransaction = async (operation) =>
    operation(session);
  ExcelUpload.findById = () =>
    queryDouble({ uploaded_by: adminId, is_active: true, revision: 0 }, (value) => {
      querySession = value;
    });
  ExcelUpload.findOneAndUpdate = (_filter, _update, options) => {
    uploadOptions = options;
    return queryDouble({ _id: uploadId, is_active: false, revision: 1 });
  };
  User.find = () =>
    queryDouble([{ _id: firstId }], (value) => {
      querySession = value;
    });
  User.bulkWrite = async (_operations, options) => {
    updateOptions = options;
    return { matchedCount: 1 };
  };
  const res = responseDouble();

  try {
    await deleteExcelUpload(uploadDeleteRequest("socket-delete-redis-0001"), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
    assert.equal(querySession, session);
    assert.equal(updateOptions.session, session);
    assert.equal(uploadOptions.session, session);
  } finally {
    ownershipService.runGpsConfigurationTransaction = originalTransaction;
    ExcelUpload.findById = originals.uploadFind;
    ExcelUpload.findOneAndUpdate = originals.uploadUpdate;
    User.find = originals.userFind;
    User.bulkWrite = originals.userBulkWrite;
    if (originalMode === undefined) delete process.env.SOCKET_IO_MODE;
    else process.env.SOCKET_IO_MODE = originalMode;
  }
});

test("reconnected sockets authenticate using current account status and role", async () => {
  const token = jwt.sign(
    { id: firstId, role: "student" },
    SECRET,
    { expiresIn: "1h" },
  );
  const currentUser = {
    role: "primary_admin",
    is_active: true,
    deleted_by_user: false,
  };
  const UserModel = {
    findById() {
      return {
        select() {
          return this;
        },
        lean: async () => currentUser,
      };
    },
  };
  const socket = {
    handshake: { auth: { token }, headers: {} },
  };
  let connectionError;
  await createSocketAuthentication(jwt, () => SECRET, UserModel)(
    socket,
    (error) => {
      connectionError = error;
    },
  );
  assert.equal(connectionError, undefined);
  assert.equal(socket.user.role, "primary_admin");

  currentUser.is_active = false;
  let reconnectError;
  await createSocketAuthentication(jwt, () => SECRET, UserModel)(
    { handshake: { auth: { token }, headers: {} } },
    (error) => {
      reconnectError = error;
    },
  );
  assert.equal(reconnectError.message, "Invalid or expired token");
});
