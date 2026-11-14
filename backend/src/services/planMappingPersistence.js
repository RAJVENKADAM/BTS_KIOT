"use strict";

const { createHash } = require("node:crypto");
const AdministrativeChangeAudit = require("../models/AdministrativeChangeAudit");
const PlanMapping = require("../models/PlanMapping");
const PlanMappingAudit = require("../models/PlanMappingAudit");
const PlanMappingRevision = require("../models/PlanMappingRevision");
const User = require("../models/User");
const { createMutationId, enqueueAssignmentPropagation } = require("./assignmentPropagation");
const { runGpsConfigurationMutation } = require("./gpsConfigurationBarrier");

function persistPlanMappingOperations(operations) {
  return runGpsConfigurationMutation((session) =>
    PlanMapping.bulkWrite(operations, {
      ordered: true,
      ...(session ? { session } : {}),
    }),
  );
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function createRequestHash(request) {
  return createHash("sha256").update(stableStringify(request)).digest("hex");
}

function createMappingMutationError(message, code, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

async function incrementRecipientAssignmentRevisions(recipients, session) {
  const userIds = [...new Set(
    recipients.map((recipient) => String(recipient?.user_id || "")).filter(Boolean),
  )];
  if (!userIds.length) return [];

  let usersQuery = User.find({
    _id: { $in: userIds },
    role: "student",
    is_active: true,
    deleted_by_user: { $ne: true },
  }).select("_id assignmentRevision");
  if (session) usersQuery = usersQuery.session(session);
  const users = await usersQuery.lean();
  const revisions = [];

  for (const user of users) {
    const expectedRevision = user.assignmentRevision ?? 0;
    const revisionFilter = expectedRevision === 0
      ? {
          $or: [
            { assignmentRevision: 0 },
            { assignmentRevision: { $exists: false } },
          ],
        }
      : { assignmentRevision: expectedRevision };
    const result = await User.updateOne(
      { $and: [{ _id: user._id }, revisionFilter] },
      { $inc: { assignmentRevision: 1 } },
      session ? { session } : {},
    );
    if (result.matchedCount !== 1) {
      throw createMappingMutationError(
        "A student assignment changed while the plan mapping was being updated. Reload and retry.",
        "PLAN_MAPPING_ASSIGNMENT_CONFLICT",
      );
    }
    revisions.push({
      user_id: user._id,
      before: expectedRevision,
      after: expectedRevision + 1,
    });
  }
  return revisions;
}

async function findAuditRecord(mutationId, session) {
  let query = PlanMappingAudit.findById(mutationId);
  if (session) query = query.session(session);
  return query.lean();
}

async function runPlanMappingMutation({
  scope,
  idempotencyKey,
  expectedVersion,
  actorId,
  action,
  request,
  previousState,
  newState,
  recipients = [],
  mutate,
}) {
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim().length < 8 ||
    idempotencyKey.trim().length > 200
  ) {
    throw createMappingMutationError(
      "Provide a valid Idempotency-Key header.",
      "PLAN_MAPPING_IDEMPOTENCY_KEY_REQUIRED",
      400,
    );
  }
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    throw createMappingMutationError(
      "Provide the current mapping version.",
      "PLAN_MAPPING_VERSION_REQUIRED",
      428,
    );
  }
  if (typeof mutate !== "function") {
    throw new TypeError("Plan mapping mutation callback is required.");
  }

  const key = idempotencyKey.trim();
  const mutationId = createMutationId(scope, key);
  const requestHash = createRequestHash(request);
  const execute = async (session) => {
    const existing = await findAuditRecord(mutationId, session);
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw createMappingMutationError(
          "This Idempotency-Key was already used for a different request.",
          "PLAN_MAPPING_IDEMPOTENCY_CONFLICT",
        );
      }
      return {
        duplicate: true,
        version: existing.version,
        response: existing.response,
      };
    }

    let revisionQuery = PlanMappingRevision.findOneAndUpdate(
      { _id: scope, version: expectedVersion },
      {
        $setOnInsert: { _id: scope },
        $inc: { version: 1 },
      },
      {
        new: true,
        upsert: expectedVersion === 0,
        ...(session ? { session } : {}),
      },
    );
    if (typeof revisionQuery.lean === "function") {
      revisionQuery = revisionQuery.lean();
    }
    const revision = await revisionQuery;
    if (!revision) {
      throw createMappingMutationError(
        "The mapping has changed. Reload it before applying this update.",
        "PLAN_MAPPING_VERSION_CONFLICT",
      );
    }

    const assignmentRevisions = await incrementRecipientAssignmentRevisions(
      recipients,
      session,
    );
    const result = await mutate(session);
    const response =
      result && Object.hasOwn(result, "response") ? result.response : result;
    await PlanMappingAudit.create(
      [
        {
          _id: mutationId,
          actor_id: actorId,
          action,
          scope,
          request_hash: requestHash,
          expected_version: expectedVersion,
          version: revision.version,
          assignment_revisions: assignmentRevisions,
          previous_state: previousState,
          new_state: newState,
          response,
        },
      ],
      session ? { session } : {},
    );
    await AdministrativeChangeAudit.create(
      [{
        _id: mutationId,
        actor_id: actorId,
        action,
        resource_id: scope,
        request_id: key,
        assignment_revision_before: Object.fromEntries(
          assignmentRevisions.map((item) => [String(item.user_id), item.before]),
        ),
        assignment_revision_after: Object.fromEntries(
          assignmentRevisions.map((item) => [String(item.user_id), item.after]),
        ),
        previous_state: previousState,
        new_state: newState,
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
      version: revision.version,
    });
    return { duplicate: false, version: revision.version, response };
  };

  try {
    return await runGpsConfigurationMutation(execute);
  } catch (error) {
    if (error?.code === 11000) {
      const existing = await findAuditRecord(mutationId);
      if (existing && existing.request_hash === requestHash) {
        return {
          duplicate: true,
          version: existing.version,
          response: existing.response,
        };
      }
      if (!existing) {
        throw createMappingMutationError(
          "The mapping has changed. Reload it before applying this update.",
          "PLAN_MAPPING_VERSION_CONFLICT",
        );
      }
    }
    throw error;
  }
}

async function runPlanMappingNoop({
  scope,
  idempotencyKey,
  expectedVersion,
  actorId,
  action,
  request,
  previousState,
  newState,
  response,
}) {
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim().length < 8 ||
    idempotencyKey.trim().length > 200
  ) {
    throw createMappingMutationError(
      "Provide a valid Idempotency-Key header.",
      "PLAN_MAPPING_IDEMPOTENCY_KEY_REQUIRED",
      400,
    );
  }
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    throw createMappingMutationError(
      "Provide the current mapping version.",
      "PLAN_MAPPING_VERSION_REQUIRED",
      428,
    );
  }

  const key = idempotencyKey.trim();
  const mutationId = createMutationId(scope, key);
  const requestHash = createRequestHash(request);
  const execute = async (session) => {
    const existing = await findAuditRecord(mutationId, session);
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw createMappingMutationError(
          "This Idempotency-Key was already used for a different request.",
          "PLAN_MAPPING_IDEMPOTENCY_CONFLICT",
        );
      }
      return {
        duplicate: true,
        version: existing.version,
        response: existing.response,
      };
    }

    let revisionQuery = PlanMappingRevision.findOneAndUpdate(
      { _id: scope, version: expectedVersion },
      { $inc: { version: 0 } },
      {
        new: true,
        upsert: expectedVersion === 0,
        setDefaultsOnInsert: true,
        ...(session ? { session } : {}),
      },
    );
    if (typeof revisionQuery.lean === "function") {
      revisionQuery = revisionQuery.lean();
    }
    const revision = await revisionQuery;
    if (!revision) {
      throw createMappingMutationError(
        "The mapping has changed. Reload it before applying this update.",
        "PLAN_MAPPING_VERSION_CONFLICT",
      );
    }

    await PlanMappingAudit.create(
      [
        {
          _id: mutationId,
          actor_id: actorId,
          action,
          scope,
          request_hash: requestHash,
          expected_version: expectedVersion,
          version: revision.version,
          previous_state: previousState,
          new_state: newState,
          response,
        },
      ],
      session ? { session } : {},
    );
    return { duplicate: false, version: revision.version, response };
  };

  try {
    return await runGpsConfigurationMutation(execute);
  } catch (error) {
    if (error?.code === 11000) {
      const existing = await findAuditRecord(mutationId);
      if (existing && existing.request_hash === requestHash) {
        return {
          duplicate: true,
          version: existing.version,
          response: existing.response,
        };
      }
      if (!existing) {
        throw createMappingMutationError(
          "The mapping has changed. Reload it before applying this update.",
          "PLAN_MAPPING_VERSION_CONFLICT",
        );
      }
    }
    throw error;
  }
}

async function getPlanMappingVersions(scopes) {
  const normalizedScopes = [...new Set(scopes.filter(Boolean))];
  if (!normalizedScopes.length) return {};
  const revisions = await PlanMappingRevision.find({
    _id: { $in: normalizedScopes },
  })
    .select("_id version")
    .lean();
  return Object.fromEntries(
    normalizedScopes.map((scope) => [
      scope,
      revisions.find((item) => item._id === scope)?.version ?? 0,
    ]),
  );
}

function deletePlanMappingById(id) {
  return runGpsConfigurationMutation((session) =>
    PlanMapping.deleteOne(
      { _id: id },
      session ? { session } : {},
    ),
  );
}

module.exports = {
  createRequestHash,
  deletePlanMappingById,
  getPlanMappingVersions,
  persistPlanMappingOperations,
  runPlanMappingMutation,
  runPlanMappingNoop,
};
