"use strict";

const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const AdministrativeChangeAudit = require("../src/models/AdministrativeChangeAudit");
const AssignmentPropagationOutbox = require("../src/models/AssignmentPropagationOutbox");
const PlanMappingAudit = require("../src/models/PlanMappingAudit");
const PlanMappingRevision = require("../src/models/PlanMappingRevision");
const User = require("../src/models/User");
const {
  runPlanMappingMutation,
  runPlanMappingNoop,
} = require("../src/services/planMappingPersistence");
const { mockGpsOwnershipTransactions } = require("./helpers/gpsOwnershipTransactionMock.cjs");

const transactionMock = mockGpsOwnershipTransactions();
after(() => transactionMock.restore());

function installStores() {
  const originals = {
    administrativeAuditCreate: AdministrativeChangeAudit.create,
    auditFindById: PlanMappingAudit.findById,
    auditCreate: PlanMappingAudit.create,
    revisionFindOneAndUpdate: PlanMappingRevision.findOneAndUpdate,
    outboxUpdateOne: AssignmentPropagationOutbox.updateOne,
    userFind: User.find,
    userUpdateOne: User.updateOne,
  };
  const audits = new Map();
  const administrativeAudits = new Map();
  const revisions = new Map();
  const outbox = new Map();
  const assignmentWrites = [];

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
  AdministrativeChangeAudit.create = async (documents) => {
    for (const document of documents) {
      administrativeAudits.set(document._id, document);
    }
    return documents;
  };
  PlanMappingRevision.findOneAndUpdate = (filter, update) => ({
    lean: async () => {
      const current = revisions.get(filter._id);
      if ((current?.version ?? 0) !== filter.version) return null;
      const next = {
        _id: filter._id,
        version: filter.version + update.$inc.version,
      };
      revisions.set(filter._id, next);
      return next;
    },
  });
  AssignmentPropagationOutbox.updateOne = async (filter, update) => {
    if (!outbox.has(filter._id)) outbox.set(filter._id, update.$setOnInsert);
    return { upsertedCount: 1 };
  };
  User.find = (filter) => ({
    select() {
      return this;
    },
    session() {
      return this;
    },
    lean: async () => filter._id.$in.map((id) => ({
      _id: id,
      assignmentRevision: 0,
    })),
  });
  User.updateOne = async (...args) => {
    assignmentWrites.push(args);
    return { matchedCount: 1 };
  };

  return {
    audits,
    administrativeAudits,
    outbox,
    revisions,
    assignmentWrites,
    restore() {
      AdministrativeChangeAudit.create = originals.administrativeAuditCreate;
      PlanMappingAudit.findById = originals.auditFindById;
      PlanMappingAudit.create = originals.auditCreate;
      PlanMappingRevision.findOneAndUpdate = originals.revisionFindOneAndUpdate;
      AssignmentPropagationOutbox.updateOne = originals.outboxUpdateOne;
      User.find = originals.userFind;
      User.updateOne = originals.userUpdateOne;
    },
  };
}

test("mapping changes persist an audit and outbox atomically and replay idempotently", async () => {
  const stores = installStores();
  let mutationCalls = 0;
  try {
    const input = {
      scope: "PLAN B",
      idempotencyKey: "mapping-request-001",
      expectedVersion: 0,
      actorId: "64a000000000000000000099",
      action: "plan-mapping-save",
      request: { rootBusId: "bus-a", expectedVersion: 0 },
      previousState: { locationBusId: null },
      newState: { locationBusId: "bus-b" },
      recipients: [{
        user_id: "64a000000000000000000001",
        notification: { type: "plan_changed", message: "Assignment changed." },
      }],
      mutate: async () => {
        mutationCalls += 1;
        return { response: { clusterId: "cluster-1" } };
      },
    };
    const first = await runPlanMappingMutation(input);
    const retry = await runPlanMappingMutation(input);

    assert.equal(first.version, 1);
    assert.equal(first.duplicate, false);
    assert.equal(retry.version, 1);
    assert.equal(retry.duplicate, true);
    assert.deepEqual(retry.response, { clusterId: "cluster-1" });
    assert.equal(mutationCalls, 1);
    assert.equal(stores.audits.size, 1);
    assert.equal(stores.administrativeAudits.size, 1);
    assert.equal(stores.outbox.size, 1);
    assert.equal(stores.assignmentWrites.length, 1);
    assert.deepEqual(stores.assignmentWrites[0][1], {
      $inc: { assignmentRevision: 1 },
    });
    const audit = [...stores.audits.values()][0];
    assert.equal(audit.actor_id, input.actorId);
    assert.deepEqual(audit.previous_state, input.previousState);
    assert.deepEqual(audit.new_state, input.newState);
    assert.equal(audit.expected_version, 0);
    assert.equal(audit.version, 1);
    assert.deepEqual(audit.assignment_revisions, [{
      user_id: "64a000000000000000000001",
      before: 0,
      after: 1,
    }]);
    const administrativeAudit = [...stores.administrativeAudits.values()][0];
    assert.equal(administrativeAudit.actor_id, input.actorId);
    assert.equal(administrativeAudit.action, input.action);
    assert.deepEqual(administrativeAudit.previous_state, input.previousState);
    assert.deepEqual(administrativeAudit.new_state, input.newState);
  } finally {
    stores.restore();
  }
});

test("global-plan no-ops retain the mapping revision while durably enforcing idempotency", async () => {
  const stores = installStores();
  const input = {
    scope: "GLOBAL_ACTIVE_PLAN",
    idempotencyKey: "global-plan-noop-001",
    expectedVersion: 0,
    actorId: "64a000000000000000000099",
    action: "global-plan-noop",
    request: { plan: "PLAN A", expectedVersion: 0 },
    previousState: { activePlan: "PLAN A" },
    newState: { activePlan: "PLAN A" },
    response: { activePlan: "PLAN A" },
  };
  try {
    const first = await runPlanMappingNoop(input);
    const replay = await runPlanMappingNoop(input);
    await assert.rejects(
      runPlanMappingNoop({
        ...input,
        request: { plan: "PLAN B", expectedVersion: 0 },
      }),
      { code: "PLAN_MAPPING_IDEMPOTENCY_CONFLICT" },
    );
    assert.equal(first.version, 0);
    assert.equal(first.duplicate, false);
    assert.equal(replay.version, 0);
    assert.equal(replay.duplicate, true);
    assert.equal(stores.revisions.get("GLOBAL_ACTIVE_PLAN").version, 0);
    assert.equal(stores.audits.size, 1);
    assert.equal(stores.outbox.size, 0);
    assert.equal(stores.administrativeAudits.size, 0);
  } finally {
    stores.restore();
  }
});

test("mapping changes reject stale versions and idempotency-key payload reuse", async () => {
  const stores = installStores();
  let mutationCalls = 0;
  try {
    const base = {
      scope: "PLAN C",
      idempotencyKey: "mapping-request-002",
      expectedVersion: 0,
      actorId: "64a000000000000000000099",
      action: "plan-mapping-save",
      request: { rootBusId: "bus-a" },
      previousState: null,
      newState: { rootBusId: "bus-a" },
      mutate: async () => {
        mutationCalls += 1;
        return { response: { saved: true } };
      },
    };
    await runPlanMappingMutation(base);
    await assert.rejects(
      runPlanMappingMutation({ ...base, request: { rootBusId: "bus-b" } }),
      { code: "PLAN_MAPPING_IDEMPOTENCY_CONFLICT" },
    );
    await assert.rejects(
      runPlanMappingMutation({
        ...base,
        idempotencyKey: "mapping-request-003",
        expectedVersion: 0,
      }),
      { code: "PLAN_MAPPING_VERSION_CONFLICT" },
    );
    assert.equal(mutationCalls, 1);
  } finally {
    stores.restore();
  }
});

test("concurrent mapping writes with the same expected version permit only one mutation", async () => {
  const stores = installStores();
  let mutationCalls = 0;
  const base = {
    scope: "PLAN D",
    expectedVersion: 0,
    actorId: "64a000000000000000000099",
    action: "plan-mapping-save",
    previousState: null,
    newState: { locationBusId: "bus-next" },
    mutate: async () => {
      mutationCalls += 1;
      return { response: { saved: true } };
    },
  };

  try {
    const results = await Promise.allSettled([
      runPlanMappingMutation({
        ...base,
        idempotencyKey: "concurrent-request-001",
        request: { locationBusId: "bus-next" },
      }),
      runPlanMappingMutation({
        ...base,
        idempotencyKey: "concurrent-request-002",
        request: { locationBusId: "bus-next" },
      }),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(results.find((result) => result.status === "rejected").reason.code, "PLAN_MAPPING_VERSION_CONFLICT");
    assert.equal(mutationCalls, 1);
    assert.equal(stores.audits.size, 1);
    assert.equal(stores.outbox.size, 1);
  } finally {
    stores.restore();
  }
});
