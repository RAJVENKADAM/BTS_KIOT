const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const ExcelUpload = require("../src/models/ExcelUpload");
const AdministrativeChangeAudit = require("../src/models/AdministrativeChangeAudit");
const AssignmentPropagationOutbox = require("../src/models/AssignmentPropagationOutbox");
const User = require("../src/models/User");
const { importUsers } = require("../src/controllers/importUsers.controller");
const excelUserService = require("../src/services/excelUserService");
const { setIO } = require("../src/socket");
const { mockGpsOwnershipTransactions } = require("./helpers/gpsOwnershipTransactionMock.cjs");
const { mockImportLedger } = require("./helpers/importLedgerMock.cjs");

const gpsOwnershipTransactions = mockGpsOwnershipTransactions();
const importLedgerMock = mockImportLedger();
after(() => {
  gpsOwnershipTransactions.restore();
  importLedgerMock.restore();
});

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

test("user import durably records an existing user's bus assignment change", async () => {
  const originals = {
    userFind: User.find,
    userBulkWrite: User.bulkWrite,
    uploadCreate: ExcelUpload.create,
    uploadUpdate: ExcelUpload.updateOne,
    auditCreate: AdministrativeChangeAudit.create,
    outboxUpdateOne: AssignmentPropagationOutbox.updateOne,
  };
  const notifications = createSocketCapture();
  const audits = [];
  const outboxWrites = [];
  const transactionsBefore = gpsOwnershipTransactions.calls;
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
  AdministrativeChangeAudit.create = async (documents) => {
    audits.push(...documents);
    return documents;
  };
  AssignmentPropagationOutbox.updateOne = async (filter, update) => {
    outboxWrites.push({ filter, update });
    return { upsertedCount: 1 };
  };

  try {
    const response = responseDouble();
    await importUsers(
      {
        user: { id: "admin-id" },
        get: () => "user-import-assignment-0001",
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
    assert.deepEqual(notifications, []);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor_id, "admin-id");
    assert.equal(audits[0].action, "spreadsheet-assignment-updated");
    assert.deepEqual(audits[0].previous_state, {
      role: "student",
      bus_no: "BUS-4",
      is_active: true,
      assignment_revision: 0,
    });
    assert.deepEqual(audits[0].new_state, {
      role: "student",
      bus_no: "BUS-9",
      is_active: true,
      assignment_revision: 1,
    });
    assert.equal(outboxWrites.length, 1);
    assert.deepEqual(
      outboxWrites[0].update.$setOnInsert.recipients[0].notification,
      {
        type: "bus_reassigned",
        message: "Your bus assignment changed to Bus BUS-9.",
        new_bus_no: "BUS-9",
      },
    );
    assert.equal(gpsOwnershipTransactions.calls, transactionsBefore + 1);
  } finally {
    User.find = originals.userFind;
    User.bulkWrite = originals.userBulkWrite;
    ExcelUpload.create = originals.uploadCreate;
    ExcelUpload.updateOne = originals.uploadUpdate;
    AdministrativeChangeAudit.create = originals.auditCreate;
    AssignmentPropagationOutbox.updateOne = originals.outboxUpdateOne;
    setIO(null);
  }
});

test("legacy spreadsheet updates durably record assignment changes", async () => {
  const originals = {
    userFind: User.find,
    userUpdateOne: User.updateOne,
    sendNotifications: excelUserService.sendNotifications,
    auditCreate: AdministrativeChangeAudit.create,
    outboxUpdateOne: AssignmentPropagationOutbox.updateOne,
  };
  const notifications = createSocketCapture();
  const audits = [];
  const outboxWrites = [];
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
  AdministrativeChangeAudit.create = async (documents) => {
    audits.push(...documents);
    return documents;
  };
  AssignmentPropagationOutbox.updateOne = async (filter, update) => {
    outboxWrites.push({ filter, update });
    return { upsertedCount: 1 };
  };

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
    assert.deepEqual(notifications, []);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor_id, "admin-id");
    assert.equal(audits[0].action, "workbook-assignment-updated");
    assert.deepEqual(audits[0].previous_state, {
      role: "student",
      bus_no: "BUS-4",
      is_active: true,
    });
    assert.deepEqual(audits[0].new_state, {
      role: "student",
      bus_no: "BUS-9",
      is_active: true,
    });
    assert.equal(outboxWrites.length, 1);
    assert.deepEqual(
      outboxWrites[0].update.$setOnInsert.recipients[0].notification,
      {
        type: "bus_reassigned",
        message: "Your bus assignment changed to Bus BUS-9.",
        new_bus_no: "BUS-9",
      },
    );
  } finally {
    User.find = originals.userFind;
    User.updateOne = originals.userUpdateOne;
    excelUserService.sendNotifications = originals.sendNotifications;
    AdministrativeChangeAudit.create = originals.auditCreate;
    AssignmentPropagationOutbox.updateOne = originals.outboxUpdateOne;
    setIO(null);
  }
});
