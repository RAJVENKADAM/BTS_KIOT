const mongoose = require('mongoose');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { disconnectUserSockets } = require('../socket');
const { escapeRegExp, parseCursor, parsePagination } = require('../utils/pagination');
const { logSafeError } = require('../utils/safeErrorLog');
const { recordAssignmentMutation } = require('../services/assignmentPropagation');
const {
  checkIdempotentReplay,
  getMutationHeaders,
  runIdempotentMutation,
} = require('../services/mutationIdempotency');
const { updateUserWithRevision } = require('../services/userRevision');
const {
  preserveSuperadminAccess: checkSuperadminAccess,
} = require('../services/superadminAccess');

const VALID_ROLES = ['student', 'primary_admin', 'superadmin'];

function normalizeUserIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return null;
  const uniqueIds = [...new Set(ids.map((id) => String(id)))];
  return uniqueIds.every((id) => mongoose.Types.ObjectId.isValid(id))
    ? uniqueIds
    : null;
}

async function getSelectedUsers(ids) {
  const users = await User.find({ _id: { $in: ids } })
    .select('_id role is_active')
    .lean();
  return users.length === ids.length ? users : null;
}

async function preserveSuperadminAccess(users, req, changingRole, session) {
  return checkSuperadminAccess(users, {
    currentUserId: req.user?.id,
    changingRole,
    session,
  });
}

function makeSuperadminAccessError(message) {
  const error = new Error(message);
  error.code = "SUPERADMIN_ACCESS_PROTECTED";
  error.statusCode = 409;
  return error;
}

async function getUsers(req, res) {
  try {
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

    const filter = { is_active: { $ne: false } };
    if (pagination.search) {
      const search = new RegExp(escapeRegExp(pagination.search), 'i');
      filter.$or = [
        { name: search },
        { email: search },
        { role: search },
        { bus_no: search },
      ];
    }
    if (req.query?.role) {
      if (!VALID_ROLES.includes(req.query.role)) {
        return res.status(400).json({ success: false, error: 'Select a supported role filter.' });
      }
      filter.role = req.query.role;
    }
    if (req.query?.busNo) {
      if (typeof req.query.busNo !== 'string' || req.query.busNo.trim().length > 100) {
        return res.status(400).json({ success: false, error: 'Bus filter is invalid.' });
      }
      filter.bus_no = req.query.busNo.trim().toUpperCase();
    }

    const queryFilter = cursor.cursorMode
      ? {
          ...filter,
          ...(cursor.cursor ? { _id: { $gt: cursor.cursor } } : {}),
        }
      : filter;
    const [records, total] = await Promise.all([
      cursor.cursorMode
        ? User.find(queryFilter)
            .select('name email role bus_no is_active resourceVersion assignmentRevision')
            .sort({ _id: 1 })
            .limit(pagination.limit + 1)
            .lean()
        : User.find(queryFilter)
            .select('name email role bus_no is_active resourceVersion assignmentRevision')
            .sort({ name: 1, email: 1 })
            .skip(pagination.skip)
            .limit(pagination.limit)
            .lean(),
      User.countDocuments(filter),
    ]);
    const hasNextPage = cursor.cursorMode
      ? records.length > pagination.limit
      : pagination.skip + records.length < total;
    const users = cursor.cursorMode
      ? records.slice(0, pagination.limit)
      : records;

    return res.status(200).json({
      success: true,
      users: users.map((user) => ({
        ...user,
        id: String(user._id),
        resourceVersion: user.resourceVersion ?? 0,
        assignmentRevision: user.assignmentRevision ?? 0,
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
    logSafeError('getUsers failed', error);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
}

async function deleteUsers(req, res, rawIds) {
  try {
    const idempotencyKey =
      req.get?.("Idempotency-Key") || req.headers?.["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length < 8 || idempotencyKey.trim().length > 200) {
      return res.status(400).json({
        success: false,
        error: "Provide a valid Idempotency-Key header.",
        code: "IDEMPOTENCY_KEY_REQUIRED",
      });
    }
    const ids = normalizeUserIds(rawIds);
    if (!ids) {
      return res.status(400).json({
        success: false,
        error: 'Select one or more valid user accounts.',
      });
    }

    const expectedVersions = req.body?.expectedVersions;
    if (
      !expectedVersions ||
      typeof expectedVersions !== "object" ||
      ids.some((id) =>
        !Number.isSafeInteger(Number(expectedVersions[id])) ||
        Number(expectedVersions[id]) < 0,
      )
    ) {
      return res.status(428).json({
        success: false,
        error: "Provide expectedVersions for each selected user.",
        code: "RESOURCE_VERSION_REQUIRED",
      });
    }
    const scope = `users-delete:${String(req.user?.id || "")}`;
    const request = { ids, expectedVersions };
    const replay = await checkIdempotentReplay({
      scope,
      idempotencyKey: idempotencyKey.trim(),
      request,
    });
    if (replay) {
      return res.status(200).json({ ...replay.response, duplicate: true });
    }
    const users = await User.find({ _id: { $in: ids } })
      .select('_id role is_active bus_no resourceVersion assignmentRevision')
      .lean();
    if (users.length !== ids.length) {
      return res.status(404).json({ success: false, error: 'One or more users were not found.' });
    }
    const accessError = await preserveSuperadminAccess(users, req, null);
    if (accessError) {
      return res.status(409).json({ success: false, error: accessError });
    }

    const result = await runIdempotentMutation({
      scope,
      idempotencyKey: idempotencyKey.trim(),
      actorId: req.user?.id,
      request: { ids, expectedVersions },
      resourceId: ids.join(","),
      mutate: async (session) => {
        const transactionalAccessError = await preserveSuperadminAccess(
          users,
          req,
          null,
          session,
        );
        if (transactionalAccessError) {
          throw makeSuperadminAccessError(transactionalAccessError);
        }
        for (const user of users) {
          const revision = Number(expectedVersions[String(user._id)]);
          const deletion = await User.deleteOne(
            {
              _id: user._id,
              $or: [
                { resourceVersion: revision },
                ...(revision === 0 ? [{ resourceVersion: { $exists: false } }] : []),
              ],
            },
            session ? { session } : {},
          );
          if (deletion.deletedCount !== 1) {
            const error = new Error("A selected user has changed. Reload and retry.");
            error.code = "USER_VERSION_CONFLICT";
            error.statusCode = 409;
            throw error;
          }
          await recordAssignmentMutation({
            session,
            actorId: req.user?.id,
            action: "user-permanently-deleted",
            resourceId: user._id,
            requestId: idempotencyKey,
            recipients: [{ user_id: user._id, notification: null }],
            previousState: {
              is_active: user.is_active,
              role: user.role,
              bus_no: user.bus_no ?? null,
              resourceVersion: user.resourceVersion ?? 0,
              assignmentRevision: user.assignmentRevision ?? 0,
            },
            newState: { deleted: true },
          });
        }
        return {
          response: {
            success: true,
            deletedCount: users.length,
            message: `${users.length} user account(s) permanently deleted.`,
          },
        };
      },
    });
    if (!result.duplicate) {
      disconnectUserSockets(ids);
      await Notification.deleteMany({ user_id: { $in: ids } });
    }
    return res.status(200).json({ ...result.response, duplicate: result.duplicate });
  } catch (error) {
    logSafeError('deleteUsers failed', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode ? error.message : 'Internal server error.',
      ...(error.code ? { code: error.code } : {}),
      ...(error.currentRevision !== undefined
        ? { currentRevision: error.currentRevision }
        : {}),
    });
  }
}

async function deleteUser(req, res) {
  return deleteUsers(req, res, [req.params.id]);
}

async function deleteSelectedUsers(req, res) {
  return deleteUsers(req, res, req.body?.ids);
}

async function updateUsersRole(req, res) {
  try {
    const idempotencyKey =
      req.get?.("Idempotency-Key") || req.headers?.["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length < 8 || idempotencyKey.trim().length > 200) {
      return res.status(400).json({
        success: false,
        error: "Provide a valid Idempotency-Key header.",
        code: "IDEMPOTENCY_KEY_REQUIRED",
      });
    }
    const ids = normalizeUserIds(req.body?.ids);
    const { role } = req.body || {};
    if (!ids || !VALID_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        error: 'Select valid users and a supported role.',
      });
    }

    const expectedVersions = req.body?.expectedVersions;
    const expectedAssignmentRevisions = req.body?.expectedAssignmentRevisions;
    if (
      !expectedVersions ||
      typeof expectedVersions !== "object" ||
      !expectedAssignmentRevisions ||
      typeof expectedAssignmentRevisions !== "object" ||
      ids.some((id) =>
        !Number.isSafeInteger(Number(expectedVersions[id])) ||
        Number(expectedVersions[id]) < 0 ||
        !Number.isSafeInteger(Number(expectedAssignmentRevisions[id])) ||
        Number(expectedAssignmentRevisions[id]) < 0,
      )
    ) {
      return res.status(428).json({
        success: false,
        error: "Provide expectedVersions and expectedAssignmentRevisions for each selected user.",
        code: "RESOURCE_VERSION_REQUIRED",
      });
    }
    const scope = `users-role:${String(req.user?.id || "")}`;
    const request = { ids, role, expectedVersions, expectedAssignmentRevisions };
    const replay = await checkIdempotentReplay({
      scope,
      idempotencyKey: idempotencyKey.trim(),
      request,
    });
    if (replay) {
      return res.status(200).json({ ...replay.response, duplicate: true });
    }
    const users = await User.find({ _id: { $in: ids } })
      .select('_id role is_active bus_no resourceVersion assignmentRevision')
      .lean();
    if (users.length !== ids.length) {
      return res.status(404).json({ success: false, error: 'One or more users were not found.' });
    }
    const accessError = await preserveSuperadminAccess(users, req, role);
    if (accessError) {
      return res.status(409).json({ success: false, error: accessError });
    }

    const changedUserIds = users
      .filter((user) => user.role !== role)
      .map((user) => String(user._id));
    const result = await runIdempotentMutation({
      scope,
      idempotencyKey: idempotencyKey.trim(),
      actorId: req.user?.id,
      request,
      resourceId: ids.join(","),
      mutate: async (session) => {
      const transactionalAccessError = await preserveSuperadminAccess(
        users,
        req,
        role,
        session,
      );
      if (transactionalAccessError) {
        throw makeSuperadminAccessError(transactionalAccessError);
      }
      for (const user of users) {
        const roleChangedForUser = user.role !== role;
        const updateResult = await updateUserWithRevision({
          userId: user._id,
          expectedResourceVersion: Number(expectedVersions[String(user._id)]),
          ...(roleChangedForUser
            ? {
                expectedAssignmentRevision:
                  Number(expectedAssignmentRevisions[String(user._id)]),
              }
            : {}),
          update: { $set: { role } },
          session,
        });
        if (!updateResult) {
          const error = new Error("A selected user has changed. Reload and retry.");
          error.code = "USER_VERSION_CONFLICT";
          error.statusCode = 409;
          throw error;
        }
      }
      if (changedUserIds.length) {
        await recordAssignmentMutation({
          session,
          actorId: req.user?.id,
          action: 'users-role-updated',
          requestId: req.get?.('Idempotency-Key'),
          recipients: changedUserIds.map((userId) => ({
            user_id: userId,
            notification: null,
          })),
          previousState: users
            .filter((user) => changedUserIds.includes(String(user._id)))
            .map((user) => ({
              user_id: user._id,
              role: user.role,
              resourceVersion: user.resourceVersion ?? 0,
              assignmentRevision: user.assignmentRevision ?? 0,
            })),
          newState: {
            user_ids: changedUserIds,
            role,
            revisions: users
              .filter((user) => changedUserIds.includes(String(user._id)))
              .map((user) => ({
                user_id: user._id,
                resourceVersion: (user.resourceVersion ?? 0) + 1,
                assignmentRevision: (user.assignmentRevision ?? 0) + 1,
              })),
          },
        });
      }
      return {
        response: {
          success: true,
          updatedCount: ids.length,
          message: `Role updated for ${ids.length} user account(s).`,
        },
      };
      },
    });
    if (!result.duplicate && changedUserIds.length) {
      disconnectUserSockets(changedUserIds);
    }
    return res.status(200).json({ ...result.response, duplicate: result.duplicate });
  } catch (error) {
    logSafeError('updateUsersRole failed', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode ? error.message : 'Internal server error.',
      ...(error.code ? { code: error.code } : {}),
    });
  }
}

async function updateUser(req, res) {
  try {
    const { id } = req.params;
    const { name, role, bus_no } = req.body || {};
    const { idempotencyKey, expectedVersion } = getMutationHeaders(req);
    const expectedAssignmentRevision =
      req.body?.expectedAssignmentRevision === undefined
        ? null
        : Number(req.body.expectedAssignmentRevision);
    if (
      (role !== undefined || bus_no !== undefined) &&
      (!Number.isSafeInteger(expectedAssignmentRevision) ||
        expectedAssignmentRevision < 0)
    ) {
      return res.status(428).json({
        success: false,
        error: "Provide expectedAssignmentRevision for assignment or access changes.",
        code: "ASSIGNMENT_REVISION_REQUIRED",
      });
    }

    const update = {};
    let roleChanged = false;
    let currentUser = null;
    if (name !== undefined) update.name = String(name).trim();
    if (role !== undefined && !VALID_ROLES.includes(role)) {
      return res.status(400).json({ success: false, error: 'Select a supported role.' });
    }
    if (role !== undefined) update.role = role;
    if (bus_no !== undefined) update.bus_no = bus_no ? String(bus_no).trim() : null;
    const replayRequest = {
      id,
      update,
      expectedVersion,
      expectedAssignmentRevision:
        (role !== undefined || bus_no !== undefined)
          ? expectedAssignmentRevision
          : null,
    };
    const replay = await checkIdempotentReplay({
      scope: `user-update:${String(req.user?.id || "")}`,
      idempotencyKey,
      request: replayRequest,
      expectedVersion,
    });
    if (replay) {
      return res.status(200).json({
        ...replay.response,
        duplicate: true,
      });
    }
    {
      currentUser = await User.findById(id)
        .select('_id name role is_active bus_no resourceVersion assignmentRevision')
        .lean();
      if (!currentUser) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }
    }
    if (role !== undefined) {
      if (String(currentUser._id) === String(req.user?.id || '')) {
        return res.status(409).json({
          success: false,
          error: 'You cannot change your own administrator role.',
        });
      }
      if (
        currentUser.role === 'superadmin' &&
        currentUser.is_active !== false &&
        role !== 'superadmin'
      ) {
        const activeSuperadmins = await User.countDocuments({
          role: 'superadmin',
          is_active: { $ne: false },
        });
        if (activeSuperadmins <= 1) {
          return res.status(409).json({
            success: false,
            error: 'At least one active super admin account must remain.',
          });
        }
      }
      roleChanged = role !== currentUser.role;
    }

    if (!Object.keys(update).length) {
      return res.status(400).json({ success: false, error: 'No valid fields provided' });
    }

    const assignmentChanged =
      bus_no !== undefined &&
      String(currentUser?.bus_no ?? '').trim().toUpperCase() !==
        String(update.bus_no ?? '').trim().toUpperCase();
    const assignmentSecurityChanged = assignmentChanged || roleChanged;
    const updated = await runIdempotentMutation({
      scope: `user-update:${String(req.user?.id || "")}`,
      idempotencyKey,
      actorId: req.user?.id,
      request: replayRequest,
      resourceId: id,
      expectedVersion,
      mutate: async (session) => {
        if (role !== undefined) {
          const transactionalAccessError = await preserveSuperadminAccess(
            [currentUser],
            req,
            role,
            session,
          );
          if (transactionalAccessError) {
            throw makeSuperadminAccessError(transactionalAccessError);
          }
        }
        const nextUser = await updateUserWithRevision({
          userId: id,
          expectedResourceVersion: expectedVersion,
          ...(assignmentSecurityChanged
            ? { expectedAssignmentRevision }
            : {}),
          update: { $set: update },
          session,
          select: "name email role bus_no is_active resourceVersion assignmentRevision",
        });
        if (!nextUser) {
          const error = new Error("The user changed. Reload before applying this update.");
          error.code = "USER_VERSION_CONFLICT";
          error.statusCode = 409;
          error.currentRevision = await User.findById(id)
            .select("resourceVersion assignmentRevision")
            .lean();
          throw error;
        }
        if (assignmentSecurityChanged) {
          await recordAssignmentMutation({
            session,
            actorId: req.user?.id,
            action: assignmentChanged
              ? 'student-assignment-updated'
              : 'user-role-updated',
            resourceId: id,
            requestId: idempotencyKey,
            recipients: [{
              user_id: nextUser._id,
              notification: assignmentChanged
                ? {
                    type: update.bus_no ? 'bus_reassigned' : 'bus_unassigned',
                    message: update.bus_no
                      ? `Your bus assignment changed to Bus ${update.bus_no}.`
                      : 'Your bus assignment was removed.',
                    new_bus_no: update.bus_no || null,
                  }
                : null,
            }],
            previousState: {
              role: currentUser?.role ?? null,
              bus_no: currentUser?.bus_no ?? null,
              is_active: currentUser?.is_active ?? null,
              resourceVersion: currentUser?.resourceVersion ?? 0,
              assignmentRevision: currentUser?.assignmentRevision ?? 0,
            },
            newState: {
              role: nextUser.role,
              bus_no: nextUser.bus_no ?? null,
              is_active: nextUser.is_active ?? null,
              resourceVersion: nextUser.resourceVersion,
              assignmentRevision: nextUser.assignmentRevision,
            },
          });
        }
        return {
          response: {
            success: true,
            user: {
              id: nextUser._id,
              name: nextUser.name,
              email: nextUser.email,
              role: nextUser.role,
              bus_no: nextUser.bus_no,
              resourceVersion: nextUser.resourceVersion,
              assignmentRevision: nextUser.assignmentRevision,
            },
          },
          resourceVersion: nextUser.resourceVersion,
        };
      },
    });

    if (!updated.duplicate && roleChanged) {
      try {
        disconnectUserSockets(id);
      } catch (error) {
        logSafeError('Could not immediately revoke the updated user session', error);
      }
    }

    return res.status(200).json({
      success: true,
      ...updated.response,
      duplicate: updated.duplicate,
    });
  } catch (error) {
    logSafeError('updateUser failed', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode ? error.message : 'Internal server error.',
      ...(error.code ? { code: error.code } : {}),
      ...(error.currentRevision ? { currentRevision: error.currentRevision } : {}),
    });
  }
}

module.exports = {
  getUsers,
  deleteUser,
  deleteSelectedUsers,
  updateUsersRole,
  updateUser,
};
