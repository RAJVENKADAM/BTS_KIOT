"use strict";

const { randomUUID, createHash } = require("node:crypto");
const mongoose = require("mongoose");
const AdministrativeChangeAudit = require("../models/AdministrativeChangeAudit");
const AssignmentPropagationOutbox = require("../models/AssignmentPropagationOutbox");
const AssignmentPropagationReplay = require("../models/AssignmentPropagationReplay");
const Notification = require("../models/Notification");
const {
  reconcileStudentSockets,
  resolveStudentAssignments,
} = require("./studentBusAssignment");

const BATCH_SIZE = 200;
const DEFAULT_LEASE_MS = 30_000;
const MAX_RETRY_MS = 15 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 10;

function getMaxAttempts(env = process.env) {
  const configured = env.ASSIGNMENT_PROPAGATION_MAX_ATTEMPTS;
  const value = configured === undefined || configured === ""
    ? DEFAULT_MAX_ATTEMPTS
    : Number(configured);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error(
      "ASSIGNMENT_PROPAGATION_MAX_ATTEMPTS must be an integer from 1 to 100.",
    );
  }
  return value;
}

function getRetryDelayMs(attempts) {
  const exponent = Math.max(0, Math.min(Number(attempts) || 0, 10));
  return Math.min(MAX_RETRY_MS, 1000 * (2 ** exponent));
}

function hashKey(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function createMutationId(scope, idempotencyKey) {
  return `mapping:${hashKey(`${scope}\u0000${idempotencyKey}`)}`;
}

function createNotificationId(mutationId, userId) {
  return new mongoose.Types.ObjectId(
    hashKey(`${mutationId}\u0000${String(userId)}`).slice(0, 24),
  );
}

function getAssignmentIdentifiers(assignment) {
  const buses = [
    assignment?.effectiveBus,
    assignment?.locationBus,
    assignment?.routeBus,
    assignment?.sourceBus,
  ];
  return new Set(
    buses
      .flatMap((bus) => [bus?.bus_no, bus?.preview_number])
      .filter((value) => value !== null && value !== undefined && value !== "")
      .map((value) => String(value).trim().toUpperCase()),
  );
}

function notificationMatchesAssignment(notification, assignment) {
  if (!assignment) return false;
  const targets = [
    notification?.new_bus_no,
    notification?.new_preview,
    notification?.new_preview_number,
  ]
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) => String(value).trim().toUpperCase());
  if (!targets.length) {
    return String(notification?.type || "").includes("unassigned")
      ? assignment.assignmentStatus === "unassigned"
      : assignment.assignmentStatus === "assigned" ||
          assignment.assignmentStatus === "unavailable";
  }
  const identifiers = getAssignmentIdentifiers(assignment);
  return targets.some((target) => identifiers.has(target));
}

async function enqueueAssignmentPropagation({
  session,
  mutationId = randomUUID(),
  actorId = null,
  operation,
  recipients = [],
  previousState = null,
  newState = null,
  version = null,
}) {
  const normalizedRecipients = recipients
    .filter((recipient) => recipient?.user_id)
    .map((recipient) => ({
      user_id: recipient.user_id,
      notification: recipient.notification || null,
    }));

  await AssignmentPropagationOutbox.updateOne(
    { _id: mutationId },
    {
      $setOnInsert: {
        _id: mutationId,
        actor_id: actorId,
        operation,
        recipients: normalizedRecipients,
        previous_state: previousState,
        new_state: newState,
        version,
        cursor: 0,
        status: "pending",
        attempts: 0,
        max_attempts: getMaxAttempts(),
        next_attempt_at: new Date(),
      },
    },
    { upsert: true, ...(session ? { session } : {}) },
  );
  return mutationId;
}

async function recordAssignmentMutation({
  session,
  mutationId = randomUUID(),
  actorId = null,
  action,
  resourceId = null,
  requestId = null,
  recipients = [],
  previousState = null,
  newState = null,
  resourceRevisionBefore = null,
  resourceRevisionAfter = null,
  assignmentRevisionBefore = null,
  assignmentRevisionAfter = null,
  busRevisionBefore = null,
  busRevisionAfter = null,
}) {
  await AdministrativeChangeAudit.create(
    [{
      _id: mutationId,
      actor_id: actorId,
      action,
      resource_id: resourceId == null ? null : String(resourceId),
      request_id: requestId == null ? null : String(requestId),
      previous_state: previousState,
      new_state: newState,
      resource_revision_before: resourceRevisionBefore,
      resource_revision_after: resourceRevisionAfter,
      assignment_revision_before: assignmentRevisionBefore,
      assignment_revision_after: assignmentRevisionAfter,
      bus_revision_before: busRevisionBefore,
      bus_revision_after: busRevisionAfter,
    }],
    session ? { session } : {},
  );
  await enqueueAssignmentPropagation({
    session,
    mutationId,
    actorId,
    operation: action,
    recipients,
    previousState,
    newState,
  });
  return mutationId;
}

function createAssignmentPropagationWorker({
  workerId = randomUUID(),
  outboxModel = AssignmentPropagationOutbox,
  notificationModel = Notification,
  replayModel = AssignmentPropagationReplay,
  reconcile = reconcileStudentSockets,
  resolveAssignments = resolveStudentAssignments,
  now = () => new Date(),
  leaseMs = DEFAULT_LEASE_MS,
  leaseRenewIntervalMs = Math.max(1, Math.floor(leaseMs / 3)),
  batchSize = BATCH_SIZE,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = console,
} = {}) {
  let running = false;

  async function claim() {
    const currentTime = now();
    return outboxModel.findOneAndUpdate(
      {
        next_attempt_at: { $lte: currentTime },
        $or: [
          { status: "pending" },
          {
            status: "processing",
            lease_expires_at: { $lte: currentTime },
          },
        ],
      },
      {
        $set: {
          status: "processing",
          lease_owner: workerId,
          lease_expires_at: new Date(currentTime.getTime() + leaseMs),
        },
        $inc: { attempts: 1 },
      },
      {
        new: true,
        sort: { createdAt: 1 },
      },
    ).lean();
  }

  async function renewLease(job) {
    const currentTime = now();
    const result = await outboxModel.updateOne(
      {
        _id: job._id,
        status: "processing",
        lease_owner: workerId,
        lease_expires_at: { $gt: currentTime },
      },
      {
        $set: {
          lease_expires_at: new Date(currentTime.getTime() + leaseMs),
        },
      },
    );
    return result.modifiedCount === 1;
  }

  function startLeaseRenewal(job) {
    let leaseLost = false;
    let renewing = false;
    let pendingRenewal = Promise.resolve();
    const timer = setIntervalFn(() => {
      if (renewing || leaseLost) return;
      renewing = true;
      pendingRenewal = renewLease(job)
        .then((renewed) => {
          if (!renewed) leaseLost = true;
        })
        .catch((error) => {
          leaseLost = true;
          logger.error?.("Assignment propagation lease renewal failed.", {
            mutationId: job._id,
            code: error?.code || error?.name || "Error",
          });
        })
        .finally(() => {
          renewing = false;
        });
    }, leaseRenewIntervalMs);
    timer.unref?.();

    return {
      async assertOwned() {
        await pendingRenewal;
        if (leaseLost) {
          const error = new Error("Assignment propagation lease was lost.");
          error.code = "ASSIGNMENT_PROPAGATION_LEASE_LOST";
          throw error;
        }
      },
      async stop() {
        clearIntervalFn(timer);
        await pendingRenewal;
      },
    };
  }

  async function processBatch(job, assertLeaseOwned) {
    await assertLeaseOwned();
    const recipients = job.recipients || [];
    const batch = recipients.slice(job.cursor, job.cursor + batchSize);
    if (!batch.length) {
      const result = await outboxModel.updateOne(
        { _id: job._id, status: "processing", lease_owner: workerId },
        {
          $set: {
            status: "completed",
            completed_at: now(),
            lease_owner: null,
            lease_expires_at: null,
            last_error_code: null,
          },
        },
      );
      if (result.modifiedCount !== 1) {
        const error = new Error("Assignment propagation job ownership changed.");
        error.code = "ASSIGNMENT_PROPAGATION_LEASE_LOST";
        throw error;
      }
      return true;
    }

    const userIds = [...new Set(batch.map((recipient) => String(recipient.user_id)))];
    await reconcile(userIds);
    await assertLeaseOwned();
    const assignments = await resolveAssignments(userIds);
    await assertLeaseOwned();
    const notifications = batch.flatMap((recipient) => {
      if (!recipient.notification) return [];
      const assignment = assignments.get(String(recipient.user_id));
      if (!notificationMatchesAssignment(recipient.notification, assignment)) {
        return [];
      }
      return [{
        updateOne: {
          filter: {
            _id: createNotificationId(
              job.notification_source_id || job._id,
              recipient.user_id,
            ),
          },
          update: {
            $setOnInsert: {
              ...recipient.notification,
              user_id: recipient.user_id,
            },
          },
          upsert: true,
        },
      }];
    });

    if (notifications.length) {
      await notificationModel.bulkWrite(notifications, { ordered: false });
    }

    const nextCursor = job.cursor + batch.length;
    const result = await outboxModel.updateOne(
      {
        _id: job._id,
        status: "processing",
        lease_owner: workerId,
        cursor: job.cursor,
      },
      {
        $set: {
          cursor: nextCursor,
          status: nextCursor >= recipients.length ? "completed" : "pending",
          next_attempt_at: now(),
          lease_owner: null,
          lease_expires_at: null,
          last_error_code: null,
          ...(nextCursor >= recipients.length ? { completed_at: now() } : {}),
        },
      },
    );
    if (result.modifiedCount !== 1) {
      const error = new Error("Assignment propagation job ownership changed.");
      error.code = "ASSIGNMENT_PROPAGATION_LEASE_LOST";
      throw error;
    }
    return nextCursor >= recipients.length;
  }

  async function completeReplay(job, status, errorCode = null) {
    if (!job.replay_request_id || !job.replay_of) return;
    await replayModel.updateOne(
      { _id: job.replay_request_id },
      {
        $set: {
          status,
          last_error_code: errorCode,
          ...(status === "completed" ? { completed_at: now() } : {}),
        },
      },
    );
    await outboxModel.updateOne(
      { _id: job.replay_of, active_replay_job_id: job._id },
      { $set: { active_replay_job_id: null } },
    );
  }

  async function processOne() {
    if (running) return false;
    running = true;
    try {
      const job = await claim();
      if (!job) return false;
      if (job.replay_request_id) {
        await replayModel.updateOne(
          { _id: job.replay_request_id, status: "requested" },
          { $set: { status: "processing" } },
        );
      }
      const lease = startLeaseRenewal(job);
      try {
        const completed = await processBatch(job, lease.assertOwned);
        if (completed) {
          try {
            await completeReplay(job, "completed");
          } catch (error) {
            logger.error?.("Assignment propagation replay completion was not recorded.", {
              mutationId: job._id,
              replayRequestId: job.replay_request_id,
              code: error?.code || error?.name || "Error",
            });
          }
        }
      } catch (error) {
        const delay = getRetryDelayMs(job.attempts);
        const terminal = (job.attempts || 0) >=
          (job.max_attempts || getMaxAttempts());
        const updateResult = await outboxModel.updateOne(
          { _id: job._id, status: "processing", lease_owner: workerId },
          {
            $set: {
              status: terminal ? "dead_letter" : "pending",
              ...(terminal
                ? { dead_letter_at: now() }
                : { next_attempt_at: new Date(now().getTime() + delay) }),
              lease_owner: null,
              lease_expires_at: null,
              last_error_code: String(error?.code || error?.name || "Error").slice(0, 80),
              last_error_name: String(error?.name || "Error").slice(0, 80),
              last_error_at: now(),
            },
          },
        );
        if (updateResult.modifiedCount !== 1) {
          logger.warn?.("Assignment propagation failure was not recorded because the lease changed.", {
            mutationId: job._id,
            code: error?.code || error?.name || "Error",
          });
        } else if (terminal) {
          try {
            await completeReplay(
              job,
              "dead_letter",
              String(error?.code || error?.name || "Error").slice(0, 80),
            );
          } catch (replayError) {
            logger.error?.("Assignment propagation replay failure was not recorded.", {
              mutationId: job._id,
              replayRequestId: job.replay_request_id,
              code: replayError?.code || replayError?.name || "Error",
            });
          }
          logger.error?.("Assignment propagation job moved to dead letter.", {
            event: "ASSIGNMENT_PROPAGATION_DEAD_LETTER",
            mutationId: job._id,
            operation: job.operation,
            attempts: job.attempts,
            code: error?.code || error?.name || "Error",
          });
        } else {
          logger.error?.("Assignment propagation delivery deferred.", {
            mutationId: job._id,
            code: error?.code || error?.name || "Error",
          });
        }
      } finally {
        await lease.stop();
      }
      return true;
    } finally {
      running = false;
    }
  }

  function start({ intervalMs = 1000, setIntervalFn = setInterval } = {}) {
    const timer = setIntervalFn(() => {
      processOne().catch((error) => {
        logger.error?.("Assignment propagation worker failed.", {
          code: error?.code || error?.name || "Error",
        });
      });
    }, intervalMs);
    timer.unref?.();
    processOne().catch((error) => {
      logger.error?.("Assignment propagation worker startup pass failed.", {
        code: error?.code || error?.name || "Error",
      });
    });
    return () => clearInterval(timer);
  }

  return { processOne, start };
}

module.exports = {
  DEFAULT_MAX_ATTEMPTS,
  MAX_RETRY_MS,
  createAssignmentPropagationWorker,
  createMutationId,
  createNotificationId,
  enqueueAssignmentPropagation,
  getAssignmentIdentifiers,
  getMaxAttempts,
  getRetryDelayMs,
  hashKey,
  notificationMatchesAssignment,
  recordAssignmentMutation,
};
