"use strict";

const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const AdministrativeChangeAudit = require("../src/models/AdministrativeChangeAudit");
const AppSetting = require("../src/models/AppSetting");
const AssignmentPropagationOutbox = require("../src/models/AssignmentPropagationOutbox");
const Bus = require("../src/models/Bus");
const BusRoute = require("../src/models/BusRoute");
const PlanMapping = require("../src/models/PlanMapping");
const PlanMappingAudit = require("../src/models/PlanMappingAudit");
const PlanMappingRevision = require("../src/models/PlanMappingRevision");
const StopMaster = require("../src/models/StopMaster");
const User = require("../src/models/User");
const { updatePlanMappingRoutes } = require("../src/controllers/planMapping.controller");
const { mockGpsOwnershipTransactions } = require("./helpers/gpsOwnershipTransactionMock.cjs");

const transactionMock = mockGpsOwnershipTransactions();
const originals = {
  adminAuditCreate: AdministrativeChangeAudit.create,
  appSettingFindOne: AppSetting.findOne,
  outboxUpdateOne: AssignmentPropagationOutbox.updateOne,
  busFind: Bus.find,
  busFindById: Bus.findById,
  busFindOneAndUpdate: Bus.findOneAndUpdate,
  busRouteFind: BusRoute.find,
  busRouteDeleteMany: BusRoute.deleteMany,
  busRouteInsertMany: BusRoute.insertMany,
  mappingFind: PlanMapping.find,
  mappingFindById: PlanMapping.findById,
  mappingAuditFindById: PlanMappingAudit.findById,
  mappingAuditCreate: PlanMappingAudit.create,
  mappingRevisionFindOneAndUpdate: PlanMappingRevision.findOneAndUpdate,
  stopMasterFind: StopMaster.find,
  userFind: User.find,
  userUpdateOne: User.updateOne,
};

after(() => {
  transactionMock.restore();
  AdministrativeChangeAudit.create = originals.adminAuditCreate;
  AppSetting.findOne = originals.appSettingFindOne;
  AssignmentPropagationOutbox.updateOne = originals.outboxUpdateOne;
  Bus.find = originals.busFind;
  Bus.findById = originals.busFindById;
  Bus.findOneAndUpdate = originals.busFindOneAndUpdate;
  BusRoute.find = originals.busRouteFind;
  BusRoute.deleteMany = originals.busRouteDeleteMany;
  BusRoute.insertMany = originals.busRouteInsertMany;
  PlanMapping.find = originals.mappingFind;
  PlanMapping.findById = originals.mappingFindById;
  PlanMappingAudit.findById = originals.mappingAuditFindById;
  PlanMappingAudit.create = originals.mappingAuditCreate;
  PlanMappingRevision.findOneAndUpdate = originals.mappingRevisionFindOneAndUpdate;
  StopMaster.find = originals.stopMasterFind;
  User.find = originals.userFind;
  User.updateOne = originals.userUpdateOne;
});

function query(result) {
  return {
    select() {
      return this;
    },
    sort() {
      return this;
    },
    session() {
      return this;
    },
    lean: async () => result,
  };
}

function responseDouble() {
  return {
    statusCode: 200,
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

function installStores({ busWriteResult } = {}) {
  const busId = "64a000000000000000000010";
  const clusterId = "64a000000000000000000020";
  const bus = {
    _id: busId,
    bus_no: "BUS-1",
    revision: 5,
    status: "active",
    combined_routes: [],
    alteration_routes: [],
    alteration_route_source: null,
  };
  const cluster = {
    _id: clusterId,
    plan_name: "PLAN A",
    cluster_name: "BUS-1",
    root_bus_id: busId,
    location_bus_id: busId,
    member_bus_ids: [busId],
  };
  const route = {
    _id: "route-1",
    bus_id: busId,
    plan_name: "PLAN A",
    stopId: "STOP-1",
    stop_name: "Stop 1",
    stop_order: 1,
    arrival_time: null,
  };
  const writes = [];
  const audits = new Map();
  const mappingVersions = new Map();

  AppSetting.findOne = () => query({ value: "PLAN A" });
  Bus.find = () => query([bus]);
  Bus.findById = async () => ({ ...bus });
  Bus.findOneAndUpdate = (filter, update) => {
    writes.push({ filter, update });
    const updated = busWriteResult === null
      ? null
      : { ...bus, ...update.$set, revision: bus.revision + update.$inc.revision };
    return query(updated);
  };
  BusRoute.find = (filter) => query(filter?.bus_id ? [route] : [route]);
  BusRoute.deleteMany = async () => ({ deletedCount: 1 });
  BusRoute.insertMany = async (documents) => documents;
  PlanMapping.find = () => query([]);
  PlanMapping.findById = () => query(cluster);
  PlanMappingAudit.findById = (id) => ({
    session() {
      return this;
    },
    lean: async () => audits.get(id) || null,
  });
  PlanMappingAudit.create = async (documents) => {
    for (const document of documents) audits.set(document._id, document);
    return documents;
  };
  PlanMappingRevision.findOneAndUpdate = (filter, update) => ({
    lean: async () => {
      const currentVersion = mappingVersions.get(filter._id) ?? 0;
      if (currentVersion !== filter.version) return null;
      const revision = {
        _id: filter._id,
        version: currentVersion + update.$inc.version,
      };
      mappingVersions.set(filter._id, revision.version);
      return revision;
    },
  });
  StopMaster.find = () => query([{
    stopId: "STOP-1",
    name: "Stop 1",
    aliases: [],
    status: "VERIFIED",
  }]);
  User.find = () => query([]);
  User.updateOne = async () => ({ matchedCount: 1 });
  AdministrativeChangeAudit.create = async () => [];
  AssignmentPropagationOutbox.updateOne = async () => ({ upsertedCount: 1 });

  return { busId, clusterId, writes };
}

function request({ expectedBusVersion = 5, expectedVersion = 0 } = {}) {
  return {
    params: { clusterId: "64a000000000000000000020" },
    body: {
      expectedVersion,
      expectedBusVersion,
      stops: [{ stopName: "Stop 1" }],
    },
    user: { id: "64a000000000000000000099" },
    get: (name) =>
      name === "Idempotency-Key" ? "plan-route-update-001" : undefined,
  };
}

test("plan-route edits conditionally increment the root bus revision", async () => {
  const stores = installStores();
  const response = responseDouble();

  await updatePlanMappingRoutes(request(), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.busRevision, 6);
  assert.deepEqual(stores.writes[0].filter, {
    $and: [
      { _id: stores.busId },
      { revision: 5 },
    ],
  });
  assert.deepEqual(stores.writes[0].update.$inc, { revision: 1 });
});

test("plan-route edits reject stale root bus revisions before route writes", async () => {
  const stores = installStores({ busWriteResult: null });
  let routeDeleteCalls = 0;
  BusRoute.deleteMany = async () => {
    routeDeleteCalls += 1;
    return { deletedCount: 1 };
  };
  const response = responseDouble();

  await updatePlanMappingRoutes(
    request({ expectedBusVersion: 4 }),
    response,
  );

  assert.equal(response.statusCode, 409);
  assert.equal(response.payload.code, "BUS_REVISION_CONFLICT");
  assert.equal(routeDeleteCalls, 0);
  assert.equal(stores.writes.length, 1);
});

test("plan-route edits require the root bus revision", async () => {
  const stores = installStores();
  const response = responseDouble();

  await updatePlanMappingRoutes(
    request({ expectedBusVersion: null }),
    response,
  );

  assert.equal(response.statusCode, 428);
  assert.equal(response.payload.code, "BUS_REVISION_REQUIRED");
  assert.equal(stores.writes.length, 0);
});
