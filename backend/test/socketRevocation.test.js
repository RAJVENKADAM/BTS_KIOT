const assert = require("node:assert/strict");
const { after, test } = require("node:test");
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

const gpsOwnershipTransactions = mockGpsOwnershipTransactions();
after(() => gpsOwnershipTransactions.restore());

const SECRET = "socket-revocation-tests-only";
const firstId = "64a000000000000000000001";
const secondId = "64a000000000000000000002";
const adminId = "64a000000000000000000099";

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
    { _id: firstId, role: "student", is_active: true },
    { _id: secondId, role: "primary_admin", is_active: true },
  ]);
  const originalDeleteMany = User.deleteMany;
  const originalNotificationDeleteMany = Notification.deleteMany;
  User.deleteMany = async () => ({ deletedCount: 2 });
  Notification.deleteMany = async () => ({ deletedCount: 2 });
  const res = responseDouble();
  try {
    await deleteSelectedUsers(
      { body: { ids: [firstId, secondId] }, user: { id: adminId } },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls[0].rooms, [`user_${firstId}`, `user_${secondId}`]);
  } finally {
    restoreFind();
    User.deleteMany = originalDeleteMany;
    Notification.deleteMany = originalNotificationDeleteMany;
  }
});

test("bulk role changes revoke only users whose role actually changed", async () => {
  const calls = createRevocationSpy();
  const restoreFind = setSelectedUsers([
    { _id: firstId, role: "student", is_active: true },
    { _id: secondId, role: "primary_admin", is_active: true },
  ]);
  const originalUpdateMany = User.updateMany;
  User.updateMany = async () => ({ modifiedCount: 1 });
  const res = responseDouble();
  try {
    await updateUsersRole(
      { body: { ids: [firstId, secondId], role: "student" }, user: { id: adminId } },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls[0].rooms, [`user_${secondId}`]);
  } finally {
    restoreFind();
    User.updateMany = originalUpdateMany;
  }
});

test("single-user role change revokes that user's existing socket", async () => {
  const calls = createRevocationSpy();
  const originalFindById = User.findById;
  const originalFindByIdAndUpdate = User.findByIdAndUpdate;
  User.findById = () => ({
    select() {
      return this;
    },
    lean: async () => ({
      _id: firstId,
      role: "student",
      is_active: true,
    }),
  });
  User.findByIdAndUpdate = () => ({
    select: async () => ({
      _id: firstId,
      name: "Student",
      email: "student@example.test",
      role: "primary_admin",
      bus_no: null,
    }),
  });
  const res = responseDouble();
  try {
    await updateUser(
      {
        params: { id: firstId },
        body: { role: "primary_admin" },
        user: { id: adminId },
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls[0].rooms, [`user_${firstId}`]);
  } finally {
    User.findById = originalFindById;
    User.findByIdAndUpdate = originalFindByIdAndUpdate;
  }
});

test("bus assignment changes notify only the affected user's socket room", async () => {
  const notifications = [];
  const originalFindById = User.findById;
  const originalFindByIdAndUpdate = User.findByIdAndUpdate;
  User.findById = () => ({
    select() {
      return this;
    },
    lean: async () => ({
      _id: firstId,
      role: "student",
      is_active: true,
      bus_no: "BUS-4",
    }),
  });
  User.findByIdAndUpdate = () => ({
    select: async () => ({
      _id: firstId,
      name: "Student",
      email: "student@example.test",
      role: "student",
      bus_no: "BUS-9",
    }),
  });
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
        body: { bus_no: "BUS-9" },
        user: { id: adminId },
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(notifications, [
      {
        room: `user_${firstId}`,
        event: "notification",
        payload: {
          type: "bus_reassigned",
          message: "Your bus assignment changed to Bus BUS-9.",
          assignmentBusNo: "BUS-9",
        },
      },
    ]);
  } finally {
    User.findById = originalFindById;
    User.findByIdAndUpdate = originalFindByIdAndUpdate;
    setIO(null);
  }
});

test("failed bulk role mutation does not revoke any sockets", async () => {
  const calls = createRevocationSpy();
  const restoreFind = setSelectedUsers([
    { _id: firstId, role: "student", is_active: true },
  ]);
  const originalUpdateMany = User.updateMany;
  User.updateMany = async () => {
    throw new Error("database write failed");
  };
  const res = responseDouble();
  try {
    await updateUsersRole(
      { body: { ids: [firstId], role: "primary_admin" }, user: { id: adminId } },
      res,
    );
    assert.equal(res.statusCode, 500);
    assert.deepEqual(calls, []);
  } finally {
    restoreFind();
    User.updateMany = originalUpdateMany;
  }
});

test("failed bulk account deactivation does not revoke sockets", async () => {
  const calls = createRevocationSpy();
  const originalUploadFindById = ExcelUpload.findById;
  const originalUserFind = User.find;
  const originalUpdateMany = User.updateMany;
  ExcelUpload.findById = () => ({ uploaded_by: adminId });
  User.find = () => ({
    select() {
      return this;
    },
    lean: async () => [{ _id: firstId }],
  });
  User.updateMany = async () => {
    throw new Error("database write failed");
  };
  const res = responseDouble();
  try {
    await deleteExcelUpload(
      { params: { id: "upload-1" }, user: { id: adminId, role: "superadmin" } },
      res,
    );
    assert.equal(res.statusCode, 500);
    assert.deepEqual(calls, []);
  } finally {
    ExcelUpload.findById = originalUploadFindById;
    User.find = originalUserFind;
    User.updateMany = originalUpdateMany;
  }
});

test("bulk spreadsheet deactivation revokes only linked users after the update succeeds", async () => {
  const calls = createRevocationSpy();
  const transactionsBefore = gpsOwnershipTransactions.calls;
  const linkedUsers = [{ _id: firstId }, { _id: secondId }];
  const originalUploadFindById = ExcelUpload.findById;
  const originalUploadDelete = ExcelUpload.deleteOne;
  const originalUserFind = User.find;
  const originalUpdateMany = User.updateMany;
  ExcelUpload.findById = () => ({
    uploaded_by: adminId,
  });
  ExcelUpload.deleteOne = async () => ({ deletedCount: 1 });
  User.find = () => ({
    select() {
      return this;
    },
    lean: async () => linkedUsers,
  });
  User.updateMany = async () => ({ modifiedCount: 2 });
  const res = responseDouble();
  try {
    await deleteExcelUpload(
      { params: { id: "upload-1" }, user: { id: adminId, role: "superadmin" } },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls[0].rooms, [`user_${firstId}`, `user_${secondId}`]);
    assert.equal(gpsOwnershipTransactions.calls, transactionsBefore + 1);
  } finally {
    ExcelUpload.findById = originalUploadFindById;
    ExcelUpload.deleteOne = originalUploadDelete;
    User.find = originalUserFind;
    User.updateMany = originalUpdateMany;
  }
});

test("Redis-mode spreadsheet deactivation uses one ownership session for all mutations", async () => {
  const originalMode = process.env.SOCKET_IO_MODE;
  const originalTransaction = ownershipService.runGpsConfigurationTransaction;
  const originals = {
    uploadFind: ExcelUpload.findById,
    uploadDelete: ExcelUpload.deleteOne,
    userFind: User.find,
    userUpdate: User.updateMany,
  };
  const session = { transaction: "gps-configuration" };
  let querySession;
  let updateOptions;
  let deleteOptions;
  process.env.SOCKET_IO_MODE = "redis";
  ownershipService.runGpsConfigurationTransaction = async (operation) =>
    operation(session);
  ExcelUpload.findById = () => ({ uploaded_by: adminId });
  ExcelUpload.deleteOne = async (_filter, options) => {
    deleteOptions = options;
    return { deletedCount: 1 };
  };
  User.find = () => ({
    select() {
      return this;
    },
    session(value) {
      querySession = value;
      return this;
    },
    lean: async () => [{ _id: firstId }],
  });
  User.updateMany = async (_filter, _update, options) => {
    updateOptions = options;
    return { modifiedCount: 1 };
  };
  const res = responseDouble();

  try {
    await deleteExcelUpload(
      { params: { id: "upload-1" }, user: { id: adminId, role: "superadmin" } },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(querySession, session);
    assert.equal(updateOptions.session, session);
    assert.equal(deleteOptions.session, session);
  } finally {
    ownershipService.runGpsConfigurationTransaction = originalTransaction;
    ExcelUpload.findById = originals.uploadFind;
    ExcelUpload.deleteOne = originals.uploadDelete;
    User.find = originals.userFind;
    User.updateMany = originals.userUpdate;
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
