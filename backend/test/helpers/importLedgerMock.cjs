"use strict";

const ledger = require("../../src/services/importLedger");

function mockImportLedger() {
  const names = [
    "createOrResumeImport",
    "claimNextRow",
    "completeClaimedRow",
    "failClaimedRow",
    "releaseClaimedRow",
    "finalizeImport",
    "getImportRows",
    "setBusinessUploadId",
  ];
  const originals = Object.fromEntries(names.map((name) => [name, ledger[name]]));
  originals.hashImportContent = ledger.hashImportContent;
  const operations = new Map();

  ledger.createOrResumeImport = async ({
    actorId,
    importType,
    idempotencyKey,
    content,
    rows,
  }) => {
    const uploadId = `mock:${String(actorId)}:${importType}:${idempotencyKey}`;
    const contentHash = originals.hashImportContent(content);
    let operation = operations.get(uploadId);
    if (operation && operation.contentHash !== contentHash) {
      const error = new Error(
        "This Idempotency-Key was already used for different import content.",
      );
      error.code = "IMPORT_CONTENT_CONFLICT";
      error.statusCode = 409;
      throw error;
    }
    if (!operation) {
      operation = {
        uploadId,
        contentHash,
        importType,
        status: "processing",
        result: null,
        rows: rows.map((row, index) => ({
          _id: `${uploadId}:${index + 1}`,
          operation_id: uploadId,
          row_number: row.rowNumber,
          source_row_number: row.sourceRowNumber ?? null,
          normalized_identity: row.identity,
          input: row.input,
          expected_version: row.expectedVersion ?? null,
          expected_assignment_revision:
            row.expectedAssignmentRevision ?? null,
          status: row.initialStatus || "pending",
          retryable: false,
          attempt_count: 0,
          last_error_category: row.errorCategory || null,
          last_error: row.error || null,
        })),
      };
      operations.set(uploadId, operation);
    }
    return {
      operation,
      uploadId,
      staging: false,
    };
  };

  ledger.claimNextRow = async (uploadId, owner) => {
    const row = operations.get(uploadId)?.rows.find(
      (item) =>
        item.status === "pending" ||
        (item.status === "failed" && item.retryable),
    );
    if (!row) return null;
    row.status = "processing";
    row.claim_owner = owner;
    row.attempt_count += 1;
    return { ...row };
  };

  ledger.completeClaimedRow = async ({
    uploadId,
    rowId,
    owner,
    resultResourceId,
    result,
  }) => {
    const row = operations.get(uploadId)?.rows.find((item) => item._id === rowId);
    if (!row || row.status !== "processing" || row.claim_owner !== owner) {
      throw new Error("Mock import row claim was lost.");
    }
    row.status = "completed";
    row.input = null;
    row.result_resource_id = resultResourceId;
    row.result = result;
    row.claim_owner = null;
    row.completed_at = new Date();
  };

  ledger.failClaimedRow = async ({
    uploadId,
    claimedRowId,
    owner,
    category,
    message,
    conflict,
    retryable,
  }) => {
    const row = operations.get(uploadId)?.rows.find(
      (item) => item._id === claimedRowId,
    );
    if (!row || row.claim_owner !== owner) return;
    row.status = conflict ? "conflict" : "failed";
    row.input = conflict ? null : row.input;
    row.last_error_category = category || "processing";
    row.last_error = message || "Import row failed.";
    row.retryable = Boolean(retryable);
    row.claim_owner = null;
  };

  ledger.releaseClaimedRow = async (uploadId, rowId, owner) => {
    const row = operations.get(uploadId)?.rows.find((item) => item._id === rowId);
    if (!row || row.claim_owner !== owner) return;
    row.status = "pending";
    row.claim_owner = null;
  };

  ledger.finalizeImport = async (uploadId, result) => {
    const operation = operations.get(uploadId);
    if (!operation) return null;
    if (result) operation.result = result;
    const unfinished = operation.rows.some((row) =>
      ["pending", "processing"].includes(row.status),
    );
    const failed = operation.rows.some((row) =>
      ["failed", "conflict"].includes(row.status),
    );
    operation.status = unfinished
      ? "processing"
      : failed
        ? "partial"
        : "completed";
    if (
      !operation.result &&
      operation.importType === "bus-routes" &&
      operation.rows.length === 1
    ) {
      operation.result = operation.rows[0].result || null;
    }
    return { ...operation, rows: undefined };
  };

  ledger.getImportRows = async (uploadId) =>
    (operations.get(uploadId)?.rows || []).map((row) => ({ ...row }));
  ledger.setBusinessUploadId = async (uploadId, businessUploadId) => {
    const operation = operations.get(uploadId);
    if (operation) operation.business_upload_id = businessUploadId;
  };

  return {
    reset() {
      operations.clear();
    },
    restore() {
      for (const [name, fn] of Object.entries(originals)) {
        ledger[name] = fn;
      }
    },
  };
}

module.exports = { mockImportLedger };
