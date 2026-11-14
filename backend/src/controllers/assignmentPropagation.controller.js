"use strict";

const { createHash } = require("node:crypto");
const mongoose = require("mongoose");
const AdministrativeChangeAudit = require("../models/AdministrativeChangeAudit");
const AssignmentPropagationOutbox = require("../models/AssignmentPropagationOutbox");
const AssignmentPropagationReplay = require("../models/AssignmentPropagationReplay");
const { getMaxAttempts } = require("../services/assignmentPropagation");
const { logSafeError } = require("../utils/safeErrorLog");

function makeError(message, code, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function getIdempotencyKey(req) {
  return req.get?.("Idempotency-Key") || req.headers?.["idempotency-key"];
}

function withSession(query, session) {
  return typeof query.session === "function" ? query.session(session) : query;
}

async function listAssignmentPropagationJobs(req, res) {
  try {
    const rawLimit = Number(req.query?.limit ?? 50);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
      return res.status(400).json({
        success: false,
        error: "limit must be an integer from 1 to 100.",
      });
    }
    const filter = {};
    if (req.query?.status) {
      if (!["pending", "processing", "completed", "dead_letter"].includes(req.query.status)) {
        return res.status(400).json({ success: false, error: "Unsupported job status." });
      }
      filter.status = req.query.status;
    }
    const jobs = await AssignmentPropagationOutbox.find(filter)
      .select(
        "_id operation status attempts max_attempts cursor recipients createdAt updatedAt next_attempt_at last_error_code last_error_name last_error_at dead_letter_at completed_at replay_of replay_history active_replay_job_id",
      )
      .sort({ createdAt: -1, _id: 1 })
      .limit(rawLimit)
      .lean();

    return res.status(200).json({
      success: true,
      jobs: jobs.map((job) => ({
        id: job._id,
        operation: job.operation,
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.max_attempts,
        cursor: job.cursor,
        recipientCount: job.recipients?.length ?? 0,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        nextAttemptAt: job.next_attempt_at,
        lastError: job.last_error_code
          ? {
              code: job.last_error_code,
              name: job.last_error_name,
              at: job.last_error_at,
            }
          : null,
        deadLetterAt: job.dead_letter_at,
        completedAt: job.completed_at,
        replayOf: job.replay_of,
        activeReplayJobId: job.active_replay_job_id,
        replayHistory: job.replay_history || [],
      })),
    });
  } catch (error) {
    logSafeError("Assignment propagation job listing failed", error, req.requestId);
    return res.status(500).json({
      success: false,
      error: "Unable to load assignment propagation jobs.",
      code: error?.code || error?.name || "ASSIGNMENT_PROPAGATION_STATUS_ERROR",
    });
  }
}

async function replayAssignmentPropagationJob(req, res) {
  const administratorId = String(req.user?.id || "");
  if (String(req.user?.role || "").toLowerCase() !== "superadmin") {
    return res.status(403).json({
      success: false,
      error: "Only a superadmin can replay assignment propagation jobs.",
    });
  }
  const idempotencyKey = getIdempotencyKey(req);
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  const mode = req.body?.fullReconciliation === true ? "full" : "resume";

  if (!mongoose.Types.ObjectId.isValid(administratorId)) {
    return res.status(401).json({ success: false, error: "Authentication required." });
  }
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim().length < 8 ||
    idempotencyKey.trim().length > 200
  ) {
    return res.status(400).json({
      success: false,
      error: "Provide a valid Idempotency-Key header.",
    });
  }
  if (!reason || reason.length > 1000) {
    return res.status(400).json({
      success: false,
      error: "Provide a replay reason of 1 to 1000 characters.",
    });
  }

  const requestId = stableHash(
    `${req.params.jobId}\u0000${administratorId}\u0000${idempotencyKey.trim()}`,
  );
  const requestHash = stableHash({
    jobId: req.params.jobId,
    administratorId,
    reason,
    mode,
  });
  const replayJobId = `replay:${requestId}`;
  const replayHistoryId = `assignment-propagation-replay:${requestId}`;
  let session;

  try {
    session = await mongoose.startSession();
    let response;
    await session.withTransaction(async () => {
      const existingQuery = withSession(
        AssignmentPropagationReplay.findById(requestId),
        session,
      );
      const existing = await existingQuery.lean();
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw makeError(
            "This Idempotency-Key was already used for a different replay request.",
            "ASSIGNMENT_REPLAY_IDEMPOTENCY_CONFLICT",
          );
        }
        response = {
          duplicate: true,
          replayJobId: existing.replay_job_id,
          status: existing.status,
        };
        return;
      }

      const sourceQuery = withSession(
        AssignmentPropagationOutbox.findById(req.params.jobId),
        session,
      );
      const source = await sourceQuery.lean();
      if (!source || source.status !== "dead_letter") {
        throw makeError(
          "Only dead-lettered assignment propagation jobs can be replayed.",
          "ASSIGNMENT_REPLAY_JOB_NOT_DEAD_LETTERED",
          404,
        );
      }
      if (source.active_replay_job_id) {
        const activeReplayQuery = withSession(
          AssignmentPropagationOutbox.findById(source.active_replay_job_id),
          session,
        );
        const activeReplay = await activeReplayQuery.lean();
        if (
          activeReplay &&
          !["completed", "dead_letter"].includes(activeReplay.status)
        ) {
          throw makeError(
            "A replay for this job is already active.",
            "ASSIGNMENT_REPLAY_ALREADY_ACTIVE",
          );
        }
      }

      const history = {
        replay_id: requestId,
        replay_job_id: replayJobId,
        administrator_id: administratorId,
        reason,
        mode,
        requested_at: new Date(),
      };
      const locked = await AssignmentPropagationOutbox.updateOne(
        {
          _id: source._id,
          status: "dead_letter",
          active_replay_job_id: source.active_replay_job_id ?? null,
        },
        {
          $set: { active_replay_job_id: replayJobId },
          $push: { replay_history: history },
        },
        { session },
      );
      if (locked.modifiedCount !== 1) {
        throw makeError(
          "A replay for this job is already active.",
          "ASSIGNMENT_REPLAY_ALREADY_ACTIVE",
        );
      }

      const recipients = mode === "full"
        ? source.recipients || []
        : (source.recipients || []).slice(source.cursor || 0);
      const replay = {
        _id: requestId,
        original_job_id: String(source._id),
        replay_job_id: replayJobId,
        administrator_id: administratorId,
        reason,
        mode,
        request_hash: requestHash,
        status: "requested",
      };
      await AssignmentPropagationReplay.create([replay], { session });
      await AssignmentPropagationOutbox.create(
        [{
          _id: replayJobId,
          actor_id: administratorId,
          operation: `manual-replay:${source.operation}`,
          recipients: recipients.map((recipient) => ({
            user_id: recipient.user_id,
            notification: recipient.notification || null,
          })),
          previous_state: null,
          new_state: null,
          replay_of: String(source._id),
          replay_request_id: requestId,
          notification_source_id: source.notification_source_id || String(source._id),
          cursor: 0,
          status: "pending",
          attempts: 0,
          max_attempts: getMaxAttempts(),
          next_attempt_at: new Date(),
        }],
        { session },
      );
      await AdministrativeChangeAudit.create(
        [{
          _id: replayHistoryId,
          actor_id: administratorId,
          action: mode === "full"
            ? "assignment-propagation-full-reconciliation-requested"
            : "assignment-propagation-replay-requested",
          resource_id: String(source._id),
          request_id: idempotencyKey.trim(),
          previous_state: {
            status: source.status,
            cursor: source.cursor || 0,
          },
          new_state: {
            replay_job_id: replayJobId,
            mode,
            reason,
          },
        }],
        { session },
      );
      response = {
        duplicate: false,
        replayJobId,
        status: "requested",
        resumedFromCursor: mode === "full" ? 0 : source.cursor || 0,
      };
    });

    return res.status(response.duplicate ? 200 : 202).json({
      success: true,
      ...response,
    });
  } catch (error) {
    if (error?.code === 11000) {
      try {
        const existing = await AssignmentPropagationReplay.findById(requestId).lean();
        if (existing) {
          if (existing.request_hash !== requestHash) {
            return res.status(409).json({
              success: false,
              error: "This Idempotency-Key was already used for a different replay request.",
              code: "ASSIGNMENT_REPLAY_IDEMPOTENCY_CONFLICT",
            });
          }
          return res.status(200).json({
            success: true,
            duplicate: true,
            replayJobId: existing.replay_job_id,
            status: existing.status,
          });
        }
      } catch (lookupError) {
        logSafeError(
          "Assignment propagation replay idempotency lookup failed",
          lookupError,
          req.requestId,
        );
      }
    }
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    if (statusCode === 500) {
      logSafeError("Assignment propagation replay request failed", error, req.requestId);
    }
    return res.status(statusCode).json({
      success: false,
      error: statusCode === 500
        ? "Unable to request assignment propagation replay."
        : error.message,
      code: error?.code || error?.name || "ASSIGNMENT_REPLAY_ERROR",
    });
  } finally {
    await session?.endSession();
  }
}

module.exports = {
  listAssignmentPropagationJobs,
  replayAssignmentPropagationJob,
};
