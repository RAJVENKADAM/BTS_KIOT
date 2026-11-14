"use strict";

const { createHash } = require("node:crypto");
const MutationIdempotency = require("../models/MutationIdempotency");
const { runGpsConfigurationMutation } = require("./gpsConfigurationBarrier");

const inFlightMutations = new Map();

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

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function makeError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function getMutationHeaders(req, { expectedVersionField = "expectedVersion" } = {}) {
  const idempotencyKey =
    req.get?.("Idempotency-Key") || req.headers?.["idempotency-key"];
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim().length < 8 ||
    idempotencyKey.trim().length > 200
  ) {
    throw makeError(
      "Provide a valid Idempotency-Key header.",
      "IDEMPOTENCY_KEY_REQUIRED",
      400,
    );
  }

  const rawVersion =
    req.body?.[expectedVersionField] ??
    req.get?.("If-Match") ??
    req.headers?.["if-match"];
  const versionText =
    typeof rawVersion === "string" ? rawVersion.replaceAll('"', "") : rawVersion;
  const expectedVersion =
    typeof versionText === "number" ? versionText : Number(versionText);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    throw makeError(
      `Provide a valid ${expectedVersionField}.`,
      "RESOURCE_VERSION_REQUIRED",
      428,
    );
  }

  return { idempotencyKey: idempotencyKey.trim(), expectedVersion };
}

async function findRecord(id, session) {
  let query = MutationIdempotency.findById(id);
  if (session && typeof query.session === "function") query = query.session(session);
  return query.lean();
}

async function checkIdempotentReplay({
  scope,
  idempotencyKey,
  request,
  expectedVersion,
}) {
  const id = `mutation:${hash(`${scope}\u0000${String(idempotencyKey || "").trim()}`)}`;
  const requestHash = hash(stableStringify({ request, expectedVersion }));
  const existing = await findRecord(id);
  if (!existing) return null;
  if (existing.request_hash !== requestHash) {
    throw makeError(
      "This Idempotency-Key was already used for a different request.",
      "IDEMPOTENCY_KEY_CONFLICT",
      409,
    );
  }
  return {
    duplicate: true,
    response: existing.response,
    resourceVersion: existing.resource_version,
  };
}

async function runIdempotentMutation({
  scope,
  idempotencyKey,
  actorId = null,
  request,
  resourceId = null,
  expectedVersion,
  mutate,
  barrier = runGpsConfigurationMutation,
}) {
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim().length < 8 ||
    idempotencyKey.trim().length > 200
  ) {
    throw makeError("Provide a valid Idempotency-Key header.", "IDEMPOTENCY_KEY_REQUIRED", 400);
  }
  if (
    expectedVersion !== undefined &&
    (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
  ) {
    throw makeError("Provide a valid expected resource version.", "RESOURCE_VERSION_REQUIRED", 428);
  }
  if (typeof mutate !== "function") throw new TypeError("Mutation callback is required.");

  const normalizedKey = idempotencyKey.trim();
  const id = `mutation:${hash(`${scope}\u0000${normalizedKey}`)}`;
  const requestHash = hash(stableStringify({ request, expectedVersion }));
  const execute = async (session) => {
    const existing = await findRecord(id, session);
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw makeError(
          "This Idempotency-Key was already used for a different request.",
          "IDEMPOTENCY_KEY_CONFLICT",
          409,
        );
      }
      return {
        duplicate: true,
        response: existing.response,
        resourceVersion: existing.resource_version,
      };
    }

    if (session) {
      await MutationIdempotency.create(
        [{
          _id: id,
          scope,
          request_hash: requestHash,
          actor_id: actorId,
          response: null,
          resource_id: resourceId == null ? null : String(resourceId),
          resource_version: null,
        }],
        { session },
      );
    }

    const result = await mutate(session);
    const response =
      result && Object.hasOwn(result, "response") ? result.response : result;
    const resourceVersion =
      result?.resourceVersion ??
      (Number.isSafeInteger(expectedVersion) ? expectedVersion + 1 : null);
    if (session) {
      const completion = await MutationIdempotency.updateOne(
        { _id: id, request_hash: requestHash },
        { $set: { response, resource_version: resourceVersion } },
        { session },
      );
      if (completion.matchedCount !== 1) {
        throw new Error("Could not finalize the mutation idempotency record.");
      }
    } else {
      await MutationIdempotency.create(
        [{
          _id: id,
          scope,
          request_hash: requestHash,
          actor_id: actorId,
          response,
          resource_id: resourceId == null ? null : String(resourceId),
          resource_version: resourceVersion,
        }],
      );
    }
    return {
      duplicate: false,
      response,
      resourceVersion,
    };
  };

  const active = inFlightMutations.get(id);
  if (active) {
    if (active.requestHash !== requestHash) {
      throw makeError(
        "This Idempotency-Key was already used for a different request.",
        "IDEMPOTENCY_KEY_CONFLICT",
        409,
      );
    }
    const result = await active.promise;
    return { ...result, duplicate: true };
  }

  const operation = (async () => {
    try {
      return await barrier(execute);
    } catch (error) {
      if (error?.code === 11000) {
        const existing = await findRecord(id);
        if (existing?.request_hash === requestHash) {
          return {
            duplicate: true,
            response: existing.response,
            resourceVersion: existing.resource_version,
          };
        }
        if (existing) {
          throw makeError(
            "This Idempotency-Key was already used for a different request.",
            "IDEMPOTENCY_KEY_CONFLICT",
            409,
          );
        }
      }
      throw error;
    }
  })();
  inFlightMutations.set(id, { requestHash, promise: operation });
  try {
    return await operation;
  } finally {
    if (inFlightMutations.get(id)?.promise === operation) {
      inFlightMutations.delete(id);
    }
  }
}

module.exports = {
  getMutationHeaders,
  runIdempotentMutation,
  checkIdempotentReplay,
  stableStringify,
};
