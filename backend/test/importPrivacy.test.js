const assert = require("node:assert/strict");
const test = require("node:test");
const ExcelUpload = require("../src/models/ExcelUpload");
const User = require("../src/models/User");
const { importUsers } = require("../src/controllers/importUsers.controller");
const ExcelUserService = require("../src/services/excelUserService");
const { uploadExcelUsers } = require("../src/controllers/organize.controller");

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

test("invalid user import reports safe row errors without logging spreadsheet data", async () => {
  const originalConsoleError = console.error;
  const originalCreate = ExcelUpload.create;
  const capturedLogs = [];
  console.error = (...values) => capturedLogs.push(values.join(" "));
  ExcelUpload.create = async () => {
    throw new Error("Must not create an upload when all rows are invalid.");
  };

  try {
    const response = responseDouble();
    await importUsers(
      {
        user: { id: "admin-id" },
        body: {
          users: [{
            name: "Sensitive Student",
            email: "private.student@example.test",
            role: "invalid-role",
            mobile_no: "5551234567",
            date_of_year: 2005,
          }],
        },
      },
      response,
    );

    const logs = capturedLogs.join("\n");
    assert.equal(response.statusCode, 400);
    assert.doesNotMatch(logs, /Sensitive Student|private\.student@example\.test|5551234567/);
    assert.equal(response.payload.summary.rowResults[0].index, 0);
    assert.equal(response.payload.summary.rowResults[0].reason, "Invalid role");
    assert.equal(response.payload.summary.failedRows, 1);
  } finally {
    console.error = originalConsoleError;
    ExcelUpload.create = originalCreate;
  }
});

test("legacy Excel upload keeps generated passwords out of its response", async () => {
  const originals = {
    processExcelBuffer: ExcelUserService.processExcelBuffer,
    processUsers: ExcelUserService.processUsers,
    sendNotifications: ExcelUserService.sendNotifications,
  };
  const generatedPassword = "private-generated-password";
  ExcelUserService.processExcelBuffer = async () => [];
  ExcelUserService.processUsers = async () => ({
    created: [{ email: "student@example.test", name: "Student" }],
    updated: [],
    skipped: [],
    emailsToNotify: [{
      email: "student@example.test",
      name: "Student",
      permanentPassword: generatedPassword,
      type: "new",
    }],
  });
  let sentNotification;
  ExcelUserService.sendNotifications = async (notifications) => {
    sentNotification = notifications[0];
    return [{ email: "student@example.test", status: "sent" }];
  };

  try {
    const response = responseDouble();
    await uploadExcelUsers(
      { file: { buffer: Buffer.from("mock") }, user: { id: "admin-id" } },
      response,
    );

    assert.equal(response.statusCode, 200);
    assert.equal(sentNotification.permanentPassword, generatedPassword);
    assert.equal(
      response.payload.details.emailsToNotify[0].permanentPassword,
      undefined,
    );
    assert.doesNotMatch(JSON.stringify(response.payload), /private-generated-password/);
  } finally {
    Object.assign(ExcelUserService, originals);
  }
});

test("legacy Excel upload returns a safe error instead of internal failure details", async () => {
  const originalProcessExcelBuffer = ExcelUserService.processExcelBuffer;
  const originalConsoleError = console.error;
  console.error = () => {};
  ExcelUserService.processExcelBuffer = async () => {
    throw new Error("sensitive database failure details");
  };
  try {
    const response = responseDouble();
    await uploadExcelUsers(
      { file: { buffer: Buffer.from("mock") }, user: { id: "admin-id" } },
      response,
    );
    assert.equal(response.statusCode, 500);
    assert.equal(response.payload.error, "Excel user upload failed. Please try again.");
  } finally {
    ExcelUserService.processExcelBuffer = originalProcessExcelBuffer;
    console.error = originalConsoleError;
  }
});
