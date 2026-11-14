"use strict";

const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const AdministrativeChangeAudit = require("../src/models/AdministrativeChangeAudit");
const AssignmentPropagationOutbox = require("../src/models/AssignmentPropagationOutbox");
const Bus = require("../src/models/Bus");
const BusLiveLocation = require("../src/models/BusLiveLocation");
const BusChange = require("../src/models/BusChange");
const StopMaster = require("../src/models/StopMaster");
const User = require("../src/models/User");
const { importBusRoutes } = require("../src/controllers/importBusRoutes.controller");
const { mockGpsOwnershipTransactions } = require("./helpers/gpsOwnershipTransactionMock.cjs");
const { mockMutationIdempotency } = require("./helpers/mutationIdempotencyMock.cjs");
const { mockImportLedger } = require("./helpers/importLedgerMock.cjs");

const transactionMock = mockGpsOwnershipTransactions();
const idempotencyMock = mockMutationIdempotency();
const importLedgerMock = mockImportLedger();
const originals = {
  auditCreate: AdministrativeChangeAudit.create,
  outboxUpdateOne: AssignmentPropagationOutbox.updateOne,
  busFindOne: Bus.findOne,
  busFind: Bus.find,
  busFindOneAndUpdate: Bus.findOneAndUpdate,
  busCreate: Bus.create,
  locationDeleteOne: BusLiveLocation.deleteOne,
  busChangeFindOne: BusChange.findOne,
  stopMasterFind: StopMaster.find,
  userFind: User.find,
  userUpdateOne: User.updateOne,
};

after(() => {
  transactionMock.restore();
  idempotencyMock.restore();
  importLedgerMock.restore();
  AdministrativeChangeAudit.create = originals.auditCreate;
  AssignmentPropagationOutbox.updateOne = originals.outboxUpdateOne;
  Bus.findOne = originals.busFindOne;
  Bus.find = originals.busFind;
  Bus.findOneAndUpdate = originals.busFindOneAndUpdate;
  Bus.create = originals.busCreate;
  BusLiveLocation.deleteOne = originals.locationDeleteOne;
  BusChange.findOne = originals.busChangeFindOne;
  StopMaster.find = originals.stopMasterFind;
  User.find = originals.userFind;
  User.updateOne = originals.userUpdateOne;
});

function query(result) {
  return {
    select() {
      return this;
    },
    session() {
      return this;
    },
    lean: async () => result,
    then(resolve, reject) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };
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

let importRequestSequence = 0;

function installImportStores(students, { existingBus = null, busCandidates = [] } = {}) {
  const audits = [];
  const outbox = [];
  const assignmentWrites = [];
  const bus = {
    _id: existingBus?._id || "bus-new",
    bus_no: "BUS-NEW",
    bus_name: "BUS-NEW",
    preview_number: "22",
    status: "active",
    gps_device_id: "synthetic-device",
    revision: existingBus?.revision ?? 0,
    reg_no: null,
  };
  let busFindOneCalls = 0;
  let userFilter;

  Bus.find = () => query(busCandidates);
  AdministrativeChangeAudit.create = async (documents) => {
    audits.push(...documents);
    return documents;
  };
  AssignmentPropagationOutbox.updateOne = async (filter, update) => {
    outbox.push({ id: filter._id, ...update.$setOnInsert });
    return { upsertedCount: 1 };
  };
  Bus.findOne = () => {
    busFindOneCalls += 1;
    return query(busFindOneCalls <= 2 ? existingBus : bus);
  };
  Bus.findOneAndUpdate = (filter, update) => ({
    lean: async () => {
      const expectedRevision = filter.$and[1];
      const matches = expectedRevision.$or
        ? bus.revision === 0 || bus.revision === undefined
        : bus.revision === expectedRevision.revision;
      if (!matches) return null;
      return {
        ...bus,
        ...update.$set,
        revision: (bus.revision ?? 0) + update.$inc.revision,
      };
    },
  });
  Bus.create = async (documents) =>
    documents.map((document) => ({
      ...document,
      _id: "bus-new",
      toObject() {
        return { ...this };
      },
    }));
  BusLiveLocation.deleteOne = async () => ({ deletedCount: 1 });
  BusChange.findOne = () => query(null);
  StopMaster.find = () => query([]);
  User.find = (filter) => {
    userFilter = filter;
    return query(students);
  };
  User.updateOne = async (...args) => {
    assignmentWrites.push(args);
    return { matchedCount: 1 };
  };

  return {
    audits,
    bus,
    outbox,
    assignmentWrites,
    get userFilter() {
      return userFilter;
    },
  };
}

async function submitNewBusImport({
  key,
  expectedVersion = 0,
  previewNumber = "22",
} = {}) {
  const response = responseDouble();
  await importBusRoutes(
    {
      body: {
        busNo: "BUS-NEW",
        previewNumber,
        deviceId: "synthetic-device",
        routesByPlan: {},
        expectedVersion,
      },
      user: { id: "64a000000000000000000099" },
      get: () =>
        key ||
        `import-request-${String(++importRequestSequence).padStart(3, "0")}`,
    },
    response,
  );
  return response;
}

test("new bus route import records and propagates assignments that become resolvable", async () => {
  const students = [
    { _id: "64a000000000000000000001", bus_no: "BUS-NEW" },
    { _id: "64a000000000000000000002", bus_no: "22" },
  ];
  const stores = installImportStores(students);

  const response = await submitNewBusImport();

  assert.equal(response.statusCode, 200);
  assert.equal(stores.audits.length, 1);
  assert.equal(stores.audits[0].action, "bus-created-by-route-import");
  assert.equal(stores.audits[0].actor_id, "64a000000000000000000099");
  assert.equal(stores.audits[0].request_id, "import-request-001");
  assert.deepEqual(
    stores.audits[0].previous_state.assignments.map((assignment) => assignment.user_id),
    students.map((student) => student._id),
  );
  assert.deepEqual(
    stores.audits[0].new_state.assignments.map((assignment) => assignment.bus_no),
    students.map((student) => student.bus_no),
  );
  assert.deepEqual(
    stores.audits[0].previous_state.assignments.map((assignment) => assignment.effective_bus_id),
    [null, null],
  );
  assert.deepEqual(
    stores.audits[0].new_state.assignments.map((assignment) => assignment.effective_bus_id),
    [stores.bus._id, stores.bus._id],
  );
  assert.equal(stores.outbox.length, 1);
  assert.equal(stores.assignmentWrites.length, 2);
  assert.ok(
    stores.assignmentWrites.every(
      ([, update]) => update.$inc.assignmentRevision === 1,
    ),
  );
  assert.equal(stores.outbox[0].id, stores.audits[0]._id);
  assert.deepEqual(
    stores.outbox[0].recipients,
    students.map((student) => ({
      user_id: student._id,
      notification: null,
    })),
  );
  assert.deepEqual(
    stores.userFilter.bus_no.$in.map((pattern) => [
      pattern.test("BUS-NEW"),
      pattern.test("22"),
    ]),
    [[true, false], [false, true]],
  );
});

test("new bus route import records an empty propagation job when no students are affected", async () => {
  const stores = installImportStores([]);

  const response = await submitNewBusImport();

  assert.equal(response.statusCode, 200);
  assert.equal(stores.audits.length, 1);
  assert.deepEqual(stores.audits[0].previous_state.assignments, []);
  assert.deepEqual(stores.audits[0].new_state.assignments, []);
  assert.equal(stores.outbox.length, 1);
  assert.equal(stores.outbox[0].id, stores.audits[0]._id);
  assert.deepEqual(stores.outbox[0].recipients, []);
});

test("existing-bus preview imports propagate only aliases that change resolution", async () => {
  const existingBus = {
    _id: "bus-existing",
    bus_no: "BUS-NEW",
    bus_name: "BUS-NEW",
    preview_number: "21",
    gps_device_id: "old-device",
    revision: 4,
    reg_no: null,
    status: "active",
  };
  const students = [
    { _id: "student-old-preview", bus_no: "21" },
    { _id: "student-new-preview", bus_no: "22" },
    { _id: "student-bus-number", bus_no: "BUS-NEW" },
  ];
  const stores = installImportStores(students, {
    existingBus,
    busCandidates: [existingBus],
  });
  const response = responseDouble();

  await importBusRoutes(
    {
      body: {
        busNo: "BUS-NEW",
        previewNumber: "22",
        deviceId: "synthetic-device",
        routesByPlan: {},
        expectedVersion: 4,
      },
      user: { id: "64a000000000000000000099" },
      get: () => "metadata-request-001",
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(stores.audits.length, 1);
  assert.equal(stores.audits[0].action, "bus-metadata-updated-by-route-import");
  assert.equal(stores.audits[0].previous_state.bus.preview_number, "21");
  assert.equal(stores.audits[0].new_state.bus.preview_number, "22");
  assert.deepEqual(
    stores.audits[0].previous_state.assignments.map((assignment) => assignment.user_id),
    ["student-old-preview", "student-new-preview"],
  );
  assert.deepEqual(
    stores.outbox[0].recipients.map((recipient) => recipient.user_id),
    ["student-old-preview", "student-new-preview"],
  );
});

test("an unchanged existing-bus import does not enqueue assignment work", async () => {
  const existingBus = {
    _id: "bus-existing",
    bus_no: "BUS-NEW",
    bus_name: "BUS-NEW",
    preview_number: "22",
    gps_device_id: "synthetic-device",
    revision: 4,
    reg_no: null,
    status: "active",
  };
  const stores = installImportStores([], {
    existingBus,
    busCandidates: [existingBus],
  });
  const response = responseDouble();

  await importBusRoutes(
    {
      body: {
        busNo: "BUS-NEW",
        previewNumber: "22",
        deviceId: "synthetic-device",
        routesByPlan: {},
        expectedVersion: 4,
      },
      user: { id: "64a000000000000000000099" },
      get: () => "unchanged-import-001",
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(stores.audits.length, 0);
  assert.equal(stores.outbox.length, 0);
});

test("route-import idempotency replays the original result and rejects payload changes", async () => {
  const stores = installImportStores([]);
  const key = "route-import-idempotency-001";
  const first = await submitNewBusImport({ key });
  const replay = await submitNewBusImport({ key });
  const conflict = await submitNewBusImport({ key, previewNumber: "23" });

  assert.equal(first.statusCode, 200);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.payload.duplicate, true);
  assert.equal(conflict.statusCode, 409);
  assert.equal(stores.audits.length, 1);
  assert.equal(stores.outbox.length, 1);
});

test("route-import rejects a stale bus revision at the conditional write", async () => {
  const existingBus = {
    _id: "bus-existing-stale",
    bus_no: "BUS-NEW",
    bus_name: "BUS-NEW",
    preview_number: "21",
    gps_device_id: "synthetic-device",
    revision: 5,
    reg_no: null,
    status: "active",
  };
  const stores = installImportStores([], {
    existingBus,
    busCandidates: [existingBus],
  });
  const response = responseDouble();

  await importBusRoutes(
    {
      body: {
        busNo: "BUS-NEW",
        previewNumber: "22",
        deviceId: "synthetic-device",
        routesByPlan: {},
        expectedVersion: 4,
      },
      user: { id: "64a000000000000000000099" },
      get: () => "route-import-stale-001",
    },
    response,
  );

  assert.equal(response.statusCode, 409);
  assert.match(response.payload.error, /changed/i);
  assert.equal(stores.audits.length, 0);
  assert.equal(stores.outbox.length, 0);
});
