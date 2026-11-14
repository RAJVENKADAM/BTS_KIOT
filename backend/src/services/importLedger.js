"use strict";

const { createHash, randomUUID } = require("node:crypto");
const ImportOperation = require("../models/ImportOperation");
const ImportRow = require("../models/ImportRow");

const STAGING_LEASE_MS = 60_000;
const ROW_CLAIM_LEASE_MS = 60_000;

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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashImportContent(value) {
  return sha256(stableStringify(value));
}

function operationId(actorId, importType, idempotencyKey) {
  return `import:${sha256(
    `${String(actorId)}\u0000${importType}\u0000${idempotencyKey}`,
  )}`;
}

function rowId(uploadId, rowNumber) {
  return `${uploadId}:${rowNumber}`;
}

function ledgerError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

async function findOperation(uploadId) {
  return ImportOperation.findById(uploadId).lean();
}

async function createOrResumeImport({
  actorId,
  importType,
  idempotencyKey,
  content,
  rows,
}) {
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim().length < 8 ||
    idempotencyKey.trim().length > 200
  ) {
    throw ledgerError(
      "Provide a valid Idempotency-Key header.",
      "IDEMPOTENCY_KEY_REQUIRED",
      400,
    );
  }
  if (!Array.isArray(rows) || !["users", "excel-users", "bus-routes"].includes(importType)) {
    throw ledgerError("The import input is invalid.", "IMPORT_INPUT_INVALID", 400);
  }

  const key = idempotencyKey.trim();
  const contentHash = hashImportContent(content);
  const uploadId = operationId(actorId, importType, key);
  const stagingOwner = randomUUID();
  const now = new Date();
  const stagingUntil = new Date(now.getTime() + STAGING_LEASE_MS);
  let operation;

  try {
    operation = await ImportOperation.findOneAndUpdate(
      { _id: uploadId },
      {
        $setOnInsert: {
          actor_id: actorId,
          import_type: importType,
          idempotency_key: key,
          content_hash: contentHash,
          status: "staging",
          staging_owner: stagingOwner,
          staging_lease_until: stagingUntil,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
  } catch (error) {
    if (error?.code !== 11000) throw error;
    operation = await findOperation(uploadId);
  }

  if (!operation) {
    throw ledgerError("Could not initialize the import.", "IMPORT_INIT_FAILED", 503);
  }
  if (
    operation.actor_id.toString() !== String(actorId) ||
    operation.import_type !== importType ||
    operation.content_hash !== contentHash
  ) {
    throw ledgerError(
      "This Idempotency-Key was already used for different import content.",
      "IMPORT_CONTENT_CONFLICT",
      409,
    );
  }

  let ownsStaging = operation.status === "staging" &&
    operation.staging_owner === stagingOwner;
  if (operation.status === "staging" && !ownsStaging) {
    const takeover = await ImportOperation.findOneAndUpdate(
      {
        _id: uploadId,
        status: "staging",
        staging_lease_until: { $lte: now },
      },
      {
        $set: {
          staging_owner: stagingOwner,
          staging_lease_until: stagingUntil,
        },
      },
      { new: true },
    ).lean();
    operation = takeover || operation;
    ownsStaging = Boolean(takeover);
  }

  if (ownsStaging) {
    if (rows.length) {
      await ImportRow.bulkWrite(
        rows.map((row, index) => {
          const number = Number.isSafeInteger(row.rowNumber)
            ? row.rowNumber
            : index + 1;
          return {
            updateOne: {
              filter: { _id: rowId(uploadId, number) },
              update: {
                $setOnInsert: {
                  operation_id: uploadId,
                  row_number: number,
                  source_row_number: Number.isSafeInteger(row.sourceRowNumber)
                    ? row.sourceRowNumber
                    : null,
                  normalized_identity: String(row.identity ?? `row-${number}`),
                  input: row.initialStatus === "failed" ? null : row.input,
                  expected_version: Number.isSafeInteger(row.expectedVersion)
                    ? row.expectedVersion
                    : null,
                  expected_version_captured: Boolean(
                    row.expectedVersionCaptured,
                  ),
                  expected_assignment_revision:
                    Number.isSafeInteger(row.expectedAssignmentRevision)
                      ? row.expectedAssignmentRevision
                      : null,
                  status: row.initialStatus || "pending",
                  ...(row.initialStatus === "failed"
                    ? {
                        retryable: false,
                        last_error_category: row.errorCategory || "validation",
                        last_error: row.error || "Row validation failed.",
                      }
                    : {}),
                },
              },
              upsert: true,
            },
          };
        }),
        { ordered: true },
      );
    }

    const stagedCount = await ImportRow.countDocuments({ operation_id: uploadId });
    if (stagedCount !== rows.length) {
      throw ledgerError(
        "Import rows could not be durably staged.",
        "IMPORT_STAGING_INCOMPLETE",
        503,
      );
    }
    operation = await ImportOperation.findOneAndUpdate(
      { _id: uploadId, status: "staging", staging_owner: stagingOwner },
      {
        $set: {
          status: "processing",
          total_rows: rows.length,
          staging_owner: null,
          staging_lease_until: null,
        },
      },
      { new: true },
    ).lean();
  }

  return {
    operation: operation || await findOperation(uploadId),
    uploadId,
    contentHash,
    staging: !ownsStaging && operation?.status === "staging",
  };
}

async function claimNextRow(uploadId, owner, { retryFailed = true } = {}) {
  const now = new Date();
  const claimUntil = new Date(now.getTime() + ROW_CLAIM_LEASE_MS);
  const eligible = [
    { status: "pending" },
    { status: "processing", claim_until: { $lte: now } },
    ...(retryFailed ? [{ status: "failed", retryable: true }] : []),
  ];
  return ImportRow.findOneAndUpdate(
    { operation_id: uploadId, $or: eligible },
    {
      $set: { status: "processing", claim_owner: owner, claim_until: claimUntil },
      $inc: { attempt_count: 1 },
    },
    { sort: { row_number: 1 }, new: true },
  ).lean();
}

async function completeClaimedRow({
  uploadId,
  rowId: claimedRowId,
  owner,
  session,
  resultResourceId = null,
  result = null,
}) {
  const row = await ImportRow.updateOne(
    {
      _id: claimedRowId,
      operation_id: uploadId,
      status: "processing",
      claim_owner: owner,
    },
    {
      $set: {
        status: "completed",
        input: null,
        result_resource_id: resultResourceId == null ? null : String(resultResourceId),
        result,
        completed_at: new Date(),
        claim_owner: null,
        claim_until: null,
        retryable: false,
        last_error_category: null,
        last_error: null,
      },
    },
    session ? { session } : {},
  );
  if (row.matchedCount !== 1) {
    throw ledgerError(
      "Import row claim was lost before completion.",
      "IMPORT_ROW_CLAIM_LOST",
      409,
    );
  }
  const operation = await ImportOperation.updateOne(
    { _id: uploadId },
    { $inc: { completed_rows: 1 } },
    session ? { session } : {},
  );
  if (operation.matchedCount !== 1) {
    throw new Error("Import operation disappeared while completing a row.");
  }
}

async function failClaimedRow({
  uploadId,
  claimedRowId,
  owner,
  category,
  message,
  conflict = false,
  retryable = false,
}) {
  const status = conflict ? "conflict" : "failed";
  const row = await ImportRow.updateOne(
    {
      _id: claimedRowId,
      operation_id: uploadId,
      status: "processing",
      claim_owner: owner,
    },
    {
      $set: {
        status,
        ...(conflict ? { input: null } : {}),
        last_error_category: category || "processing",
        last_error: message || "Import row could not be processed.",
        retryable: Boolean(retryable),
        claim_owner: null,
        claim_until: null,
      },
    },
  );
  if (row.matchedCount === 1) {
    await ImportOperation.updateOne(
      { _id: uploadId },
      { $inc: { failed_rows: 1 } },
    );
  }
}

async function releaseClaimedRow(uploadId, claimedRowId, owner) {
  await ImportRow.updateOne(
    {
      _id: claimedRowId,
      operation_id: uploadId,
      status: "processing",
      claim_owner: owner,
    },
    {
      $set: {
        status: "pending",
        claim_owner: null,
        claim_until: null,
      },
    },
  );
}

async function markUnclaimedRowFailed({
  uploadId,
  rowNumber,
  category,
  message,
}) {
  const row = await ImportRow.updateOne(
    { _id: rowId(uploadId, rowNumber), status: "pending" },
    {
      $set: {
        status: "failed",
        last_error_category: category || "validation",
        last_error: message || "Import row failed validation.",
        retryable: false,
      },
    },
  );
  if (row.matchedCount === 1) {
    await ImportOperation.updateOne(
      { _id: uploadId },
      { $inc: { failed_rows: 1 } },
    );
  }
}

async function setExpectedVersion(uploadId, claimedRowId, owner, expectedVersion) {
  const result = await ImportRow.updateOne(
    {
      _id: claimedRowId,
      operation_id: uploadId,
      status: "processing",
      claim_owner: owner,
      expected_version_captured: { $ne: true },
    },
    {
      $set: {
        expected_version: expectedVersion,
        expected_version_captured: true,
      },
    },
  );
  if (result.matchedCount === 1) return expectedVersion;
  const row = await ImportRow.findOne({
    _id: claimedRowId,
    operation_id: uploadId,
    status: "processing",
    claim_owner: owner,
  }).select("expected_version expected_version_captured").lean();
  return row?.expected_version ?? null;
}

async function getImportRows(uploadId) {
  return ImportRow.find({ operation_id: uploadId })
    .sort({ row_number: 1 })
    .lean();
}

async function setBusinessUploadId(uploadId, businessUploadId, session) {
  const result = await ImportOperation.updateOne(
    { _id: uploadId, business_upload_id: null },
    { $set: { business_upload_id: businessUploadId } },
    session ? { session } : {},
  );
  if (result.matchedCount === 1) return;
  let query = ImportOperation.findById(uploadId).select("business_upload_id");
  if (session) query = query.session(session);
  const operation = await query.lean();
  if (String(operation?.business_upload_id || "") !== String(businessUploadId)) {
    throw new Error("Import upload record changed while processing.");
  }
}

async function finalizeImport(uploadId, result = null) {
  const [total, completed, failed, unfinished] = await Promise.all([
    ImportRow.countDocuments({ operation_id: uploadId }),
    ImportRow.countDocuments({ operation_id: uploadId, status: "completed" }),
    ImportRow.countDocuments({
      operation_id: uploadId,
      status: { $in: ["failed", "conflict"] },
    }),
    ImportRow.countDocuments({
      operation_id: uploadId,
      status: { $in: ["pending", "processing"] },
    }),
  ]);
  const rows = await ImportRow.find({ operation_id: uploadId })
    .select("row_number status")
    .sort({ row_number: 1 })
    .lean();
  let checkpoint = 0;
  for (const row of rows) {
    if (row.status !== "completed") break;
    checkpoint = row.row_number;
  }
  let finalResult = result;
  if (!finalResult && total === completed && total === 1) {
    const operation = await ImportOperation.findById(uploadId)
      .select("import_type")
      .lean();
    if (operation?.import_type === "bus-routes") {
      const completedRow = await ImportRow.findOne({
        operation_id: uploadId,
        status: "completed",
      })
        .select("result")
        .lean();
      finalResult = completedRow?.result || null;
    }
  }
  const status = unfinished
    ? "processing"
    : failed
      ? "partial"
      : "completed";
  return ImportOperation.findOneAndUpdate(
    { _id: uploadId },
    {
      $set: {
        status,
        total_rows: total,
        completed_rows: completed,
        failed_rows: failed,
        checkpoint,
        ...(finalResult ? { result: finalResult } : {}),
      },
    },
    { new: true },
  ).lean();
}

async function getImportDetails(uploadId, actorId) {
  const operation = await ImportOperation.findOne({
    _id: uploadId,
    actor_id: actorId,
  }).lean();
  if (!operation) return null;
  const rows = await ImportRow.find({ operation_id: uploadId })
    .select("-input")
    .sort({ row_number: 1 })
    .lean();
  return { ...operation, rows };
}

module.exports = {
  createOrResumeImport,
  claimNextRow,
  completeClaimedRow,
  failClaimedRow,
  releaseClaimedRow,
  markUnclaimedRowFailed,
  setExpectedVersion,
  finalizeImport,
  getImportDetails,
  getImportRows,
  getImportRowId: rowId,
  setBusinessUploadId,
  hashImportContent,
  stableStringify,
};
