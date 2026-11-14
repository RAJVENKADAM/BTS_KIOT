"use strict";

const { getImportDetails } = require("../services/importLedger");
const { logSafeError } = require("../utils/safeErrorLog");

async function getImportOperation(req, res) {
  try {
    const operation = await getImportDetails(
      String(req.params.uploadId),
      String(req.user?.id || ""),
    );
    if (!operation) {
      return res.status(404).json({
        success: false,
        error: "Import operation not found.",
      });
    }

    return res.status(200).json({
      success: true,
      operation: {
        uploadId: operation._id,
        importType: operation.import_type,
        status: operation.status,
        totalRows: operation.total_rows,
        completedRows: operation.completed_rows,
        failedRows: operation.failed_rows,
        checkpoint: operation.checkpoint,
        createdAt: operation.createdAt,
        updatedAt: operation.updatedAt,
      },
      rows: operation.rows.map((row) => ({
        rowId: row._id,
        rowNumber: row.row_number,
        identity: row.normalized_identity,
        status: row.status,
        expectedVersion: row.expected_version,
        expectedAssignmentRevision: row.expected_assignment_revision,
        attempts: row.attempt_count,
        errorCategory: row.last_error_category,
        error: row.last_error,
        resultResourceId: row.result_resource_id,
        result: row.result,
        completedAt: row.completed_at,
      })),
    });
  } catch (error) {
    logSafeError("Get import operation failed", error, req.requestId);
    return res.status(500).json({
      success: false,
      error: "Could not load import operation.",
    });
  }
}

module.exports = { getImportOperation };
