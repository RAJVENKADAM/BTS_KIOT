const bcrypt = require('bcryptjs');
const { createHash, randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const ExcelUpload = require('../models/ExcelUpload');
const normalizeBusNumber = require('../utils/normalizeBusNumber');
const { runLimitedImportPasswordHash } = require('../utils/authProtection');
const { runGpsConfigurationMutation } = require('../services/gpsConfigurationBarrier');
const assignmentPropagation = require('../services/assignmentPropagation');
const userRevision = require('../services/userRevision');
const importLedger = require('../services/importLedger');
const { disconnectUserSockets } = require('../socket');

const IMPORT_PASSWORD_HASH_ROUNDS = 10;
const IMPORT_BATCH_SIZE = 100;

function logImportSummary(event, details) {
  try {
    console.log(JSON.stringify({ event, ...details }));
  } catch {
    // Logging must not alter import outcomes.
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeEmail(email) {
  return (email || '').toString().trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeRole(role) {
  const roles = ['student', 'primary_admin', 'superadmin'];
  const normalized = (role || '').toString().trim().toLowerCase();
  if (normalized === 'user') return 'student';
  return roles.includes(normalized) ? normalized : null;
}

function coerceYear(value) {
  if (value === null || value === undefined) return null;
  const stringValue = String(value).trim();
  if (!stringValue) return null;
  const match = stringValue.match(/(19|20)\d{2}/);
  if (match) return Number.parseInt(match[0], 10);
  const numberValue = Number(stringValue);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function valuesEqual(left, right) {
  return (left ?? null) === (right ?? null);
}

function normalizeBusAssignment(value) {
  return String(value ?? '').trim().toUpperCase();
}

function validateRow(row) {
  const name = (row?.name ?? '').toString().trim();
  const email = normalizeEmail(row?.email);
  const busno = (row?.busno ?? row?.bus_no ?? '').toString().trim();
  const role = normalizeRole(row?.role);
  const phone = (row?.mobile_no ?? row?.mobile ?? '').toString().trim();
  const dobYear = coerceYear(row?.date_of_year);

  if (!isNonEmptyString(name)) return { error: 'Invalid name' };
  if (!isNonEmptyString(email) || !isValidEmail(email)) {
    return { error: 'Invalid email' };
  }
  if (!role) return { error: 'Invalid role' };

  return {
    value: {
      name,
      email,
      bus_no: busno ? normalizeBusNumber(busno) : null,
      role,
      phone,
      dobYear,
    },
  };
}

function addRowFailure(summary, rowIndex, rowNumber, reason) {
  summary.failedRows += 1;
  summary.rowResults.push({
    index: rowIndex,
    ...(rowNumber ? { rowNumber } : {}),
    status: 'failed',
    reason,
  });
}

function getBulkWriteErrors(error) {
  const errors = error?.writeErrors || error?.result?.writeErrors;
  return Array.isArray(errors) ? errors : [];
}

function getErrorIndex(writeError) {
  if (Number.isInteger(writeError?.index)) return writeError.index;
  if (Number.isInteger(writeError?.err?.index)) return writeError.err.index;
  return null;
}

function getDefiniteWriteErrorIndexes(error, operationCount) {
  const writeErrors = getBulkWriteErrors(error);
  if (
    writeErrors.length === 0 ||
    (Array.isArray(error?.writeConcernErrors) && error.writeConcernErrors.length > 0) ||
    error?.writeConcernError
  ) {
    return null;
  }
  const indexes = new Set();
  for (const writeError of writeErrors) {
    const index = getErrorIndex(writeError);
    if (
      index === null ||
      index < 0 ||
      index >= operationCount ||
      indexes.has(index)
    ) {
      return null;
    }
    indexes.add(index);
  }
  return indexes;
}

async function persistBatch(rows, state) {
  state.chunkCount += 1;
  const { summary, userId, excelCustomName } = state;
  let excelUpload = state.excelUpload;
  if (!excelUpload) {
    const uploadId = new mongoose.Types.ObjectId(
      createHash('sha256')
        .update(state.ledgerUploadId)
        .digest('hex')
        .slice(0, 24),
    );
    try {
      excelUpload = await ExcelUpload.create({
        _id: uploadId,
        file_name: 'users.xlsx',
        custom_name: excelCustomName,
        uploaded_by: userId,
        is_active: true,
        import_status: 'processing',
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      excelUpload = await ExcelUpload.findById(uploadId);
      if (!excelUpload) throw error;
    }
    state.excelUpload = excelUpload;
    await importLedger.setBusinessUploadId(
      state.ledgerUploadId,
      excelUpload._id,
      state.currentSession,
    );
  }

  const existingUsers = await User.find({
    email: { $in: rows.map((row) => row.value.email) },
    is_active: { $in: [true, false] },
  })
    .select('_id email name role bus_no is_active deleted_by_user resourceVersion assignmentRevision')
    .lean();
  const existingByEmail = new Map(
    existingUsers.map((user) => [user.email.toLowerCase(), user]),
  );
  const operations = [];
  const operationRows = [];

  for (const row of rows) {
    const value = row.value;
    const existing = existingByEmail.get(value.email);
    if (!existing && row.expectedVersion !== null) {
      const conflict = new Error(
        'A user changed after this import was staged.',
      );
      conflict.code = 'IMPORT_RESOURCE_REVISION_CONFLICT';
      conflict.statusCode = 409;
      conflict.rowNumber = row.ledgerRowNumber;
      throw conflict;
    }
    const passwordDigits =
      value.phone.replace(/\D/g, '').substring(0, 4) || '0000';
    const passwordYear = value.dobYear ? String(value.dobYear) : '2000';
    const next = {
      name: value.name,
      email: value.email,
      role: value.role,
      bus_no: value.bus_no,
      is_active: true,
      temp_password: true,
      deleted_by_user: false,
      excel_upload_id: excelUpload._id,
      is_temporary: true,
    };

    if (existing) {
      if (
        row.expectedVersion === null ||
        (existing.resourceVersion ?? 0) !== row.expectedVersion
      ) {
        const conflict = new Error(
          'A user changed after this import was staged.',
        );
        conflict.code = 'IMPORT_RESOURCE_REVISION_CONFLICT';
        conflict.statusCode = 409;
        conflict.rowNumber = row.ledgerRowNumber;
        throw conflict;
      }
      const unchanged =
        valuesEqual(existing.name, next.name) &&
        valuesEqual(existing.role, next.role) &&
        valuesEqual(existing.bus_no, next.bus_no) &&
        existing.is_active === true;

      if (unchanged) {
        operations.push({
          updateOne: {
            filter: {
              email: value.email,
              ...userRevision.buildUserRevisionFilter({
                userId: existing._id,
                expectedResourceVersion: row.expectedVersion,
              }),
            },
            update: {
              $set: next,
              $inc: { resourceVersion: 1 },
            },
            upsert: false,
          },
        });
        operationRows.push({
          row,
          type: 'unchanged',
          existing,
          ledgerRowId: row.ledgerRowId,
        });
        continue;
      }
    }

    const passwordHash = await runLimitedImportPasswordHash(() =>
      bcrypt.hash(`${passwordDigits}${passwordYear}`, IMPORT_PASSWORD_HASH_ROUNDS),
    );
    operations.push(
      existing
        ? {
            updateOne: {
              filter: {
                email: value.email,
                ...userRevision.buildUserRevisionFilter({
                  userId: existing._id,
                  expectedResourceVersion: row.expectedVersion,
                  ...((
                    normalizeBusAssignment(existing.bus_no) !==
                      normalizeBusAssignment(value.bus_no) ||
                    existing.role !== value.role ||
                    existing.is_active !== true ||
                    Boolean(existing.deleted_by_user)
                  )
                    ? {
                        expectedAssignmentRevision:
                          row.expectedAssignmentRevision ?? 0,
                      }
                    : {}),
                }),
              },
              update: {
                $set: { ...next, password_hash: passwordHash },
                $inc: {
                  resourceVersion: 1,
                  ...(normalizeBusAssignment(existing.bus_no) !==
                    normalizeBusAssignment(value.bus_no) ||
                  existing.role !== value.role ||
                  existing.is_active !== true ||
                  Boolean(existing.deleted_by_user)
                    ? { assignmentRevision: 1 }
                    : {}),
                },
              },
              upsert: false,
            },
          }
        : {
            insertOne: {
              document: {
                _id: new mongoose.Types.ObjectId(),
                ...next,
                password_hash: passwordHash,
                resourceVersion: 0,
                assignmentRevision: 0,
              },
            },
          },
    );
    operationRows.push({
      row,
      type: existing ? 'update' : 'create',
      existing,
      newUserId: existing ? null : operations.at(-1).insertOne.document._id,
      ledgerRowId: row.ledgerRowId,
    });
  }

  const failedOperationIndexes = new Set();
  const completedOperationIndexes = new Set();
  let outcomeUnknownIndex = null;
  let transactionAborted = false;
  const persistOperations = async (indexes, session) => {
    const selectedOperations = indexes.map((index) => operations[index]);
    const result = await User.bulkWrite(selectedOperations, {
      ordered: false,
      ...(session ? { session } : {}),
    });
    const appliedCount =
      (result?.matchedCount ?? result?.modifiedCount ?? 0) +
      (result?.insertedCount || 0) +
      (result?.upsertedCount || 0);
    if (appliedCount !== selectedOperations.length) {
      const conflict = new Error(
        'A user changed after this import was staged.',
      );
      conflict.code = 'IMPORT_RESOURCE_REVISION_CONFLICT';
      conflict.statusCode = 409;
      throw conflict;
    }
    for (const index of indexes) {
      const item = operationRows[index];
      if (!item) continue;
      if (!item.existing) {
        await assignmentPropagation.recordAssignmentMutation({
          session,
          actorId: userId,
          action: 'spreadsheet-user-created',
          resourceId: item.newUserId,
          requestId: `${state.ledgerUploadId}:${item.row.rowNumber ?? item.row.index}`,
          recipients: [{
            user_id: item.newUserId,
            notification: item.row.value.bus_no
              ? {
                  type: 'bus_reassigned',
                  message: `Your bus assignment is ${item.row.value.bus_no}.`,
                  new_bus_no: item.row.value.bus_no,
                }
              : null,
          }],
          previousState: null,
          newState: {
            role: item.row.value.role,
            bus_no: item.row.value.bus_no ?? null,
            is_active: true,
            assignment_revision: 0,
          },
        });
        await importLedger.completeClaimedRow({
          uploadId: state.ledgerUploadId,
          rowId: item.ledgerRowId,
          owner: state.claimOwner,
          session,
          resultResourceId: item.newUserId,
          result: { type: item.type },
        });
        continue;
      }
      const previousBusNo = normalizeBusAssignment(item.existing.bus_no);
      const nextBusNo = normalizeBusAssignment(item.row.value.bus_no);
      const routingChanged =
        previousBusNo !== nextBusNo ||
        item.existing.role !== item.row.value.role ||
        item.existing.is_active !== true ||
        Boolean(item.existing.deleted_by_user);
      if (!routingChanged) {
        await importLedger.completeClaimedRow({
          uploadId: state.ledgerUploadId,
          rowId: item.ledgerRowId,
          owner: state.claimOwner,
          session,
          resultResourceId: item.existing._id,
          result: { type: item.type },
        });
        continue;
      }
      const userIdValue = String(item.existing._id);
      const assignmentChanged = previousBusNo !== nextBusNo;
      await assignmentPropagation.recordAssignmentMutation({
        session,
        actorId: userId,
        action: assignmentChanged
          ? 'spreadsheet-assignment-updated'
          : 'spreadsheet-account-routing-updated',
        resourceId: userIdValue,
        requestId: `${excelUpload._id}:${item.row.rowNumber ?? item.row.index}`,
        recipients: [{
          user_id: userIdValue,
          notification: assignmentChanged
            ? {
                type: item.row.value.bus_no ? 'bus_reassigned' : 'bus_unassigned',
                message: item.row.value.bus_no
                  ? `Your bus assignment changed to Bus ${item.row.value.bus_no}.`
                  : 'Your bus assignment was removed.',
                new_bus_no: item.row.value.bus_no || null,
              }
            : null,
        }],
        previousState: {
          role: item.existing.role,
          bus_no: item.existing.bus_no ?? null,
          is_active: item.existing.is_active !== false,
          assignment_revision: item.existing.assignmentRevision ?? 0,
        },
        newState: {
          role: item.row.value.role,
          bus_no: item.row.value.bus_no ?? null,
          is_active: true,
          assignment_revision:
            (item.existing.assignmentRevision ?? 0) +
            (assignmentChanged ||
            item.existing.role !== item.row.value.role ||
            item.existing.is_active !== true ||
            Boolean(item.existing.deleted_by_user)
              ? 1
              : 0),
        },
      });
      await importLedger.completeClaimedRow({
        uploadId: state.ledgerUploadId,
        rowId: item.ledgerRowId,
        owner: state.claimOwner,
        session,
        resultResourceId: item.existing._id,
        result: { type: item.type },
      });
    }
    return result;
  };
  const persistBulkWrite = (session) =>
    persistOperations(
      operations.map((_, index) => index),
      session,
    );
  if (process.env.SOCKET_IO_MODE === 'redis') {
    for (let index = 0; index < operations.length; index += 1) {
      try {
        await runGpsConfigurationMutation((session) =>
          persistOperations([index], session),
        );
        completedOperationIndexes.add(index);
      } catch (error) {
        if (error?.statusCode === 409) {
          failedOperationIndexes.add(index);
          await importLedger.failClaimedRow({
            uploadId: state.ledgerUploadId,
            claimedRowId: operationRows[index].ledgerRowId,
            owner: state.claimOwner,
            category: "revision_conflict",
            message: "The user changed after this import was staged.",
            conflict: true,
          });
          continue;
        }
        const definiteErrors = getDefiniteWriteErrorIndexes(error, 1);
        if (
          error?.gpsLeaseError ||
          error?.gpsConfigurationError ||
          !definiteErrors ||
          !definiteErrors.has(0)
        ) {
          summary.outcomeUnknown = true;
          outcomeUnknownIndex = index;
          break;
        }
        failedOperationIndexes.add(index);
      }
    }
  } else {
    try {
      await runGpsConfigurationMutation(persistBulkWrite);
      for (let index = 0; index < operations.length; index += 1) {
        completedOperationIndexes.add(index);
      }
    } catch (error) {
      const failedIndexes =
        error?.gpsLeaseError || error?.gpsConfigurationError
          ? null
          : getDefiniteWriteErrorIndexes(error, operations.length);
      if (!failedIndexes) {
        summary.outcomeUnknown = true;
        outcomeUnknownIndex = 0;
      } else {
        transactionAborted = true;
        for (const index of failedIndexes) failedOperationIndexes.add(index);
      }
    }
  }

  for (let index = 0; index < operationRows.length; index += 1) {
    const item = operationRows[index];
    if (failedOperationIndexes.has(index)) {
      await importLedger.failClaimedRow({
        uploadId: state.ledgerUploadId,
        claimedRowId: item.ledgerRowId,
        owner: state.claimOwner,
        category: "database_write",
        message: "The user row could not be committed and may be retried.",
        retryable: true,
      });
      addRowFailure(
        summary,
        item.row.index,
        item.row.rowNumber,
        'Database rejected this row',
      );
      continue;
    }
    if (outcomeUnknownIndex !== null && index >= outcomeUnknownIndex) {
      await importLedger.failClaimedRow({
        uploadId: state.ledgerUploadId,
        claimedRowId: item.ledgerRowId,
        owner: state.claimOwner,
        category: "database_outcome_uncertain",
        message: "The database outcome is being reconciled; retry the same import key and content.",
        retryable: true,
      });
      addRowFailure(
        summary,
        item.row.index,
        item.row.rowNumber,
        process.env.SOCKET_IO_MODE !== 'redis'
          ? 'Database write outcome could not be confirmed'
          : index === outcomeUnknownIndex
          ? 'Database write outcome could not be confirmed'
          : 'Not processed after an earlier uncertain database write',
      );
      continue;
    }
    if (transactionAborted && !completedOperationIndexes.has(index)) {
      await importLedger.releaseClaimedRow(
        state.ledgerUploadId,
        item.ledgerRowId,
        state.claimOwner,
      );
      continue;
    }
    if (!completedOperationIndexes.has(index)) continue;

    if (item.type === 'create') {
      summary.insertedRows += 1;
    } else if (item.type === 'update') {
      summary.updatedRows += 1;
    } else {
      summary.unchangedRows += 1;
      summary.rowResults.push({
        index: item.row.index,
        ...(item.row.rowNumber ? { rowNumber: item.row.rowNumber } : {}),
        status: 'unchanged',
      });
    }

    if (!item.existing) continue;
    const userIdValue = String(item.existing._id);
    if (
      item.existing.role !== item.row.value.role ||
      item.existing.is_active !== true ||
      item.existing.deleted_by_user
    ) {
      try {
        disconnectUserSockets(userIdValue);
      } catch {
        console.error('Unable to revoke a committed user session.');
      }
    }
  }

  return { stopped: outcomeUnknownIndex !== null || transactionAborted };
}

async function recordBatchFailure(rows, state, error, summary) {
  const conflictRows = new Set();
  if (error?.statusCode === 409) {
    if (Number.isSafeInteger(error.rowNumber)) {
      const index = rows.findIndex(
        (row) => row.ledgerRowNumber === error.rowNumber,
      );
      if (index >= 0) conflictRows.add(index);
    } else {
      const currentUsers = await User.find({
        email: { $in: rows.map((row) => row.value.email) },
      })
        .select("email resourceVersion")
        .lean();
      const currentByEmail = new Map(
        currentUsers.map((user) => [
          String(user.email).toLowerCase(),
          user.resourceVersion ?? 0,
        ]),
      );
      for (const [index, row] of rows.entries()) {
        const currentVersion = currentByEmail.get(row.value.email);
        if (
          (row.expectedVersion === null && currentVersion !== undefined) ||
          (row.expectedVersion !== null &&
            currentVersion !== row.expectedVersion)
        ) {
          conflictRows.add(index);
        }
      }
    }
  }

  for (const [index, row] of rows.entries()) {
    if (conflictRows.has(index)) {
      await importLedger.failClaimedRow({
        uploadId: state.ledgerUploadId,
        claimedRowId: row.ledgerRowId,
        owner: state.claimOwner,
        category: "revision_conflict",
        message: "The user changed after this import was staged.",
        conflict: true,
      });
      addRowFailure(
        summary,
        row.index,
        row.rowNumber,
        "The user changed after this import was staged.",
      );
    } else if (error?.statusCode === 409) {
      await importLedger.releaseClaimedRow(
        state.ledgerUploadId,
        row.ledgerRowId,
        state.claimOwner,
      );
    } else {
      await importLedger.failClaimedRow({
        uploadId: state.ledgerUploadId,
        claimedRowId: row.ledgerRowId,
        owner: state.claimOwner,
        category: "processing",
        message: "The row was not committed and can be retried with the same import key and content.",
        retryable: true,
      });
      addRowFailure(
        summary,
        row.index,
        row.rowNumber,
        "Database operation failed",
      );
    }
  }
}

async function importUsers(req, res) {
  const startedAt = Date.now();
  req.setTimeout?.(0);
  res.setTimeout?.(0);
  const summary = {
    totalRows: 0,
    validRows: 0,
    insertedRows: 0,
    updatedRows: 0,
    unchangedRows: 0,
    duplicateRows: 0,
    failedRows: 0,
    completed: false,
    partial: false,
    outcomeUnknown: false,
    assignmentSyncFailures: 0,
    rowResults: [],
  };
  const userId = req.user?.id;
  const payload = req.body || {};
  const users = payload.users;

  if (!userId) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  if (
    !users ||
    (typeof users[Symbol.iterator] !== 'function') ||
    typeof users === 'string'
  ) {
    return res.status(400).json({
      success: false,
      summary,
      error: 'Missing users array',
    });
  }

  let inputRows;
  try {
    inputRows = Array.from(users);
  } catch {
    return res.status(400).json({
      success: false,
      summary,
      error: 'Could not read the user import rows.',
    });
  }
  const idempotencyKey =
    req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'];
  const seenStagedEmails = new Set();
  const normalizedRows = inputRows.map((row, index) => {
    const rowNumber = index + 1;
    const validated = validateRow(row);
    if (!validated.value) {
      return {
        rowNumber,
        sourceRowNumber: Number.isSafeInteger(row?._sourceRowNumber)
          ? row._sourceRowNumber
          : null,
        identity: `invalid-row-${rowNumber}`,
        input: null,
        initialStatus: 'failed',
        errorCategory: 'validation',
        error: validated.error,
        expectedVersionCaptured: true,
        expectedVersion: null,
      };
    }
    if (seenStagedEmails.has(validated.value.email)) {
      return {
        rowNumber,
        sourceRowNumber: Number.isSafeInteger(row?._sourceRowNumber)
          ? row._sourceRowNumber
          : null,
        identity: validated.value.email,
        input: validated.value,
        initialStatus: 'failed',
        errorCategory: 'duplicate',
        error: 'Duplicate email in this import',
        expectedVersionCaptured: true,
        expectedVersion: null,
      };
    }
    seenStagedEmails.add(validated.value.email);
    return {
      rowNumber,
      sourceRowNumber: Number.isSafeInteger(row?._sourceRowNumber)
        ? row._sourceRowNumber
        : null,
      identity: validated.value.email,
      input: validated.value,
      expectedVersionCaptured: false,
      expectedVersion: null,
    };
  });

  const importType = String(req.path || req.originalUrl || '').includes(
    'import-users-excel',
  )
    ? 'excel-users'
    : 'users';
  let staged;
  try {
    const emails = normalizedRows
      .filter((row) => row.initialStatus !== 'failed')
      .map((row) => row.input.email);
    const existingUsers = emails.length
      ? await User.find({
          email: { $in: [...new Set(emails)] },
          is_active: { $in: [true, false] },
        })
          .select('_id email resourceVersion assignmentRevision')
          .lean()
      : [];
    const versionsByEmail = new Map(
      existingUsers.map((user) => [
        String(user.email).toLowerCase(),
        {
          resourceVersion: user.resourceVersion ?? 0,
          assignmentRevision: user.assignmentRevision ?? 0,
        },
      ]),
    );
    for (const row of normalizedRows) {
      if (row.initialStatus === 'failed') continue;
      const version = versionsByEmail.get(row.identity);
      row.expectedVersion = version?.resourceVersion ?? null;
      row.expectedVersionCaptured = true;
      row.expectedAssignmentRevision =
        version?.assignmentRevision ?? null;
    }
    staged = await importLedger.createOrResumeImport({
      actorId: userId,
      importType,
      idempotencyKey,
      content: {
        excelCustomName: payload.excelCustomName ?? null,
        rows: inputRows,
      },
      rows: normalizedRows,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode
        ? error.message
        : 'Could not initialize the import. Please retry with the same key and content.',
      ...(error.code ? { code: error.code } : {}),
    });
  }

  if (staged.operation?.status === 'completed' && staged.operation.result) {
    return res.status(200).json({
      ...staged.operation.result,
      uploadId: staged.uploadId,
      duplicate: true,
    });
  }
  if (staged.staging) {
    return res.status(202).json({
      success: true,
      status: 'processing',
      uploadId: staged.uploadId,
      summary,
    });
  }
  const claimOwner = randomUUID();
  const claimsByRowNumber = new Map();
  try {
    while (true) {
      const claimed = await importLedger.claimNextRow(
        staged.uploadId,
        claimOwner,
      );
      if (!claimed) break;
      claimsByRowNumber.set(claimed.row_number, claimed);
    }
  } catch {
    return res.status(503).json({
      success: false,
      uploadId: staged.uploadId,
      error: 'Could not claim import rows. Retry with the same key and content.',
    });
  }

  const existingUpload = staged.operation?.business_upload_id
    ? await ExcelUpload.findById(staged.operation.business_upload_id)
    : null;
  const state = {
    summary,
    userId,
    excelCustomName: payload.excelCustomName ?? null,
    excelUpload: existingUpload,
    chunkCount: 0,
    ledgerUploadId: staged.uploadId,
    claimOwner,
  };
  const seenEmails = new Set();
  let batch = [];
  let stopped = false;
  let parserError = false;

  try {
    for (const [sourceIndex, row] of inputRows.entries()) {
      const index = summary.totalRows;
      summary.totalRows += 1;
      const rowNumber = Number.isInteger(row?._sourceRowNumber)
        ? row._sourceRowNumber
        : null;
      const validated = validateRow(row);
      if (!validated.value) {
        addRowFailure(summary, index, rowNumber, validated.error);
        continue;
      }
      if (seenEmails.has(validated.value.email)) {
        summary.duplicateRows += 1;
        addRowFailure(summary, index, rowNumber, 'Duplicate email in this import');
        continue;
      }
      seenEmails.add(validated.value.email);
      summary.validRows += 1;

      const ledgerRowNumber = sourceIndex + 1;
      const claim = claimsByRowNumber.get(ledgerRowNumber);
      if (!claim) continue;

      if (stopped) {
        await importLedger.releaseClaimedRow(
          staged.uploadId,
          claim._id,
          claimOwner,
        );
        addRowFailure(
          summary,
          index,
          rowNumber,
          'Not processed because an earlier database operation failed',
        );
        continue;
      }

      batch.push({
        index,
        rowNumber,
        value: validated.value,
        ledgerRowId: claim._id,
        ledgerRowNumber,
        expectedVersion: claim.expected_version,
        expectedAssignmentRevision: claim.expected_assignment_revision,
      });
      if (batch.length < IMPORT_BATCH_SIZE) continue;

      try {
        const outcome = await persistBatch(batch, state);
        stopped = outcome.stopped;
      } catch (error) {
        await recordBatchFailure(batch, state, error, summary);
        stopped = true;
      }
      batch = [];
    }

    if (!stopped && batch.length) {
      try {
        const outcome = await persistBatch(batch, state);
        stopped = outcome.stopped;
      } catch (error) {
        await recordBatchFailure(batch, state, error, summary);
        stopped = true;
      }
    } else if (stopped && batch.length) {
      for (const pending of batch) {
        await importLedger.releaseClaimedRow(
          staged.uploadId,
          pending.ledgerRowId,
          claimOwner,
        );
        addRowFailure(
          summary,
          pending.index,
          pending.rowNumber,
          'Not processed because an earlier database operation failed',
        );
      }
      batch = [];
    }
  } catch {
    parserError = true;
    summary.failedRows += 1;
    summary.rowResults.push({
      index: summary.totalRows,
      status: 'failed',
      reason: 'Workbook parsing failed',
    });
  }

  const finalized = await importLedger.finalizeImport(staged.uploadId);
  const ledgerRows = await importLedger.getImportRows(staged.uploadId);
  summary.totalRows = ledgerRows.length;
  summary.insertedRows = ledgerRows.filter(
    (row) => row.status === 'completed' && row.result?.type === 'create',
  ).length;
  summary.updatedRows = ledgerRows.filter(
    (row) => row.status === 'completed' && row.result?.type === 'update',
  ).length;
  summary.unchangedRows = ledgerRows.filter(
    (row) => row.status === 'completed' && row.result?.type === 'unchanged',
  ).length;
  summary.duplicateRows = ledgerRows.filter(
    (row) => row.last_error_category === 'duplicate',
  ).length;
  summary.failedRows = ledgerRows.filter(
    (row) => row.status === 'failed' || row.status === 'conflict',
  ).length;
  const permanentlyInvalid = ledgerRows.filter(
    (row) =>
      row.last_error_category === 'validation' ||
      row.last_error_category === 'duplicate',
  ).length;
  summary.validRows = Math.max(0, summary.totalRows - permanentlyInvalid);
  summary.rowResults = ledgerRows
    .filter((row) => row.status === 'failed' || row.status === 'conflict')
    .map((row) => ({
      index: row.row_number - 1,
      rowNumber: row.source_row_number ?? row.row_number + 1,
      status: row.status === 'conflict' ? 'conflict' : 'failed',
      reason: row.last_error || 'Import row failed.',
    }));
  summary.completed = finalized?.status === 'completed';
  const committedRows =
    summary.insertedRows + summary.updatedRows + summary.unchangedRows;
  summary.outcomeUnknown = ledgerRows.some(
    (row) => row.last_error_category === 'database_outcome_uncertain',
  );
  summary.partial =
    finalized?.status === 'partial' ||
    summary.outcomeUnknown ||
    (committedRows > 0 &&
      (summary.failedRows > 0 || !summary.completed || summary.assignmentSyncFailures > 0));
  if (state.excelUpload) {
    try {
      await ExcelUpload.updateOne(
        { _id: state.excelUpload._id },
        {
          $set: {
            import_status: summary.outcomeUnknown
              ? 'partial'
              : committedRows === 0
                ? 'failed'
              : summary.partial || !summary.completed
                ? 'partial'
                : 'completed',
            import_summary: {
              totalRows: summary.totalRows,
              validRows: summary.validRows,
              insertedRows: summary.insertedRows,
              updatedRows: summary.updatedRows,
              unchangedRows: summary.unchangedRows,
              duplicateRows: summary.duplicateRows,
              failedRows: summary.failedRows,
              completed: summary.completed,
              partial: summary.partial,
              outcomeUnknown: summary.outcomeUnknown,
              assignmentSyncFailures: summary.assignmentSyncFailures,
            },
          },
        },
      );
    } catch {
      console.error('Unable to finalize user import status.');
      if (committedRows > 0) {
        summary.completed = false;
        summary.partial = true;
      }
    }

  }

  logImportSummary('USER_IMPORT_FINISHED', {
    requestId: req.requestId || null,
    durationMs: Date.now() - startedAt,
    chunks: state.chunkCount,
    totalRows: summary.totalRows,
    validRows: summary.validRows,
    insertedRows: summary.insertedRows,
    updatedRows: summary.updatedRows,
    unchangedRows: summary.unchangedRows,
    duplicateRows: summary.duplicateRows,
    failedRows: summary.failedRows,
    completed: summary.completed,
    partial: summary.partial,
    outcomeUnknown: summary.outcomeUnknown,
  });

  if (summary.validRows === 0) {
    const response = {
      success: false,
      summary: { ...summary, completed: finalized?.status === 'completed' },
      uploadId: staged.uploadId,
      error: summary.totalRows
        ? 'All rows failed validation'
        : 'No user rows found. Add column headings followed by user data.',
    };
    await importLedger.finalizeImport(staged.uploadId, response);
    return res.status(400).json(response);
  }

  const hasCommittedRows =
    summary.insertedRows + summary.updatedRows + summary.unchangedRows > 0;
  const response = {
    success: hasCommittedRows || finalized?.status === 'processing',
    status: finalized?.status || 'processing',
    uploadId: staged.uploadId,
    summary,
    ...(summary.assignmentSyncFailures
      ? { message: 'Import saved, but some live assignment updates could not be confirmed.' }
      : summary.partial
        ? { message: 'Import completed partially.' }
        : {}),
  };
  await importLedger.finalizeImport(staged.uploadId, response);
  if (finalized?.status === 'processing') {
    return res.status(202).json(response);
  }
  if (!hasCommittedRows) {
    response.error = 'User import failed before any rows were saved.';
    return res.status(500).json(response);
  }
  return res.status(200).json(response);
}

module.exports = {
  importUsers,
  IMPORT_BATCH_SIZE,
};
