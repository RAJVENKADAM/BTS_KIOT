const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const bcrypt = require("bcryptjs");
const XLSX = require("xlsx");
const ExcelUpload = require("../src/models/ExcelUpload");
const User = require("../src/models/User");
const { importUsers, IMPORT_BATCH_SIZE } = require("../src/controllers/importUsers.controller");
const { parseUserWorkbookUpload } = require("../src/middleware/spreadsheetImport");
const ownershipService = require("../src/services/gpsWorkerOwnership");
const { mockGpsOwnershipTransactions } = require("./helpers/gpsOwnershipTransactionMock.cjs");

const gpsOwnershipTransactions = mockGpsOwnershipTransactions();
after(() => gpsOwnershipTransactions.restore());

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

function createRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    name: `Student ${index}`,
    email: `student${index}@example.test`,
    role: "student",
    busno: "12",
    mobile_no: "9876543210",
    date_of_year: 2004,
  }));
}

async function withImportMocks(
  run,
  { bulkWrite, existingUsers = [], hash, find } = {},
) {
  const originals = {
    find: User.find,
    bulkWrite: User.bulkWrite,
    createUpload: ExcelUpload.create,
    updateUpload: ExcelUpload.updateOne,
    deleteUpload: ExcelUpload.deleteOne,
    hash: bcrypt.hash,
  };
  const batches = [];
  let uploadDeleted = false;
  const uploadUpdates = [];
  User.find = find || (() => ({
    select() {
      return this;
    },
    lean: async () => existingUsers,
  }));
  User.bulkWrite = async (operations, options) => {
    batches.push(operations);
    if (bulkWrite) return bulkWrite(operations, options, batches.length - 1);
    return { modifiedCount: 0, upsertedCount: operations.length };
  };
  ExcelUpload.create = async () => ({ _id: "synthetic-upload" });
  ExcelUpload.updateOne = async (...args) => {
    uploadUpdates.push(args);
    return { modifiedCount: 1 };
  };
  ExcelUpload.deleteOne = async () => {
    uploadDeleted = true;
    return { deletedCount: 1 };
  };
  bcrypt.hash = hash || (async (password, rounds) => {
    assert.equal(rounds, 10);
    return `synthetic-hash:${password}`;
  });

  try {
    await run({
      batches,
      uploadUpdates,
      get uploadDeleted() { return uploadDeleted; },
    });
  } finally {
    User.find = originals.find;
    User.bulkWrite = originals.bulkWrite;
    ExcelUpload.create = originals.createUpload;
    ExcelUpload.updateOne = originals.updateUpload;
    ExcelUpload.deleteOne = originals.deleteUpload;
    bcrypt.hash = originals.hash;
  }
}

test("large JSON imports hash and persist sequential bounded batches", async () => {
  await withImportMocks(async ({ batches, uploadUpdates }) => {
    const response = responseDouble();
    const users = createRows(250);
    await importUsers(
      { user: { id: "admin-id" }, body: { users } },
      response,
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.summary.totalRows, 250);
    assert.equal(response.payload.summary.validRows, 250);
    assert.equal(response.payload.summary.insertedRows, 250);
    assert.equal(response.payload.summary.failedRows, 0);
    assert.equal(response.payload.summary.completed, true);
    assert.deepEqual(batches.map((batch) => batch.length), [100, 100, 50]);
    assert.equal(
      uploadUpdates[0][1].$set.import_status,
      "completed",
    );
    assert.ok(batches.every((batch) =>
      batch.every((operation) => operation.updateOne.filter.email),
    ));
  });
});

test("Redis-mode assignment import passes the ownership transaction session to user writes", async () => {
  const originalMode = process.env.SOCKET_IO_MODE;
  const originalTransaction = ownershipService.runGpsConfigurationTransaction;
  const session = { transaction: "gps-configuration" };
  let writtenSession;
  process.env.SOCKET_IO_MODE = "redis";
  ownershipService.runGpsConfigurationTransaction = async (operation) =>
    operation(session);

  try {
    await withImportMocks(async () => {
      const response = responseDouble();
      await importUsers(
        { user: { id: "admin-id" }, body: { users: createRows(1) } },
        response,
      );
      assert.equal(response.statusCode, 200);
      assert.equal(writtenSession, session);
    }, {
      bulkWrite: async (_operations, options) => {
        writtenSession = options.session;
        return { modifiedCount: 0, upsertedCount: 1 };
      },
    });
  } finally {
    ownershipService.runGpsConfigurationTransaction = originalTransaction;
    if (originalMode === undefined) delete process.env.SOCKET_IO_MODE;
    else process.env.SOCKET_IO_MODE = originalMode;
  }
});

test("Redis import fences routing writes even when the initial user read is unchanged", async () => {
  const originalMode = process.env.SOCKET_IO_MODE;
  const originalTransaction = ownershipService.runGpsConfigurationTransaction;
  const session = { transaction: "stale-read-race" };
  let writeSession;
  let transactionCalls = 0;
  let currentBusNo = "12";
  process.env.SOCKET_IO_MODE = "redis";
  ownershipService.runGpsConfigurationTransaction = async (operation) => {
    transactionCalls += 1;
    currentBusNo = "99";
    return operation(session);
  };

  try {
    await withImportMocks(async () => {
      const response = responseDouble();
      await importUsers(
        { user: { id: "admin-id" }, body: { users: createRows(1) } },
        response,
      );
      assert.equal(response.statusCode, 200);
      assert.equal(transactionCalls, 1);
      assert.equal(writeSession, session);
      assert.equal(currentBusNo, "12");
    }, {
      existingUsers: [{
        _id: "existing-student",
        email: "student0@example.test",
        role: "student",
        bus_no: "12",
        is_active: true,
        deleted_by_user: false,
      }],
      bulkWrite: async (operations, options) => {
        assert.equal(currentBusNo, "99");
        writeSession = options.session;
        currentBusNo = operations[0].updateOne.update.$set.bus_no;
        return { modifiedCount: 1 };
      },
    });
  } finally {
    ownershipService.runGpsConfigurationTransaction = originalTransaction;
    if (originalMode === undefined) delete process.env.SOCKET_IO_MODE;
    else process.env.SOCKET_IO_MODE = originalMode;
  }
});

test("Redis import commits each row once and reports mixed row failures without replay", async () => {
  const originalMode = process.env.SOCKET_IO_MODE;
  const originalTransaction = ownershipService.runGpsConfigurationTransaction;
  const calls = [];
  const session = { transaction: "per-row" };
  process.env.SOCKET_IO_MODE = "redis";
  ownershipService.runGpsConfigurationTransaction = async (operation) =>
    operation(session);

  try {
    await withImportMocks(async () => {
      const response = responseDouble();
      await importUsers(
        { user: { id: "admin-id" }, body: { users: createRows(3) } },
        response,
      );

      assert.equal(response.statusCode, 200);
      assert.equal(response.payload.summary.insertedRows, 2);
      assert.equal(response.payload.summary.failedRows, 1);
      assert.deepEqual(
        response.payload.summary.rowResults.map((item) => item.index),
        [1],
      );
      assert.deepEqual(
        calls.map(({ emails }) => emails),
        [
          ["student0@example.test"],
          ["student1@example.test"],
          ["student2@example.test"],
        ],
      );
      assert.ok(calls.every(({ session: writeSession }) => writeSession === session));
    }, {
      bulkWrite: async (operations, options) => {
        calls.push({
          emails: operations.map((operation) => operation.updateOne.filter.email),
          session: options.session,
        });
        if (operations[0].updateOne.filter.email === "student1@example.test") {
          const error = new Error("rejected row");
          error.writeErrors = [{ index: 0 }];
          throw error;
        }
        return { upsertedCount: 1 };
      },
    });
  } finally {
    ownershipService.runGpsConfigurationTransaction = originalTransaction;
    if (originalMode === undefined) delete process.env.SOCKET_IO_MODE;
    else process.env.SOCKET_IO_MODE = originalMode;
  }
});

test("Redis import stops on an uncertain row without retrying it or later rows", async () => {
  const originalMode = process.env.SOCKET_IO_MODE;
  const originalTransaction = ownershipService.runGpsConfigurationTransaction;
  const calls = [];
  process.env.SOCKET_IO_MODE = "redis";
  ownershipService.runGpsConfigurationTransaction = async (operation) =>
    operation({ transaction: true });

  try {
    await withImportMocks(async () => {
      const response = responseDouble();
      await importUsers(
        { user: { id: "admin-id" }, body: { users: createRows(3) } },
        response,
      );
      assert.equal(response.payload.summary.insertedRows, 1);
      assert.equal(response.payload.summary.outcomeUnknown, true);
      assert.equal(response.payload.summary.failedRows, 2);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls, [
        "student0@example.test",
        "student1@example.test",
      ]);
    }, {
      bulkWrite: async (operations) => {
        const email = operations[0].updateOne.filter.email;
        calls.push(email);
        if (email === "student1@example.test") {
          throw new Error("ambiguous transaction result");
        }
        return { upsertedCount: 1 };
      },
    });
  } finally {
    ownershipService.runGpsConfigurationTransaction = originalTransaction;
    if (originalMode === undefined) delete process.env.SOCKET_IO_MODE;
    else process.env.SOCKET_IO_MODE = originalMode;
  }
});

test("synthetic XLSX rows are lazily iterated into sequential database batches", async () => {
  await withImportMocks(async ({ batches }) => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["name", "email", "busno", "role", "mobile_no", "date_of_year"],
        ...createRows(250).map((row) => [
          row.name,
          row.email,
          row.busno,
          row.role,
          row.mobile_no,
          row.date_of_year,
        ]),
      ]),
      "Users",
    );
    const request = {
      user: { id: "admin-id" },
      body: { excelCustomName: "synthetic" },
      file: {
        buffer: XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }),
      },
    };
    const response = responseDouble();
    let parserContinued = false;
    parseUserWorkbookUpload(request, response, () => {
      parserContinued = request.file.buffer === null;
    });

    await importUsers(request, response);
    assert.equal(parserContinued, true);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.summary.totalRows, 250);
    assert.equal(response.payload.summary.insertedRows, 250);
    assert.deepEqual(batches.map((batch) => batch.length), [100, 100, 50]);
  });
});

test("JSON imports have no 10,000-row ceiling", async () => {
  await withImportMocks(async ({ batches, uploadUpdates }) => {
    const response = responseDouble();
    await importUsers(
      { user: { id: "admin-id" }, body: { users: createRows(10005) } },
      response,
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.summary.totalRows, 10005);
    assert.equal(response.payload.summary.insertedRows, 10005);
    assert.equal(response.payload.summary.failedRows, 0);
    assert.equal(batches.length, 101);
    assert.equal(batches.at(-1).length, 5);
  });
});

test("concurrent imports keep password hashing concurrency bounded", async () => {
  let activeHashes = 0;
  let maximumActiveHashes = 0;
  await withImportMocks(async () => {
    const makeRequest = (suffix) => ({
      user: { id: `admin-${suffix}` },
      body: { users: createRows(8).map((row, index) => ({
        ...row,
        email: `student${suffix}-${index}@example.test`,
      })) },
    });
    const firstResponse = responseDouble();
    const secondResponse = responseDouble();
    await Promise.all([
      importUsers(makeRequest("one"), firstResponse),
      importUsers(makeRequest("two"), secondResponse),
    ]);

    assert.equal(firstResponse.statusCode, 200);
    assert.equal(secondResponse.statusCode, 200);
    assert.ok(maximumActiveHashes <= 4);
    assert.equal(activeHashes, 0);
  }, {
    hash: async (password) => {
      activeHashes += 1;
      maximumActiveHashes = Math.max(maximumActiveHashes, activeHashes);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeHashes -= 1;
      return `synthetic-hash:${password}`;
    },
  });
});

test("concurrent imports keep active database operations bounded per request", async () => {
  let activeOperations = 0;
  let maximumActiveOperations = 0;
  const withActiveOperation = async (result) => {
    activeOperations += 1;
    maximumActiveOperations = Math.max(
      maximumActiveOperations,
      activeOperations,
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    activeOperations -= 1;
    return result;
  };
  await withImportMocks(async () => {
    const makeRequest = (suffix) => ({
      user: { id: `admin-${suffix}` },
      body: {
        users: createRows(120).map((row, index) => ({
          ...row,
          email: `database${suffix}-${index}@example.test`,
        })),
      },
    });
    const firstResponse = responseDouble();
    const secondResponse = responseDouble();
    await Promise.all([
      importUsers(makeRequest("one"), firstResponse),
      importUsers(makeRequest("two"), secondResponse),
    ]);

    assert.equal(firstResponse.statusCode, 200);
    assert.equal(secondResponse.statusCode, 200);
    assert.ok(maximumActiveOperations <= 2);
    assert.equal(activeOperations, 0);
  }, {
    find: () => ({
      select() {
        return this;
      },
      lean: () => withActiveOperation([]),
    }),
    bulkWrite: async (operations) => withActiveOperation({
      modifiedCount: 0,
      upsertedCount: operations.length,
    }),
  });
});

test("duplicate identifiers across batch boundaries are reported and not written twice", async () => {
  await withImportMocks(async ({ batches, uploadUpdates }) => {
    const users = createRows(201);
    users[100].email = users[0].email.toUpperCase();
    const response = responseDouble();
    await importUsers(
      { user: { id: "admin-id" }, body: { users } },
      response,
    );

    assert.equal(response.payload.summary.duplicateRows, 1);
    assert.equal(response.payload.summary.insertedRows, 200);
    assert.equal(response.payload.summary.failedRows, 1);
    assert.equal(batches.flat().length, 200);
  });
});

test("a failed first database batch is reported and leaves no upload record", async () => {
  await withImportMocks(async (state) => {
    const response = responseDouble();
    await importUsers(
      { user: { id: "admin-id" }, body: { users: createRows(150) } },
      response,
    );

    assert.equal(response.statusCode, 500);
    assert.equal(response.payload.summary.insertedRows, 0);
    assert.equal(response.payload.summary.failedRows, 150);
    assert.equal(response.payload.summary.completed, false);
    assert.equal(state.uploadDeleted, true);
  }, {
    find: () => {
      throw new Error("simulated database read failure before writes");
    },
  });
});

test("unknown bulk-write outcomes retain a non-success upload record for reconciliation", async () => {
  await withImportMocks(async (state) => {
    const response = responseDouble();
    await importUsers(
      { user: { id: "admin-id" }, body: { users: createRows(150) } },
      response,
    );

    assert.equal(response.statusCode, 500);
    assert.equal(response.payload.summary.outcomeUnknown, true);
    assert.equal(response.payload.summary.partial, true);
    assert.equal(state.uploadDeleted, false);
    assert.equal(state.uploadUpdates[0][1].$set.import_status, "partial");
  }, {
    bulkWrite: async () => {
      throw new Error("simulated ambiguous database failure");
    },
  });
});

test("middle and final batch write errors produce accurate partial summaries", async (t) => {
  for (const failedBatch of [1, 2]) {
    await t.test(`batch ${failedBatch + 1}`, async () => {
      await withImportMocks(async ({ batches, uploadUpdates }) => {
        const response = responseDouble();
        await importUsers(
          { user: { id: "admin-id" }, body: { users: createRows(250) } },
          response,
        );

        assert.equal(response.statusCode, 200);
        assert.equal(response.payload.summary.totalRows, 250);
        assert.equal(response.payload.summary.insertedRows, 249);
        assert.equal(response.payload.summary.failedRows, 1);
        assert.equal(response.payload.summary.completed, true);
        assert.equal(response.payload.summary.partial, true);
        assert.equal(
          uploadUpdates[0][1].$set.import_status,
          "partial",
        );
        assert.equal(
          response.payload.summary.rowResults[0].index,
          failedBatch * IMPORT_BATCH_SIZE + 3,
        );
        assert.equal(batches.length, 3);
      }, {
        bulkWrite: async (operations, _options, batchIndex) => {
          if (batchIndex === failedBatch) {
            const error = new Error("simulated per-row failure");
            error.writeErrors = [{ index: 3 }];
            throw error;
          }
          return { modifiedCount: 0, upsertedCount: operations.length };
        },
      });
    });
  }
});

test("an import retry uses email-keyed upserts rather than creating duplicate identities", async () => {
  await withImportMocks(async ({ batches }) => {
    const users = createRows(1);
    const response = responseDouble();
    await importUsers(
      { user: { id: "admin-id" }, body: { users } },
      response,
    );

    assert.equal(
      batches[0][0].updateOne.filter.email,
      users[0].email,
    );
    assert.equal(batches[0][0].updateOne.upsert, true);
  });
});
