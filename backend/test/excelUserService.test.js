const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const User = require("../src/models/User");
const excelUserService = require("../src/services/excelUserService");
const { mockGpsOwnershipTransactions } = require("./helpers/gpsOwnershipTransactionMock.cjs");

const gpsOwnershipTransactions = mockGpsOwnershipTransactions();
after(() => gpsOwnershipTransactions.restore());

test("legacy spreadsheet processing projects only required fields and matches rows in memory", async () => {
  const originalFind = User.find;
  const originalUpdateOne = User.updateOne;
  const originalSendNotifications = excelUserService.sendNotifications;
  const rowCount = 1_000;
  const existingUsers = Array.from({ length: rowCount }, (_, index) => ({
    _id: `user-${index}`,
    email: `student${index}@example.test`,
    name: `Student ${index}`,
    role: "student",
    bus_no: "BUS-1",
  }));
  let filter;
  const projections = [];
  let queryCount = 0;
  let updateCount = 0;

  User.find = (query) => {
    queryCount += 1;
    filter = query;
    return {
      select(fields) {
        projections.push(fields);
        return this;
      },
      lean() {
        return query.email ? Promise.resolve(existingUsers) : this;
      },
      cursor: () => ({
        async *[Symbol.asyncIterator]() {},
      }),
    };
  };
  User.updateOne = async () => {
    updateCount += 1;
    return { modifiedCount: 0 };
  };
  excelUserService.sendNotifications = async (notifications) =>
    notifications.map(({ email }) => ({ email, status: "sent" }));

  try {
    const users = existingUsers.map((user) => ({
      email: user.email,
      name: user.name,
      role: user.role,
      bus_no: user.bus_no,
      phone: "9876543210",
      dob: "2004",
    }));
    const result = await excelUserService.processUsers(users, "admin-id");

    assert.ok(filter.email?.$in);
    assert.ok(projections.some((fields) =>
      fields.startsWith("_id email name role bus_no"),
    ));
    assert.equal(queryCount, 10);
    assert.equal(updateCount, rowCount);
    assert.equal(result.updated.length, rowCount);
    assert.equal(result.created.length, 0);
    assert.equal(result.skipped.length, 0);
  } finally {
    User.find = originalFind;
    User.updateOne = originalUpdateOne;
    excelUserService.sendNotifications = originalSendNotifications;
  }
});

async function withLegacyUserDatabase(run) {
  const originals = {
    find: User.find,
    updateOne: User.updateOne,
    create: User.create,
    sendNotifications: excelUserService.sendNotifications,
  };
  const accounts = new Map();
  const updateFilters = [];
  User.find = (filter) => ({
    select() {
      return this;
    },
    lean: async () => {
      const emails = filter.email?.$in || [];
      return emails
        .map((email) => accounts.get(email))
        .filter(Boolean)
        .map((account) => ({ ...account }));
    },
  });
  User.updateOne = async (filter, update) => {
    updateFilters.push({ filter, update });
    const account = accounts.get(filter.email);
    if (!account) return { modifiedCount: 0 };
    Object.assign(account, update);
    return { modifiedCount: 1 };
  };
  User.create = async (input) => {
    if (accounts.has(input.email)) {
      const error = new Error("Duplicate email");
      error.code = 11000;
      throw error;
    }
    const account = {
      _id: `user-${accounts.size}`,
      is_active: true,
      ...input,
    };
    accounts.set(input.email, account);
    return account;
  };
  excelUserService.sendNotifications = async (notifications) =>
    notifications.map(({ email }) => ({ email, status: "sent" }));

  try {
    await run({ accounts, updateFilters });
  } finally {
    User.find = originals.find;
    User.updateOne = originals.updateOne;
    User.create = originals.create;
    excelUserService.sendNotifications = originals.sendNotifications;
  }
}

function createLegacyRows(start, count) {
  return Array.from({ length: count }, (_, index) => {
    const number = start + index;
    return {
      name: `Student ${number}`,
      email: `student${number}@example.test`,
      role: "student",
      bus_no: "12",
      phone: "9876543210",
      dob: "2004",
    };
  });
}

test("separate legacy uploads add 100 distinct students without deactivating the first group", async () => {
  await withLegacyUserDatabase(async ({ accounts, updateFilters }) => {
    const first = await excelUserService.processUsers(
      createLegacyRows(0, 100),
      "admin-id",
    );
    const second = await excelUserService.processUsers(
      createLegacyRows(100, 100),
      "admin-id",
    );

    assert.equal(first.summary.created, 100);
    assert.equal(second.summary.created, 100);
    assert.equal(accounts.size, 200);
    assert.ok([...accounts.values()].every((account) => account.is_active));
    assert.ok(updateFilters.every(({ filter }) => filter.email));
  });
});

test("re-uploading an existing email updates that account instead of creating another", async () => {
  await withLegacyUserDatabase(async ({ accounts }) => {
    accounts.set("student1@example.test", {
      _id: "existing-student",
      email: "student1@example.test",
      name: "Old Name",
      role: "student",
      bus_no: "12",
      is_active: true,
    });

    const result = await excelUserService.processUsers(
      createLegacyRows(1, 1),
      "admin-id",
    );

    assert.equal(result.summary.created, 0);
    assert.equal(result.summary.updated, 1);
    assert.equal(accounts.size, 1);
    assert.equal(accounts.get("student1@example.test").name, "Student 1");
    assert.equal(accounts.get("student1@example.test").is_active, true);
  });
});

test("legacy spreadsheet assignment changes use MongoDB ownership transactions", async () => {
  await withLegacyUserDatabase(async ({ accounts }) => {
    accounts.set("student1@example.test", {
      _id: "existing-student",
      email: "student1@example.test",
      name: "Student 1",
      role: "student",
      bus_no: "4",
      is_active: true,
    });
    const transactionsBefore = gpsOwnershipTransactions.calls;
    const result = await excelUserService.processUsers(
      [{ ...createLegacyRows(1, 1)[0], bus_no: "9" }],
      "admin-id",
    );

    assert.equal(result.summary.updated, 1);
    assert.equal(gpsOwnershipTransactions.calls, transactionsBefore + 1);
  });
});

test("legacy spreadsheet profile-only updates avoid GPS ownership transactions", async () => {
  await withLegacyUserDatabase(async ({ accounts }) => {
    accounts.set("student1@example.test", {
      _id: "existing-student",
      email: "student1@example.test",
      name: "Old Name",
      role: "student",
      bus_no: "12",
      is_active: true,
    });
    const transactionsBefore = gpsOwnershipTransactions.calls;
    const result = await excelUserService.processUsers(
      createLegacyRows(1, 1),
      "admin-id",
    );
    assert.equal(result.summary.updated, 1);
    assert.equal(gpsOwnershipTransactions.calls, transactionsBefore);
    assert.equal(accounts.get("student1@example.test").name, "Student 1");
  });
});

test("profile-only Excel update cannot overwrite a concurrent bus assignment", async () => {
  await withLegacyUserDatabase(async ({ accounts, updateFilters }) => {
    const account = {
      _id: "existing-student",
      email: "student1@example.test",
      name: "Old Name",
      role: "student",
      bus_no: "12",
      is_active: true,
    };
    accounts.set(account.email, account);
    const originalUpdateOne = User.updateOne;
    User.updateOne = async (filter, update) => {
      account.bus_no = "99";
      updateFilters.push({ filter, update });
      Object.assign(account, update);
      return { modifiedCount: 1 };
    };

    try {
      const result = await excelUserService.processUsers(
        createLegacyRows(1, 1),
        "admin-id",
      );
      assert.equal(result.summary.updated, 1);
      assert.deepEqual(Object.keys(updateFilters[0].update), ["name"]);
      assert.equal(account.bus_no, "99");
    } finally {
      User.updateOne = originalUpdateOne;
    }
  });
});

test("matching inactive email is reported as skipped and remains inactive", async () => {
  await withLegacyUserDatabase(async ({ accounts }) => {
    accounts.set("student1@example.test", {
      _id: "inactive-student",
      email: "student1@example.test",
      name: "Student 1",
      role: "student",
      bus_no: "12",
      is_active: false,
    });

    const result = await excelUserService.processUsers(
      createLegacyRows(1, 1),
      "admin-id",
    );

    assert.equal(result.summary.created, 0);
    assert.equal(result.summary.updated, 0);
    assert.equal(result.summary.skippedRows, 1);
    assert.equal(result.summary.failedRows, 0);
    assert.equal(result.summary.partial, true);
    assert.equal(result.summary.rowResults[0].status, "skipped");
    assert.equal(accounts.size, 1);
    assert.equal(accounts.get("student1@example.test").is_active, false);
  });
});

test("invalid legacy rows leave unrelated existing students active", async () => {
  await withLegacyUserDatabase(async ({ accounts, updateFilters }) => {
    accounts.set("unrelated@example.test", {
      _id: "unrelated-student",
      email: "unrelated@example.test",
      name: "Unrelated Student",
      role: "student",
      bus_no: "12",
      is_active: true,
    });

    const result = await excelUserService.processUsers(
      [{ ...createLegacyRows(1, 1)[0], email: "invalid-email" }],
      "admin-id",
    );

    assert.equal(result.summary.failedRows, 1);
    assert.equal(accounts.get("unrelated@example.test").is_active, true);
    assert.equal(updateFilters.length, 0);
  });
});

test("legacy database failures do not deactivate previously imported students", async () => {
  await withLegacyUserDatabase(async ({ accounts, updateFilters }) => {
    accounts.set("previous@example.test", {
      _id: "previous-student",
      email: "previous@example.test",
      name: "Previously Imported",
      role: "student",
      bus_no: "12",
      is_active: true,
    });
    const originalCreate = User.create;
    User.create = async () => {
      throw new Error("Synthetic database failure");
    };

    try {
      const result = await excelUserService.processUsers(
        createLegacyRows(1, 1),
        "admin-id",
      );
      assert.equal(result.summary.completed, false);
      assert.equal(result.summary.failedRows, 1);
      assert.equal(accounts.get("previous@example.test").is_active, true);
      assert.equal(updateFilters.length, 0);
    } finally {
      User.create = originalCreate;
    }
  });
});

test("legacy Excel persistence reports partial commits and retries by email without duplicating accounts", async () => {
  const originals = {
    find: User.find,
    updateOne: User.updateOne,
    create: User.create,
    sendNotifications: excelUserService.sendNotifications,
  };
  const rows = Array.from({ length: 3 }, (_, index) => ({
    name: `Student ${index}`,
    email: `retry${index}@example.test`,
    role: "student",
    bus_no: "12",
    phone: "9876543210",
    dob: "2004",
  }));
  const committedUser = {
    _id: "user-0",
    email: rows[0].email,
    role: "student",
    bus_no: "12",
  };
  let includeCommittedUser = false;
  let failSecondCreation = true;
  const createInputs = [];
  User.find = (filter) => ({
    select() {
      return this;
    },
    lean() {
      return filter.email
        ? Promise.resolve(includeCommittedUser ? [committedUser] : [])
        : this;
    },
    cursor: () => ({
      async *[Symbol.asyncIterator]() {},
    }),
  });
  User.updateOne = async () => ({ modifiedCount: 0 });
  User.create = async (input) => {
    createInputs.push(input);
    if (failSecondCreation && input.email === rows[1].email) {
      failSecondCreation = false;
      throw new Error("synthetic database failure");
    }
    return { _id: `created-${input.email}` };
  };
  excelUserService.sendNotifications = async (notifications) =>
    notifications.map(({ email }) => ({ email, status: "sent" }));

  try {
    const firstAttempt = await excelUserService.processUsers(rows, "admin-id");
    assert.equal(firstAttempt.created.length, 1);
    assert.equal(firstAttempt.summary.failedRows, 2);
    assert.equal(firstAttempt.summary.completed, false);
    assert.equal(firstAttempt.summary.partial, true);
    assert.deepEqual(
      firstAttempt.summary.rowResults.map((item) => item.index),
      [1, 2],
    );
    assert.equal(createInputs[0].password_hash, "98762004");

    includeCommittedUser = true;
    const createCountBeforeRetry = createInputs.length;
    const retry = await excelUserService.processUsers(rows, "admin-id");
    assert.equal(retry.updated.length, 1);
    assert.equal(retry.created.length, 2);
    assert.equal(retry.summary.failedRows, 0);
    assert.equal(retry.summary.completed, true);
    assert.equal(
      createInputs.length - createCountBeforeRetry,
      2,
    );
  } finally {
    User.find = originals.find;
    User.updateOne = originals.updateOne;
    User.create = originals.create;
    excelUserService.sendNotifications = originals.sendNotifications;
  }
});

test("legacy Excel imports valid rows while reporting invalid and duplicate rows", async () => {
  const originals = {
    find: User.find,
    create: User.create,
    sendNotifications: excelUserService.sendNotifications,
  };
  const importedEmails = [];
  let deactivationScanCount = 0;
  const rows = [
    {
      name: "Student One",
      email: "one@example.test",
      role: "student",
      phone: "9876543210",
      dob: "2004",
    },
    {
      name: "Invalid",
      email: "not-an-email",
      role: "student",
      phone: "9876543210",
      dob: "2004",
    },
    {
      name: "Duplicate",
      email: "ONE@example.test",
      role: "student",
      phone: "9876543210",
      dob: "2004",
    },
    {
      name: "Student Two",
      email: "two@example.test",
      role: "student",
      phone: "9876543210",
      dob: "2004",
    },
  ];
  User.find = (filter) => ({
    select() {
      return this;
    },
    lean() {
      return filter.email ? Promise.resolve([]) : this;
    },
    cursor: () => ({
      async *[Symbol.asyncIterator]() {
        deactivationScanCount += 1;
      },
    }),
  });
  User.create = async (input) => {
    importedEmails.push(input.email);
    return { _id: input.email };
  };
  excelUserService.sendNotifications = async (notifications) =>
    notifications.map(({ email }) => ({ email, status: "sent" }));

  try {
    const result = await excelUserService.processUsers(rows, "admin-id");
    assert.deepEqual(importedEmails, ["one@example.test", "two@example.test"]);
    assert.equal(result.summary.validRows, 2);
    assert.equal(result.summary.duplicateRows, 1);
    assert.equal(result.summary.failedRows, 2);
    assert.equal(result.summary.partial, true);
    assert.equal(deactivationScanCount, 0);
  } finally {
    User.find = originals.find;
    User.create = originals.create;
    excelUserService.sendNotifications = originals.sendNotifications;
  }
});
