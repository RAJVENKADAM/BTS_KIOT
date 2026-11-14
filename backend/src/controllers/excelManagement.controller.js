const mongoose = require('mongoose');
const { createHash } = require('node:crypto');
const ExcelUpload = require('../models/ExcelUpload');
const User = require('../models/User');
const Bus = require('../models/Bus');
const normalizeBusNumber = require('../utils/normalizeBusNumber');
const { parseCursor, parsePagination } = require('../utils/pagination');
const { logSafeError } = require('../utils/safeErrorLog');
const { recordAssignmentMutation } = require('../services/assignmentPropagation');
const {
  getMutationHeaders,
  runIdempotentMutation,
} = require('../services/mutationIdempotency');
const { buildUserRevisionFilter } = require('../services/userRevision');
const { preserveSuperadminAccess } = require('../services/superadminAccess');
const { disconnectUserSockets } = require('../socket');

// Get all Excel uploads for current user
async function getAllExcelUploads(req, res) {
  try {
    const userId = req.user?.id;

    // Use Mongoose's built-in ObjectId validator instead of fragile length check.
    if (!userId || typeof userId !== 'string' || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(200).json({
        success: true,
        data: []
      });
    }

    const uploads = await ExcelUpload.find({ uploaded_by: userId })
      .sort({ createdAt: -1 })
      .select('_id file_name custom_name uploaded_by createdAt updatedAt is_active import_status import_summary revision')
      .lean();

    // Ensure frontend receives a stable `id` field and uses `custom_name` correctly.
    const normalized = uploads.map((obj) => {
      // Frontend expects: upload.id and upload.custom_name
      return {
        ...obj,
        id: obj._id,
        custom_name: obj.custom_name,
        uploaded_at: obj.createdAt,
      };
    });

    res.status(200).json({
      success: true,
      data: normalized
    });
  } catch (error) {
    logSafeError('Get Excel uploads failed', error);
    res.status(500).json({
      success: false,
      error: 'Failed to load Excel uploads.'
    });
  }
}

// Get specific Excel upload
async function getExcelUpload(req, res) {
  try {
    const { id } = req.params;
    const upload = await ExcelUpload.findById(id);
    
    if (!upload) {
      return res.status(404).json({
        success: false,
        error: 'Excel upload not found'
      });
    }
    
    res.status(200).json({
      success: true,
      data: upload
    });
  } catch (error) {
    logSafeError('Get Excel upload failed', error);
    res.status(500).json({
      success: false,
      error: 'Failed to load Excel upload.'
    });
  }
}

// Delete Excel upload and cascade-wipe all linked users
async function deleteExcelUpload(req, res) {
  let affectedUserIds = [];
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'Invalid Excel upload ID.' });
    }
    const { expectedVersion, idempotencyKey } = getMutationHeaders(req);
    const mutation = await runIdempotentMutation({
      scope: `excel-upload-delete:${id}`,
      idempotencyKey,
      actorId: userId,
      request: { uploadId: id },
      resourceId: id,
      expectedVersion,
      mutate: async (session) => {
        let uploadQuery = ExcelUpload.findById(id)
          .select('_id uploaded_by is_active revision');
        if (session) uploadQuery = uploadQuery.session(session);
        const upload = await uploadQuery.lean();
        if (!upload) {
          const error = new Error('Excel upload not found.');
          error.statusCode = 404;
          throw error;
        }

        const uploadRevision = upload.revision ?? 0;
        if (uploadRevision !== expectedVersion || upload.is_active === false) {
          const error = new Error('The Excel upload changed. Refresh and retry.');
          error.code = 'RESOURCE_REVISION_CONFLICT';
          error.statusCode = 409;
          throw error;
        }

        const revisionFilter = expectedVersion === 0
          ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
          : { revision: expectedVersion };
        const deactivatedUpload = await ExcelUpload.findOneAndUpdate(
          {
            _id: id,
            is_active: true,
            ...revisionFilter,
          },
          {
            $set: { is_active: false },
            $inc: { revision: 1 },
          },
          { new: true, runValidators: true, ...(session ? { session } : {}) },
        ).lean();
        if (!deactivatedUpload) {
          const error = new Error('The Excel upload changed. Refresh and retry.');
          error.code = 'RESOURCE_REVISION_CONFLICT';
          error.statusCode = 409;
          throw error;
        }

        let linkedUsersQuery = User.find({
          excel_upload_id: id,
          is_active: true,
          deleted_by_user: { $ne: true },
        })
          .select('_id role bus_no resourceVersion assignmentRevision')
          .lean();
        if (session) linkedUsersQuery = linkedUsersQuery.session(session);
        const linkedUsers = await linkedUsersQuery;
        const accessError = await preserveSuperadminAccess(linkedUsers, {
          currentUserId: userId,
          session,
        });
        if (accessError) {
          const error = new Error(accessError);
          error.code = 'SUPERADMIN_ACCESS_PROTECTED';
          error.statusCode = 409;
          throw error;
        }
        affectedUserIds = linkedUsers.map((user) => String(user._id));
        const userOperations = linkedUsers.map((user) => ({
          updateOne: {
            filter: {
              $and: [
                buildUserRevisionFilter({
                  userId: user._id,
                  expectedResourceVersion: user.resourceVersion ?? 0,
                  expectedAssignmentRevision: user.assignmentRevision ?? 0,
                }),
                {
                  excel_upload_id: id,
                  is_active: true,
                  deleted_by_user: { $ne: true },
                },
              ],
            },
            update: {
              $set: { is_active: false, deleted_by_user: true },
              $inc: { resourceVersion: 1, assignmentRevision: 1 },
            },
            upsert: false,
          },
        }));
        if (userOperations.length) {
          const writeResult = await User.bulkWrite(userOperations, {
            ordered: true,
            ...(session ? { session } : {}),
          });
          if (writeResult.matchedCount !== userOperations.length) {
            const error = new Error(
              'Linked users changed. Refresh and retry the upload deactivation.',
            );
            error.code = 'ASSIGNMENT_REVISION_CONFLICT';
            error.statusCode = 409;
            throw error;
          }
        }

        const mutationId = `excel-upload-delete:${createHash('sha256')
          .update(`${id}\u0000${idempotencyKey}`)
          .digest('hex')}`;
        await recordAssignmentMutation({
          session,
          mutationId,
          actorId: userId,
          action: 'spreadsheet-users-deactivated',
          resourceId: id,
          requestId: idempotencyKey,
          recipients: linkedUsers.map((user) => ({
            user_id: user._id,
            notification: null,
          })),
          previousState: {
            upload_is_active: true,
            upload_revision: uploadRevision,
            user_ids: linkedUsers.map((user) => String(user._id)),
          },
          newState: {
            upload_is_active: false,
            upload_revision: deactivatedUpload.revision,
            user_ids: linkedUsers.map((user) => String(user._id)),
            users_is_active: false,
            users_deleted_by_user: true,
          },
          resourceRevisionBefore: uploadRevision,
          resourceRevisionAfter: deactivatedUpload.revision,
        });

        const response = {
          success: true,
          message: 'Excel upload and linked users were deactivated.',
          deactivatedUsers: linkedUsers.length,
          revision: deactivatedUpload.revision,
        };
        return { response, resourceVersion: deactivatedUpload.revision };
      },
    });

    if (!mutation.duplicate && affectedUserIds.length) {
      try {
        disconnectUserSockets(affectedUserIds);
      } catch (error) {
        logSafeError('Committed Excel upload deactivation socket revocation failed', error);
      }
    }
    return res.status(200).json({
      ...mutation.response,
      duplicate: mutation.duplicate,
    });
  } catch (error) {
    logSafeError('Delete Excel upload failed', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode
        ? error.message
        : 'Failed to deactivate the Excel upload. Please retry with the same key and content.',
      ...(error.code ? { code: error.code } : {}),
    });
  }
}

// Get users associated with Excel upload
async function getUsersByExcelUpload(req, res) {
  try {
    const { id } = req.params;
    const pagination = parsePagination(req.query || {}, {
      defaultLimit: 100,
      maxLimit: 200,
    });
    if (pagination.error) {
      return res.status(400).json({ success: false, error: pagination.error });
    }
    const cursor = parseCursor(req.query || {});
    if (cursor.error) {
      return res.status(400).json({ success: false, error: cursor.error });
    }
    
    // Find Excel upload
    const upload = await ExcelUpload.findById(id).select('_id').lean();
    if (!upload) {

      return res.status(404).json({
        success: false,
        error: 'Excel upload not found'
      });
    }

    // Find active users linked to this Excel upload (FIX 3: filter only active users)
    const userFilter = { excel_upload_id: id, is_active: true };
    const queryFilter = cursor.cursorMode
      ? {
          ...userFilter,
          ...(cursor.cursor ? { _id: { $gt: cursor.cursor } } : {}),
        }
      : userFilter;
    const [records, total] = await Promise.all([
      cursor.cursorMode
        ? User.find(queryFilter)
            .select('name email role bus_no is_active')
            .sort({ _id: 1 })
            .limit(pagination.limit + 1)
            .lean()
        : User.find(queryFilter)
            .select('name email role bus_no is_active')
            .sort({ _id: 1 })
            .skip(pagination.skip)
            .limit(pagination.limit)
            .lean(),
      User.countDocuments(userFilter),
    ]);
    const hasNextPage = cursor.cursorMode
      ? records.length > pagination.limit
      : pagination.skip + records.length < total;
    const users = cursor.cursorMode
      ? records.slice(0, pagination.limit)
      : records;
    const busNumbers = [
      ...new Set(
        users
          .map((user) => normalizeBusNumber(user.bus_no))
          .filter(Boolean),
      ),
    ];
    const buses = busNumbers.length
      ? await Bus.find({ bus_no: { $in: busNumbers } })
        .select('bus_no preview_number')
        .lean()
      : [];
    const previewByBusNumber = new Map(
      buses.map((bus) => [
        normalizeBusNumber(bus.bus_no),
        bus.preview_number,
      ]),
    );

    res.status(200).json({
      success: true,
      data: users.map((user) => ({
        ...user,
        id: String(user._id),
        previewNumber: previewByBusNumber.get(
          normalizeBusNumber(user.bus_no),
        ) ?? null,
      })),
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages: Math.ceil(total / pagination.limit),
        hasNextPage,
        hasPreviousPage: cursor.cursorMode
          ? Boolean(cursor.cursor)
          : pagination.page > 1,
        ...(cursor.cursorMode
          ? { nextCursor: hasNextPage ? String(users.at(-1)._id) : null }
          : {}),
      },
    });
  } catch (error) {
    logSafeError('Get users by Excel upload failed', error);
    res.status(500).json({
      success: false,
      error: 'Failed to load users for Excel upload.'
    });
  }
}

module.exports = {
  getAllExcelUploads,
  getExcelUpload,
  deleteExcelUpload,
  getUsersByExcelUpload
};