"use strict";

const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const mongoose = require("mongoose");
const AdministrativeChangeAudit = require("../src/models/AdministrativeChangeAudit");
const AssignmentPropagationOutbox = require("../src/models/AssignmentPropagationOutbox");
const AssignmentPropagationReplay = require("../src/models/AssignmentPropagationReplay");
const {
  listAssignmentPropagationJobs,
  replayAssignmentPropagationJob,
} = require("../src/controllers/assignmentPropagation.controller");

const originals = {
  startSession: mongoose.startSession,
  outboxFind: AssignmentPropagationOutbox.find,
  outboxFindById: AssignmentPropagationOutbox.findById,
  outboxUpdateOne: AssignmentPropagationOutbox.updateOne,
  outboxCreate: AssignmentPropagationOutbox.create,
  replayFindById: AssignmentPropagationReplay.findById,
  replayCreate: AssignmentPropagationReplay.create,
  auditCreate: AdministrativeChangeAudit.create,
};

after(() => {
  Object.assign(mongoose, { startSession: originals.startSession });
  AssignmentPropagationOutbox.find = originals.outboxFind;
  AssignmentPropagationOutbox.findById = originals.outboxFindById;
  AssignmentPropagationOutbox.updateOne = originals.outboxUpdateOne;
  AssignmentPropagationOutbox.create = originals.outboxCreate;
  AssignmentPropagationReplay.findById = originals.replayFindById;
  AssignmentPropagationReplay.create = originals.replayCreate;
  AdministrativeChangeAudit.create = originals.auditCreate;
});

function query(value) {
  return {
    session() {
      return this;
    },
    select() {
      return this;
    },
    sort() {
      return this;
    },
    limit() {
      return this;
    },
    lean: async () => value,
  };
}

function responseDouble() {
  return {
    statusCode: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function installReplayStores(source) {
  const replayRecords = new Map();
  const children = new Map();
  const audits = [];
  let activeReplay = source.active_replay_job_id || null;

  mongoose.startSession = async () => ({
    withTransaction: async (operation) => operation(),
    endSession: async () => {},
  });
  AssignmentPropagationOutbox.findById = (id) =>
    query(id === source._id ? structuredClone(source) : children.get(id) || null);
  AssignmentPropagationOutbox.updateOne = async (filter, update) => {
    if (
      filter._id !== source._id ||
      source.status !== filter.status ||
      (activeReplay ?? null) !== filter.active_replay_job_id
    ) {
      return { modifiedCount: 0 };
    }
    activeReplay = update.$set.active_replay_job_id;
    source.active_replay_job_id = activeReplay;
    source.replay_history = [
      ...(source.replay_history || []),
      update.$push.replay_history,
    ];
    return { modifiedCount: 1 };
  };
  AssignmentPropagationOutbox.create = async (documents) => {
    for (const document of documents) children.set(document._id, document);
    return documents;
  };
  AssignmentPropagationReplay.findById = (id) => query(replayRecords.get(id) || null);
  AssignmentPropagationReplay.create = async (documents) => {
    for (const document of documents) replayRecords.set(document._id, document);
    return documents;
  };
  AdministrativeChangeAudit.create = async (documents) => {
    audits.push(...documents);
    return documents;
  };
  return { audits, children, replayRecords };
}

function replayRequest({
  role = "superadmin",
  key = "replay-request-001",
  reason = "Recover after confirming the socket outage is resolved.",
  fullReconciliation = false,
} = {}) {
  const response = responseDouble();
  const req = {
    params: { jobId: "outbox-dead" },
    user: {
      id: "64a000000000000000000099",
      role,
    },
    headers: { "idempotency-key": key },
    body: { reason, fullReconciliation },
  };
  return { req, response };
}

test("primary administrators can inspect job status without receiving recipients", async () => {
  let filterSeen;
  AssignmentPropagationOutbox.find = (filter) => {
    filterSeen = filter;
    return query([{
      _id: "outbox-dead",
      operation: "student-assignment-updated",
      status: "dead_letter",
      attempts: 10,
      max_attempts: 10,
      cursor: 2,
      recipients: [{ user_id: "student-private" }],
      last_error_code: "SOCKET_FAILURE",
      last_error_name: "Error",
    }]);
  };
  const response = responseDouble();

  await listAssignmentPropagationJobs(
    { query: { status: "dead_letter", limit: "20" } },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(filterSeen, { status: "dead_letter" });
  assert.equal(response.body.jobs[0].recipientCount, 1);
  assert.equal("recipients" in response.body.jobs[0], false);
  assert.equal(response.body.jobs[0].lastError.code, "SOCKET_FAILURE");
});

test("only superadmins can replay a dead-letter job", async () => {
  const stores = installReplayStores({
    _id: "outbox-dead",
    status: "dead_letter",
    cursor: 0,
    recipients: [],
    operation: "bus-deleted",
  });
  const { req, response } = replayRequest({ role: "primary_admin" });

  await replayAssignmentPropagationJob(req, response);

  assert.equal(response.statusCode, 403);
  assert.equal(stores.children.size, 0);
  assert.equal(stores.audits.length, 0);
});

test("default replay resumes from the durable cursor and reconciles current state", async () => {
  const stores = installReplayStores({
    _id: "outbox-dead",
    status: "dead_letter",
    cursor: 1,
    recipients: [
      { user_id: "student-done", notification: { type: "old" } },
      { user_id: "student-pending-1", notification: { type: "old" } },
      { user_id: "student-pending-2", notification: null },
    ],
    operation: "student-assignment-updated",
  });
  const { req, response } = replayRequest();

  await replayAssignmentPropagationJob(req, response);

  const child = [...stores.children.values()][0];
  assert.equal(response.statusCode, 202, JSON.stringify(response.body));
  assert.equal(response.body.resumedFromCursor, 1);
  assert.deepEqual(
    child.recipients.map((recipient) => recipient.user_id),
    ["student-pending-1", "student-pending-2"],
  );
  assert.equal(child.recipients[0].notification.type, "old");
  assert.equal(child.recipients[1].notification, null);
  assert.equal(child.notification_source_id, "outbox-dead");
  assert.equal(child.replay_of, "outbox-dead");
  assert.equal(child.max_attempts, 10);
  assert.equal(stores.audits[0].actor_id, req.user.id);
  assert.equal(stores.audits[0].resource_id, "outbox-dead");
  assert.equal(stores.audits[0].new_state.reason, req.body.reason);
  assert.equal(stores.replayRecords.size, 1);
});

test("full reconciliation is a distinct audited replay mode", async () => {
  const stores = installReplayStores({
    _id: "outbox-dead",
    status: "dead_letter",
    cursor: 2,
    recipients: [
      { user_id: "student-1", notification: null },
      { user_id: "student-2", notification: null },
    ],
    operation: "bus-replaced",
  });
  const { req, response } = replayRequest({
    key: "replay-full-001",
    fullReconciliation: true,
    reason: "Reconcile every recipient after checkpoint corruption.",
  });

  await replayAssignmentPropagationJob(req, response);

  const child = [...stores.children.values()][0];
  assert.equal(response.statusCode, 202);
  assert.equal(response.body.resumedFromCursor, 0);
  assert.deepEqual(
    child.recipients.map((recipient) => recipient.user_id),
    ["student-1", "student-2"],
  );
  assert.equal([...stores.replayRecords.values()][0].mode, "full");
  assert.equal(
    stores.audits[0].action,
    "assignment-propagation-full-reconciliation-requested",
  );
});

test("replay requests are idempotent and concurrent distinct requests cannot race", async () => {
  const source = {
    _id: "outbox-dead",
    status: "dead_letter",
    cursor: 0,
    recipients: [{ user_id: "student-1", notification: null }],
    operation: "bus-replaced",
  };
  const stores = installReplayStores(source);
  const first = replayRequest();
  await replayAssignmentPropagationJob(first.req, first.response);
  const duplicate = replayRequest();
  await replayAssignmentPropagationJob(duplicate.req, duplicate.response);

  assert.equal(first.response.statusCode, 202);
  assert.equal(duplicate.response.statusCode, 200);
  assert.equal(duplicate.response.body.duplicate, true);
  assert.equal(stores.children.size, 1);

  const competing = replayRequest({ key: "replay-request-002" });
  await replayAssignmentPropagationJob(competing.req, competing.response);
  assert.equal(competing.response.statusCode, 409);
  assert.equal(competing.response.body.code, "ASSIGNMENT_REPLAY_ALREADY_ACTIVE");
  assert.equal(stores.children.size, 1);
});

test("reusing a replay key with a different payload is rejected", async () => {
  const stores = installReplayStores({
    _id: "outbox-dead",
    status: "dead_letter",
    cursor: 0,
    recipients: [],
    operation: "bus-replaced",
  });
  const first = replayRequest();
  await replayAssignmentPropagationJob(first.req, first.response);
  const changed = replayRequest({ reason: "A different administrative reason." });

  await replayAssignmentPropagationJob(changed.req, changed.response);

  assert.equal(changed.response.statusCode, 409);
  assert.equal(
    changed.response.body.code,
    "ASSIGNMENT_REPLAY_IDEMPOTENCY_CONFLICT",
  );
  assert.equal(stores.children.size, 1);
});

test("full recovery can proceed after a completed replay lock was left behind", async () => {
  const stores = installReplayStores({
    _id: "outbox-dead",
    status: "dead_letter",
    cursor: 1,
    active_replay_job_id: "replay:completed-but-not-finalized",
    recipients: [{ user_id: "student-1", notification: null }],
    operation: "bus-replaced",
  });
  stores.children.set("replay:completed-but-not-finalized", {
    _id: "replay:completed-but-not-finalized",
    status: "completed",
  });
  const { req, response } = replayRequest({
    key: "replay-repair-001",
    fullReconciliation: true,
    reason: "Repair a previous replay whose checkpoint was corrupted.",
  });

  await replayAssignmentPropagationJob(req, response);

  assert.equal(response.statusCode, 202);
  assert.notEqual(response.body.replayJobId, "replay:completed-but-not-finalized");
  assert.equal(stores.children.size, 2);
});
