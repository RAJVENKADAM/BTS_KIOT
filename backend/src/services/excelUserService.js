const xlsx = require('xlsx');
const User = require('../models/User');
const normalizeBusNumber = require('../utils/normalizeBusNumber');
const { runLimitedImportPasswordHash } = require('../utils/authProtection');
const { runGpsConfigurationMutation } = require('./gpsConfigurationBarrier');
const { recordAssignmentMutation } = require('./assignmentPropagation');
const { sendEmail } = require('../services/emailService');
const {
  disconnectUserSockets,
} = require('../socket');

const IMPORT_BATCH_SIZE = 100;
const REQUIRED_COLUMNS = [
  'name',
  'email',
  'busno',
  'role',
  'mobile_no',
  'date_of_year',
];

function createValidationError(summary) {
  const error = new Error('Some workbook rows failed validation.');
  error.statusCode = 400;
  error.summary = summary;
  return error;
}

function normalizeRoleValue(role) {
  const roles = ['student', 'primary_admin', 'superadmin'];
  const normalizedRole = (role || '').toLowerCase().trim();
  if (normalizedRole === 'user') return 'student';
  return roles.includes(normalizedRole) ? normalizedRole : 'student';
}

function isValidEmailValue(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '');
}

function normalizeWorkbookRow(row, rowNumber) {
  const email = row.email?.toString().toLowerCase().trim();
  const user = {
    name: row.name?.toString().trim(),
    email,
    bus_no: (row.busno ?? row.bus_no)?.toString().trim()
      ? normalizeBusNumber(row.busno ?? row.bus_no)
      : null,
    role: normalizeRoleValue(row.role?.toString().trim()),
    phone: (row.mobile_no ?? row.phone)?.toString().trim(),
    dob: (row.date_of_year ?? row.dob)?.toString().trim(),
    rowNumber,
  };

  if (!isValidEmailValue(user.email)) {
    return { error: 'Invalid email' };
  }
  if (!user.name || user.name.length < 2) {
    return { error: 'Invalid name' };
  }
  if (!user.role) return { error: 'Invalid role' };
  return { value: user };
}

function workbookRows(worksheet) {
  const reference = worksheet['!ref'];
  if (!reference) return function* emptyRows() {};
  const { s, e } = xlsx.utils.decode_range(reference);
  const header = [];
  for (let column = s.c; column <= e.c; column += 1) {
    const cell = worksheet[xlsx.utils.encode_cell({ r: s.r, c: column })];
    header.push(cell?.v == null ? '' : String(cell.v).trim());
  }

  const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length) {
    throw new Error('Workbook is missing required columns.');
  }

  return function* rows() {
    for (let rowIndex = s.r + 1; rowIndex <= e.r; rowIndex += 1) {
      const row = {};
      let hasValue = false;
      for (let column = s.c; column <= e.c; column += 1) {
        const cell = worksheet[xlsx.utils.encode_cell({ r: rowIndex, c: column })];
        const value = cell?.v ?? '';
        const name = header[column - s.c];
        if (name) row[name] = value;
        if (String(value).trim()) hasValue = true;
      }
      if (hasValue) {
        row._sourceRowNumber = rowIndex + 1;
        yield row;
      }
    }
  };
}

class ExcelUserService {
  async processExcelBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error('The Excel workbook is empty.');
    }
    try {
      const workbook = xlsx.read(buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) throw new Error('The Excel workbook has no worksheets.');
      const iterateRows = workbookRows(workbook.Sheets[sheetName]);
      return { [Symbol.iterator]: iterateRows };
    } catch (error) {
      throw new Error(`Error processing Excel: ${error.message}`);
    }
  }

  validateAndNormalizeData(jsonData) {
    const seenEmails = new Set();
    const errors = [];
    const normalizedData = [];
    for (const [index, row] of jsonData.entries()) {
      const rowNumber = row?._sourceRowNumber || index + 2;
      const normalized = normalizeWorkbookRow(row, rowNumber);
      if (!normalized.value) {
        errors.push({ index, rowNumber, status: 'failed', reason: normalized.error });
        continue;
      }
      if (seenEmails.has(normalized.value.email)) {
        errors.push({
          index,
          rowNumber,
          status: 'failed',
          reason: 'Duplicate email in this workbook',
        });
        continue;
      }
      seenEmails.add(normalized.value.email);
      normalizedData.push(normalized.value);
    }
    if (errors.length) {
      throw createValidationError({
        totalRows: jsonData.length,
        validRows: normalizedData.length,
        created: 0,
        updated: 0,
        failedRows: errors.length,
        completed: true,
        partial: false,
        rowResults: errors,
      });
    }
    return normalizedData;
  }

  normalizeRole(role) {
    return normalizeRoleValue(role);
  }

  isValidEmail(email) {
    return isValidEmailValue(email);
  }

  async processUsers(users, uploadedByUserId) {
    const summary = {
      totalRows: 0,
      validRows: 0,
      created: 0,
      updated: 0,
      skippedRows: 0,
      duplicateRows: 0,
      failedRows: 0,
      assignmentSyncFailures: 0,
      completed: false,
      partial: false,
      rowResults: [],
    };
    const results = {
      created: [],
      updated: [],
      skipped: [],
      emailsToNotify: [],
      emailsSent: 0,
      emailsFailed: 0,
      summary,
    };
    const rowsByEmail = new Set();
    const processableEmails = new Set();
    const validationFailures = [];
    let index = 0;

    for (const row of users) {
      const rowNumber = Number.isInteger(row?._sourceRowNumber)
        ? row._sourceRowNumber
        : index + 2;
      summary.totalRows += 1;
      const normalized = normalizeWorkbookRow(row, rowNumber);
      if (!normalized.value) {
        validationFailures.push({
          index,
          rowNumber,
          status: 'failed',
          reason: normalized.error,
        });
      } else if (rowsByEmail.has(normalized.value.email)) {
        summary.duplicateRows += 1;
        validationFailures.push({
          index,
          rowNumber,
          status: 'failed',
          reason: 'Duplicate email in this workbook',
        });
      } else {
        rowsByEmail.add(normalized.value.email);
        processableEmails.add(normalized.value.email);
        summary.validRows += 1;
      }
      index += 1;
    }

    summary.failedRows = validationFailures.length;
    summary.rowResults = validationFailures;
    if (!summary.totalRows) {
      summary.completed = true;
      return results;
    }

    let batch = [];
    let halted = false;
    const processedEmails = new Set();
    const processBatch = async () => {
      if (!batch.length || halted) return;
      const batchEmails = batch.map((item) => item.value.email);
      let existingUsers;
      try {
        existingUsers = await User.find({
          email: { $in: batchEmails },
        })
          .select('_id email name role bus_no is_active deleted_by_user')
          .lean();
      } catch {
        for (const item of batch) {
          summary.failedRows += 1;
          summary.rowResults.push({
            index: item.index,
            rowNumber: item.rowNumber,
            status: 'failed',
            reason: 'Database lookup failed',
          });
        }
        halted = true;
        batch = [];
        return;
      }
      const existingByEmail = new Map(
        existingUsers.map((user) => [user.email.toLowerCase(), user]),
      );
      const notifications = [];

      for (const item of batch) {
        if (halted) {
          summary.failedRows += 1;
          summary.rowResults.push({
            index: item.index,
            rowNumber: item.rowNumber,
            status: 'failed',
            reason: 'Not processed after an earlier database failure',
          });
          continue;
        }
        const existing = existingByEmail.get(item.value.email);
        try {
          if (existing?.is_active === false || existing?.deleted_by_user) {
            summary.skippedRows += 1;
            summary.rowResults.push({
              index: item.index,
              rowNumber: item.rowNumber,
              status: 'skipped',
              reason: 'Matching account is inactive and was not changed',
            });
            results.skipped.push(item.value.email);
            continue;
          }

          if (existing) {
            const nextUser = {
              role: item.value.role,
              bus_no: item.value.bus_no,
              is_active: true,
              deleted_by_user: false,
            };
            const routingChanged =
              existing.role !== nextUser.role ||
              String(existing.bus_no ?? '').trim().toUpperCase() !==
                String(nextUser.bus_no ?? '').trim().toUpperCase() ||
              existing.is_active !== nextUser.is_active ||
              Boolean(existing.deleted_by_user) !== nextUser.deleted_by_user;
            const updateUser = (session, includeRoutingFields) =>
              User.updateOne(
                { email: item.value.email },
                {
                  name: item.value.name,
                  ...(includeRoutingFields
                    ? {
                        role: item.value.role,
                        bus_no: item.value.bus_no,
                      }
                    : {}),
                },
                session ? { session } : {},
              );
            const updateResult = routingChanged
              ? await runGpsConfigurationMutation(async (session) => {
                  const result = await updateUser(session, true);
                  if (result.modifiedCount) {
                    const assignmentChanged =
                      String(existing.bus_no ?? '').trim().toUpperCase() !==
                      String(item.value.bus_no ?? '').trim().toUpperCase();
                    await recordAssignmentMutation({
                      session,
                      actorId: uploadedByUserId,
                      action: assignmentChanged
                        ? 'workbook-assignment-updated'
                        : 'workbook-account-routing-updated',
                      resourceId: existing._id,
                      requestId: `workbook:${uploadedByUserId}:${item.rowNumber}`,
                      recipients: [{
                        user_id: existing._id,
                        notification: assignmentChanged
                          ? {
                              type: item.value.bus_no
                                ? 'bus_reassigned'
                                : 'bus_unassigned',
                              message: item.value.bus_no
                                ? `Your bus assignment changed to Bus ${item.value.bus_no}.`
                                : 'Your bus assignment was removed.',
                              new_bus_no: item.value.bus_no || null,
                            }
                          : null,
                      }],
                      previousState: {
                        role: existing.role,
                        bus_no: existing.bus_no ?? null,
                        is_active: existing.is_active !== false,
                      },
                      newState: {
                        role: item.value.role,
                        bus_no: item.value.bus_no ?? null,
                        is_active: true,
                      },
                    });
                  }
                  return result;
                })
              : await updateUser(null, false);
            if (updateResult.modifiedCount) {
              const id = String(existing._id);
              if (existing.role !== item.value.role) {
                try {
                  disconnectUserSockets(id);
                } catch {
                  console.error('Unable to revoke a committed user session.');
                }
              }
            }
            results.updated.push({
              email: item.value.email,
              name: item.value.name,
              role: item.value.role,
              bus_no: item.value.bus_no,
            });
            summary.updated += 1;
            notifications.push({
              email: item.value.email,
              name: item.value.name,
              type: 'updated',
            });
          } else {
            const permanentPassword = this.generatePermanentPassword(
              item.value.phone,
              item.value.dob,
            );
            const newUser = {
              role: item.value.role,
              bus_no: item.value.bus_no,
              is_active: true,
              deleted_by_user: false,
            };
            const createUser = (session) =>
              User.create(
                session
                  ? [{
                      name: item.value.name,
                      email: item.value.email,
                      password_hash: permanentPassword,
                      role: item.value.role,
                      bus_no: item.value.bus_no,
                      is_active: true,
                    }]
                  : {
                      name: item.value.name,
                      email: item.value.email,
                      password_hash: permanentPassword,
                      role: item.value.role,
                      bus_no: item.value.bus_no,
                      is_active: true,
                    },
                session ? { session } : {},
              );
            await runLimitedImportPasswordHash(() =>
              runGpsConfigurationMutation(async (session) => {
                const created = await createUser(session);
                const createdUser = Array.isArray(created)
                  ? created[0]
                  : created;
                if (createdUser?._id) {
                  await recordAssignmentMutation({
                    session,
                    actorId: uploadedByUserId,
                    action: 'workbook-user-created',
                    resourceId: createdUser._id,
                    requestId: `workbook:${uploadedByUserId}:${item.rowNumber}`,
                    newState: {
                      role: item.value.role,
                      bus_no: item.value.bus_no ?? null,
                      is_active: true,
                    },
                  });
                }
                return created;
              }),
            );
            results.created.push({
              email: item.value.email,
              name: item.value.name,
              role: item.value.role,
              bus_no: item.value.bus_no,
            });
            summary.created += 1;
            notifications.push({
              email: item.value.email,
              name: item.value.name,
              permanentPassword,
              type: 'new',
            });
          }
          results.emailsToNotify.push({
            email: item.value.email,
            name: item.value.name,
            type: existing ? 'updated' : 'new',
          });
        } catch {
          summary.failedRows += 1;
          summary.rowResults.push({
            index: item.index,
            rowNumber: item.rowNumber,
            status: 'failed',
            reason: 'Database write failed',
          });
          halted = true;
        }
      }

      if (notifications.length) {
        const delivery = await this.sendNotifications(notifications);
        results.emailsSent += delivery.filter((item) => item.status === 'sent').length;
        results.emailsFailed += delivery.filter((item) => item.status === 'failed').length;
      }
      batch = [];
    };

    let processIndex = 0;
    for (const row of users) {
      const source = {
        row,
        index: processIndex,
        rowNumber: Number.isInteger(row?._sourceRowNumber)
          ? row._sourceRowNumber
          : processIndex + 2,
      };
      processIndex += 1;
      const sourceEmail = normalizeWorkbookRow(
        source.row,
        source.rowNumber,
      ).value?.email;
      if (!sourceEmail || !processableEmails.has(sourceEmail)) continue;
      if (processedEmails.has(sourceEmail)) continue;
      processedEmails.add(sourceEmail);
      const normalized = normalizeWorkbookRow(
        source.row,
        source.rowNumber,
      );
      if (!halted) {
        batch.push({
          ...source,
          value: normalized.value,
        });
        if (batch.length >= IMPORT_BATCH_SIZE) {
          await processBatch();
        }
      } else {
        summary.failedRows += 1;
        summary.rowResults.push({
          index: source.index,
          rowNumber: source.rowNumber,
          status: 'failed',
          reason: 'Not processed after an earlier database failure',
        });
      }
    }
    await processBatch();

    summary.completed =
      !halted &&
      summary.failedRows === validationFailures.length &&
      summary.assignmentSyncFailures === 0;
    summary.partial =
      summary.skippedRows > 0 ||
      (summary.failedRows > 0 && summary.created + summary.updated > 0) ||
      summary.assignmentSyncFailures > 0;
    return results;
  }

  generatePermanentPassword(phone, dob) {
    const phoneDigits = phone.replace(/\D/g, '').substring(0, 4);
    return phoneDigits + dob.toString();
  }

  async sendNotifications(emailsToNotify) {
    const notifications = [];
    for (const userData of emailsToNotify) {
      try {
        if (userData.type === 'new') {
          await sendEmail(
            userData.email,
            'Your BTMS Account Created',
            `Hello ${userData.name},

Your BTMS account has been created.
Password: ${userData.permanentPassword}

Best regards,
BTMS Team`,
          );
        } else {
          await sendEmail(
            userData.email,
            'Your BTMS Account Updated',
            `Hello ${userData.name},

Your BTMS account has been updated.

Best regards,
BTMS Team`,
          );
        }
        notifications.push({ email: userData.email, status: 'sent' });
      } catch (error) {
        console.error('Excel user notification delivery failed:', {
          name: error?.name || 'Error',
          code: error?.code || null,
        });
        notifications.push({ email: userData.email, status: 'failed' });
      }
    }
    return notifications;
  }
}

module.exports = new ExcelUserService();
