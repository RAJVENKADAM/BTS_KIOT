const bcrypt = require('bcryptjs');
const User = require('../models/User');
const ExcelUpload = require('../models/ExcelUpload');
const normalizeBusNumber = require('../utils/normalizeBusNumber');
const { runLimitedImportPasswordHash } = require('../utils/authProtection');
const { runGpsConfigurationMutation } = require('../services/gpsConfigurationBarrier');
const {
  disconnectUserSockets,
  emitBusAssignmentNotification,
} = require('../socket');

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
    excelUpload = await ExcelUpload.create({
      file_name: 'users.xlsx',
      custom_name: excelCustomName,
      uploaded_by: userId,
      is_active: true,
      import_status: 'processing',
    });
    state.excelUpload = excelUpload;
  }

  const existingUsers = await User.find({
    email: { $in: rows.map((row) => row.value.email) },
    is_active: { $in: [true, false] },
  })
    .select('_id email name role bus_no is_active deleted_by_user')
    .lean();
  const existingByEmail = new Map(
    existingUsers.map((user) => [user.email.toLowerCase(), user]),
  );
  const operations = [];
  const operationRows = [];

  for (const row of rows) {
    const value = row.value;
    const existing = existingByEmail.get(value.email);
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
      const unchanged =
        valuesEqual(existing.name, next.name) &&
        valuesEqual(existing.role, next.role) &&
        valuesEqual(existing.bus_no, next.bus_no) &&
        existing.is_active === true;

      if (unchanged) {
        operations.push({
          updateOne: {
            filter: { email: value.email },
            update: { $set: next },
            upsert: false,
          },
        });
        operationRows.push({
          row,
          type: 'unchanged',
          existing,
        });
        continue;
      }
    }

    const passwordHash = await runLimitedImportPasswordHash(() =>
      bcrypt.hash(`${passwordDigits}${passwordYear}`, IMPORT_PASSWORD_HASH_ROUNDS),
    );
    operations.push({
      updateOne: {
        filter: { email: value.email },
        update: {
          $set: { ...next, password_hash: passwordHash },
        },
        upsert: true,
      },
    });
    operationRows.push({
      row,
      type: existing ? 'update' : 'create',
      existing,
    });
  }

  const failedOperationIndexes = new Set();
  const completedOperationIndexes = new Set();
  let outcomeUnknownIndex = null;
  const persistBulkWrite = (session) =>
    User.bulkWrite(operations, {
      ordered: false,
      ...(session ? { session } : {}),
    });
  if (process.env.SOCKET_IO_MODE === 'redis') {
    for (let index = 0; index < operations.length; index += 1) {
      try {
        await runGpsConfigurationMutation((session) =>
          User.bulkWrite([operations[index]], {
            ordered: true,
            ...(session ? { session } : {}),
          }),
        );
        completedOperationIndexes.add(index);
      } catch (error) {
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
        for (const index of failedIndexes) failedOperationIndexes.add(index);
        for (let index = 0; index < operations.length; index += 1) {
          if (!failedOperationIndexes.has(index)) {
            completedOperationIndexes.add(index);
          }
        }
      }
    }
  }

  for (let index = 0; index < operationRows.length; index += 1) {
    const item = operationRows[index];
    if (failedOperationIndexes.has(index)) {
      addRowFailure(
        summary,
        item.row.index,
        item.row.rowNumber,
        'Database rejected this row',
      );
      continue;
    }
    if (outcomeUnknownIndex !== null && index >= outcomeUnknownIndex) {
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
      normalizeBusAssignment(item.existing.bus_no) !==
      normalizeBusAssignment(item.row.value.bus_no)
    ) {
      try {
        emitBusAssignmentNotification(userIdValue, item.row.value.bus_no);
      } catch {
        console.error('Unable to deliver a committed bus assignment notification.');
      }
    }
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

  return { stopped: outcomeUnknownIndex !== null };
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

  const state = {
    summary,
    userId,
    excelCustomName: payload.excelCustomName ?? null,
    excelUpload: null,
    chunkCount: 0,
  };
  const seenEmails = new Set();
  let batch = [];
  let stopped = false;
  let parserError = false;

  try {
    for (const row of users) {
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

      if (stopped) {
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
      });
      if (batch.length < IMPORT_BATCH_SIZE) continue;

      try {
        const outcome = await persistBatch(batch, state);
        stopped = outcome.stopped;
      } catch (error) {
        for (const pending of batch) {
          addRowFailure(
            summary,
            pending.index,
            pending.rowNumber,
            'Database operation failed',
          );
        }
        stopped = true;
      }
      batch = [];
    }

    if (!stopped && batch.length) {
      try {
        const outcome = await persistBatch(batch, state);
        stopped = outcome.stopped;
      } catch {
        for (const pending of batch) {
          addRowFailure(
            summary,
            pending.index,
            pending.rowNumber,
            'Database operation failed',
          );
        }
        stopped = true;
      }
    } else if (stopped && batch.length) {
      for (const pending of batch) {
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

  summary.completed = !stopped && !parserError;
  const committedRows =
    summary.insertedRows + summary.updatedRows + summary.unchangedRows;
  summary.partial =
    (committedRows > 0 && (summary.failedRows > 0 || !summary.completed)) ||
    summary.outcomeUnknown;
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

    if (committedRows === 0 && !summary.outcomeUnknown) {
      try {
        await ExcelUpload.deleteOne({ _id: state.excelUpload._id });
        state.excelUpload = null;
      } catch {
        console.error('Unable to remove an unused user import record.');
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
    return res.status(400).json({
      success: false,
      summary: { ...summary, completed: true },
      error: summary.totalRows
        ? 'All rows failed validation'
        : 'No user rows found. Add column headings followed by user data.',
    });
  }

  const hasCommittedRows =
    summary.insertedRows + summary.updatedRows + summary.unchangedRows > 0;
  const response = {
    success: hasCommittedRows,
    summary,
    ...(summary.partial ? { message: 'Import completed partially.' } : {}),
  };
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
