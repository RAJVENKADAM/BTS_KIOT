const assert = require("node:assert/strict");
const { test } = require("node:test");
const ExcelUpload = require("../src/models/ExcelUpload");
const User = require("../src/models/User");
const { importUsers } = require("../src/controllers/importUsers.controller");
const excelUserService = require("../src/services/excelUserService");
const { setIO } = require("../src/socket");

const userId = "64a000000000000000000001";

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

function createSocketCapture() {
  const notifications = [];
  setIO({
    to(room) {
      return {
        emit(event, payload) {
          notifications.push({ room, event, payload });
        },
      };
    },
  });
  return notifications;
}

function expectedAssignmentNotification(busNumber) {
  return {
    room: `user_${userId}`,
    event: "notification",
    payload: {
      type: busNumber ? "bus_reassigned" : "bus_unassigned",
      message: busNumber
        ? `Your bus assignment changed to Bus ${busNumber}.`
        : "Your bus assignment was removed.",
      assignmentBusNo: busNumber,
    },
  };
}

test("user import notifies an active session when an existing user's bus changes", async () => {
  const originals = {
    userFind: User.find,
    userBulkWrite: User.bulkWrite,
    uploadCreate: ExcelUpload.create,
    uploadUpdate: ExcelUpload.updateOne,
  };
  const notifications = createSocketCapture();
  const existingUser = {
    _id: userId,
    name: "Student",
    email: "student@example.test",
    role: "student",
    bus_no: "BUS-4",
    is_active: true,
    deleted_by_user: false,
  };
  User.find = () => ({
    select() {
      return this;
    },
    lean: async () => [existingUser],
  });
  User.bulkWrite = async () => ({ modifiedCount: 1, upsertedCount: 0 });
  ExcelUpload.create = async () => ({ _id: "upload-id" });
  ExcelUpload.updateOne = async () => ({ modifiedCount: 1 });

  try {
    const response = responseDouble();
    await importUsers(
      {
        user: { id: "admin-id" },
        body: {
          users: [{
            name: "Student",
            email: "student@example.test",
            busno: "BUS-9",
            role: "student",
            mobile_no: "9876543210",
            date_of_year: 2004,
          }],
        },
      },
      response,
    );

    assert.equal(response.statusCode, 200);
    assert.deepEqual(notifications, [expectedAssignmentNotification("BUS-9")]);
  } finally {
    User.find = originals.userFind;
    User.bulkWrite = originals.userBulkWrite;
    ExcelUpload.create = originals.uploadCreate;
    ExcelUpload.updateOne = originals.uploadUpdate;
    setIO(null);
  }
});

test("legacy spreadsheet user updates notify assignment changes", async () => {
  const originals = {
    userFind: User.find,
    userUpdateOne: User.updateOne,
    sendNotifications: excelUserService.sendNotifications,
  };
  const notifications = createSocketCapture();
  const existingUser = {
    _id: userId,
    email: "student@example.test",
    role: "student",
    bus_no: "BUS-4",
  };
  User.find = (filter) => {
    const query = {
      select() {
        return this;
      },
      lean() {
        return filter.email ? Promise.resolve([existingUser]) : this;
      },
      cursor: () => ({
        async *[Symbol.asyncIterator]() {},
      }),
    };
    return query;
  };
  User.updateOne = async () => ({ modifiedCount: 1 });
  excelUserService.sendNotifications = async () => [];

  try {
    const result = await excelUserService.processUsers(
      [{
        name: "Student",
        email: "student@example.test",
        role: "student",
        bus_no: "BUS-9",
        phone: "9876543210",
        dob: "2004",
      }],
      "admin-id",
    );
    assert.equal(result.updated.length, 1);
    assert.deepEqual(notifications, [expectedAssignmentNotification("BUS-9")]);
  } finally {
    User.find = originals.userFind;
    User.updateOne = originals.userUpdateOne;
    excelUserService.sendNotifications = originals.sendNotifications;
    setIO(null);
  }
});
