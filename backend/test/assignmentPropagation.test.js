"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DEFAULT_MAX_ATTEMPTS,
  MAX_RETRY_MS,
  createAssignmentPropagationWorker,
  createNotificationId,
  getMaxAttempts,
  getRetryDelayMs,
  notificationMatchesAssignment,
} = require("../src/services/assignmentPropagation");

const resolveAssignments = async (ids) =>
  new Map(ids.map((id) => [id, { assignmentStatus: "assigned" }]));

test("assignment outbox retry defaults are bounded and configurable", () => {
  assert.equal(getMaxAttempts({}), 10);
  assert.equal(DEFAULT_MAX_ATTEMPTS, 10);
  assert.equal(getMaxAttempts({ ASSIGNMENT_PROPAGATION_MAX_ATTEMPTS: "4" }), 4);
  assert.throws(
    () => getMaxAttempts({ ASSIGNMENT_PROPAGATION_MAX_ATTEMPTS: "0" }),
    /ASSIGNMENT_PROPAGATION_MAX_ATTEMPTS/,
  );
  assert.equal(getRetryDelayMs(0), 1000);
  assert.equal(getRetryDelayMs(1), 2000);
  assert.equal(getRetryDelayMs(20), MAX_RETRY_MS);
});

test("pending notifications are reconciled against current assignment state", () => {
  const currentBus = {
    assignmentStatus: "assigned",
    effectiveBus: { bus_no: "BUS-2", preview_number: "2" },
  };
  assert.equal(
    notificationMatchesAssignment({ new_bus_no: "BUS-2" }, currentBus),
    true,
  );
  assert.equal(
    notificationMatchesAssignment({ new_bus_no: "BUS-1" }, currentBus),
    false,
  );
  assert.equal(
    notificationMatchesAssignment(
      { type: "bus_unassigned", new_bus_no: null },
      { assignmentStatus: "unassigned" },
    ),
    true,
  );
  assert.equal(
    notificationMatchesAssignment(
      { type: "bus_unassigned", new_bus_no: null },
      currentBus,
    ),
    false,
  );
});

function createOutboxModel(job) {
  return {
    findOneAndUpdate(filter, update) {
      if (job.status === "completed" || job.next_attempt_at > new Date()) {
        return { lean: async () => null };
      }
      if (
        job.status === "processing" &&
        job.lease_expires_at > new Date()
      ) {
        return { lean: async () => null };
      }
      job.status = update.$set.status;
      job.lease_owner = update.$set.lease_owner;
      job.lease_expires_at = update.$set.lease_expires_at;
      job.attempts += update.$inc.attempts;
      return { lean: async () => structuredClone(job) };
    },
    async updateOne(filter, update) {
      if (
        filter._id !== job._id ||
        filter.lease_owner !== job.lease_owner ||
        (filter.cursor !== undefined && filter.cursor !== job.cursor)
      ) {
        return { modifiedCount: 0 };
      }
      Object.assign(job, update.$set);
      return { modifiedCount: 1 };
    },
  };
}

test("assignment outbox processes recipients in bounded, restart-safe batches", async () => {
  const job = {
    _id: "event-1",
    status: "pending",
    cursor: 0,
    attempts: 0,
    recipients: [
      { user_id: "student-1", notification: null },
      { user_id: "student-2", notification: null },
      { user_id: "student-3", notification: null },
    ],
    next_attempt_at: new Date(0),
  };
  const reconciled = [];
  const worker = createAssignmentPropagationWorker({
    workerId: "worker-test",
    outboxModel: createOutboxModel(job),
    resolveAssignments,
    notificationModel: { bulkWrite: async () => {} },
    reconcile: async (ids) => reconciled.push(...ids),
    now: () => new Date(),
    batchSize: 2,
    logger: { error() {} },
  });

  assert.equal(await worker.processOne(), true);
  assert.equal(job.cursor, 2);
  assert.equal(job.status, "pending");
  assert.equal(await worker.processOne(), true);
  assert.equal(job.cursor, 3);
  assert.equal(job.status, "completed");
  assert.deepEqual(reconciled, ["student-1", "student-2", "student-3"]);
});

test("assignment outbox retries notification writes with the same identity", async () => {
  const job = {
    _id: "event-retry",
    status: "pending",
    cursor: 0,
    attempts: 0,
    recipients: [{
      user_id: "student-4",
      notification: {
        type: "bus_reassigned",
        message: "Your bus assignment changed.",
      },
    }],
    next_attempt_at: new Date(0),
  };
  const notificationIds = [];
  let writeAttempts = 0;
  const worker = createAssignmentPropagationWorker({
    workerId: "worker-retry",
    outboxModel: createOutboxModel(job),
    resolveAssignments,
    notificationModel: {
      async bulkWrite(operations) {
        notificationIds.push(operations[0].updateOne.filter._id.toString());
        writeAttempts += 1;
        if (writeAttempts === 1) {
          throw Object.assign(new Error("synthetic notification write failure"), {
            code: "NOTIFICATION_WRITE_FAILED",
          });
        }
      },
    },
    reconcile: async () => {},
    logger: { error() {} },
  });

  await worker.processOne();
  assert.equal(job.status, "pending");
  assert.equal(job.cursor, 0);
  job.next_attempt_at = new Date(0);
  await worker.processOne();
  assert.equal(job.status, "completed");
  assert.equal(notificationIds.length, 2);
  assert.equal(notificationIds[0], notificationIds[1]);
});

test("assignment outbox renews its lease during a long recipient batch", async () => {
  const job = {
    _id: "event-long-batch",
    status: "pending",
    cursor: 0,
    attempts: 0,
    recipients: [{ user_id: "student-long", notification: null }],
    next_attempt_at: new Date(0),
  };
  const outbox = createOutboxModel(job);
  const updateOne = outbox.updateOne;
  let renewals = 0;
  outbox.updateOne = async (filter, update) => {
    if (
      filter.lease_expires_at?.$gt &&
      update.$set?.lease_expires_at instanceof Date
    ) {
      renewals += 1;
    }
    return updateOne(filter, update);
  };
  const worker = createAssignmentPropagationWorker({
    workerId: "worker-long-batch",
    outboxModel: outbox,
    resolveAssignments,
    notificationModel: { bulkWrite: async () => {} },
    reconcile: async () =>
      new Promise((resolve) => setTimeout(resolve, 80)),
    leaseMs: 30,
    leaseRenewIntervalMs: 5,
    logger: { error() {} },
  });

  assert.equal(await worker.processOne(), true);
  assert.ok(renewals > 0);
  assert.equal(job.status, "completed");
});

test("a worker restart recovers an expired lease", async () => {
  const job = {
    _id: "event-expired-lease",
    status: "processing",
    lease_owner: "worker-crashed",
    lease_expires_at: new Date(Date.now() - 1),
    cursor: 0,
    attempts: 1,
    recipients: [{ user_id: "student-recovered", notification: null }],
    next_attempt_at: new Date(0),
  };
  let reconciled = 0;
  const worker = createAssignmentPropagationWorker({
    workerId: "worker-restarted",
    outboxModel: createOutboxModel(job),
    resolveAssignments,
    notificationModel: { bulkWrite: async () => {} },
    reconcile: async () => {
      reconciled += 1;
    },
    logger: { error() {} },
  });

  assert.equal(await worker.processOne(), true);
  assert.equal(job.status, "completed");
  assert.equal(job.lease_owner, null);
  assert.equal(reconciled, 1);
});

test("a crash after reconciliation is recovered by replaying the batch", async () => {
  const job = {
    _id: "event-crash-recovery",
    status: "pending",
    cursor: 0,
    attempts: 0,
    recipients: [{ user_id: "student-replayed", notification: null }],
    next_attempt_at: new Date(0),
  };
  const outbox = createOutboxModel(job);
  const updateOne = outbox.updateOne;
  let failCursorAndRetryWrites = true;
  outbox.updateOne = async (filter, update) => {
    if (
      failCursorAndRetryWrites &&
      (update.$set?.cursor === 1 || update.$set?.status === "pending")
    ) {
      throw Object.assign(new Error("simulated worker process interruption"), {
        code: "SIMULATED_CRASH",
      });
    }
    return updateOne(filter, update);
  };
  let deliveries = 0;
  const firstWorker = createAssignmentPropagationWorker({
    workerId: "worker-before-crash",
    outboxModel: outbox,
    resolveAssignments,
    notificationModel: { bulkWrite: async () => {} },
    reconcile: async () => {
      deliveries += 1;
    },
    leaseMs: 30,
    leaseRenewIntervalMs: 1000,
    logger: { error() {} },
  });

  await assert.rejects(firstWorker.processOne(), { code: "SIMULATED_CRASH" });
  assert.equal(job.status, "processing");
  assert.equal(job.cursor, 0);

  failCursorAndRetryWrites = false;
  job.lease_expires_at = new Date(Date.now() - 1);
  const restartedWorker = createAssignmentPropagationWorker({
    workerId: "worker-after-crash",
    outboxModel: outbox,
    resolveAssignments,
    notificationModel: { bulkWrite: async () => {} },
    reconcile: async () => {
      deliveries += 1;
    },
    logger: { error() {} },
  });

  assert.equal(await restartedWorker.processOne(), true);
  assert.equal(job.status, "completed");
  assert.equal(deliveries, 2);
});

test("the configured attempt limit moves a persistent failure to dead letter", async () => {
  const job = {
    _id: "event-dead-letter",
    status: "pending",
    cursor: 0,
    attempts: 0,
    max_attempts: 2,
    recipients: [{ user_id: "student-fails", notification: null }],
    next_attempt_at: new Date(0),
  };
  const logged = [];
  const worker = createAssignmentPropagationWorker({
    workerId: "worker-dead-letter",
    outboxModel: createOutboxModel(job),
    resolveAssignments,
    notificationModel: { bulkWrite: async () => {} },
    reconcile: async () => {
      throw Object.assign(new Error("synthetic reconciliation failure"), {
        code: "SYNTHETIC_FAILURE",
      });
    },
    logger: {
      error: (...args) => logged.push(args),
      warn: (...args) => logged.push(args),
    },
  });

  assert.equal(await worker.processOne(), true);
  assert.equal(job.status, "pending");
  assert.equal(job.attempts, 1);
  job.next_attempt_at = new Date(0);

  assert.equal(await worker.processOne(), true);
  assert.equal(job.status, "dead_letter");
  assert.equal(job.attempts, 2);
  assert.ok(job.dead_letter_at instanceof Date);
  assert.equal(job.last_error_code, "SYNTHETIC_FAILURE");
  assert.ok(logged.some(([message, details]) =>
    message === "Assignment propagation job moved to dead letter." &&
    details.event === "ASSIGNMENT_PROPAGATION_DEAD_LETTER"
  ));
});

test("a replay worker crash recovers from its lease checkpoint and preserves duplicate safety", async () => {
  const child = {
    _id: "replay:dead-letter-001",
    replay_of: "event-dead-letter-001",
    replay_request_id: "replay-request-001",
    status: "processing",
    lease_owner: "worker-before-crash",
    lease_expires_at: new Date(Date.now() - 1),
    cursor: 0,
    attempts: 1,
    max_attempts: 10,
    recipients: [{ user_id: "student-current", notification: null }],
    next_attempt_at: new Date(0),
  };
  const parent = {
    _id: "event-dead-letter-001",
    active_replay_job_id: child._id,
  };
  let simulateCrash = true;
  const outboxModel = {
    findOneAndUpdate(_filter, update) {
      child.status = update.$set.status;
      child.lease_owner = update.$set.lease_owner;
      child.lease_expires_at = update.$set.lease_expires_at;
      child.attempts += update.$inc.attempts;
      return { lean: async () => structuredClone(child) };
    },
    async updateOne(filter, update) {
      if (filter._id === parent._id) {
        parent.active_replay_job_id = update.$set.active_replay_job_id;
        return { modifiedCount: 1 };
      }
      if (filter._id !== child._id || filter.lease_owner !== child.lease_owner) {
        return { modifiedCount: 0 };
      }
      if (simulateCrash && update.$set?.cursor === 1) {
        throw Object.assign(new Error("synthetic process interruption"), {
          code: "SIMULATED_CRASH",
        });
      }
      if (simulateCrash && update.$set?.status === "pending") {
        throw Object.assign(new Error("worker terminated before retry write"), {
          code: "SIMULATED_CRASH",
        });
      }
      Object.assign(child, update.$set);
      return { modifiedCount: 1 };
    },
  };
  const replayRecord = { status: "processing" };
  const replayModel = {
    async updateOne(_filter, update) {
      Object.assign(replayRecord, update.$set);
      return { modifiedCount: 1 };
    },
  };
  let reconciliations = 0;
  const firstWorker = createAssignmentPropagationWorker({
    workerId: "worker-before-crash",
    outboxModel,
    replayModel,
    resolveAssignments,
    notificationModel: { bulkWrite: async () => {} },
    reconcile: async () => {
      reconciliations += 1;
    },
    logger: { error() {}, warn() {} },
  });

  await assert.rejects(firstWorker.processOne(), { code: "SIMULATED_CRASH" });
  assert.equal(child.status, "processing");
  assert.equal(child.cursor, 0);
  assert.equal(parent.active_replay_job_id, child._id);

  simulateCrash = false;
  child.lease_expires_at = new Date(Date.now() - 1);
  const restartedWorker = createAssignmentPropagationWorker({
    workerId: "worker-after-crash",
    outboxModel,
    replayModel,
    resolveAssignments,
    notificationModel: { bulkWrite: async () => {} },
    reconcile: async () => {
      reconciliations += 1;
    },
    logger: { error() {}, warn() {} },
  });

  assert.equal(await restartedWorker.processOne(), true);
  assert.equal(child.status, "completed");
  assert.equal(child.cursor, 1);
  assert.equal(replayRecord.status, "completed");
  assert.equal(parent.active_replay_job_id, null);
  assert.equal(reconciliations, 2);
});

test("replay notifications keep the original deterministic identity", async () => {
  const job = {
    _id: "replay:notification",
    notification_source_id: "original-mutation",
    replay_of: "original-mutation",
    replay_request_id: "replay-request",
    status: "pending",
    cursor: 0,
    attempts: 0,
    recipients: [{
      user_id: "student-notification",
      notification: {
        type: "bus_reassigned",
        new_bus_no: "BUS-2",
      },
    }],
    next_attempt_at: new Date(0),
  };
  const notificationIds = [];
  const worker = createAssignmentPropagationWorker({
    workerId: "worker-replay-notification",
    outboxModel: createOutboxModel(job),
    replayModel: { updateOne: async () => ({ modifiedCount: 1 }) },
    notificationModel: {
      async bulkWrite(operations) {
        notificationIds.push(operations[0].updateOne.filter._id.toString());
      },
    },
    resolveAssignments: async () => new Map([[
      "student-notification",
      {
        assignmentStatus: "assigned",
        effectiveBus: { bus_no: "BUS-2" },
      },
    ]]),
    reconcile: async () => {},
    logger: { error() {} },
  });

  assert.equal(await worker.processOne(), true);
  assert.equal(
    notificationIds[0],
    createNotificationId("original-mutation", "student-notification").toString(),
  );
});
