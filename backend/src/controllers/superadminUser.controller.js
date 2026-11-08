const mongoose = require('mongoose');
const User = require('../models/User');
const Notification = require('../models/Notification');
const {
  disconnectUserSockets,
  emitBusAssignmentNotification,
} = require('../socket');
const { escapeRegExp, parseCursor, parsePagination } = require('../utils/pagination');
const { logSafeError } = require('../utils/safeErrorLog');
const { runGpsConfigurationMutation } = require('../services/gpsConfigurationBarrier');

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

async function preserveSuperadminAccess(users, req, changingRole) {
  const currentUserId = String(req.user?.id || '');
  if (users.some((user) => String(user._id) === currentUserId)) {
    return 'You cannot change or delete your own administrator account.';
  }

  const selectedActiveSuperadmins = users.filter(
    (user) => user.role === 'superadmin' && user.is_active !== false,
  ).length;
  if (!selectedActiveSuperadmins) return null;

  const activeSuperadmins = await User.countDocuments({
    role: 'superadmin',
    is_active: { $ne: false },
  });
  const remaining = activeSuperadmins - selectedActiveSuperadmins;
  const replacementAdmins = changingRole === 'superadmin'
    ? users.filter((user) => user.is_active !== false).length
    : 0;
  return remaining + replacementAdmins > 0
    ? null
    : 'At least one active super admin account must remain.';
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
            .select('name email role bus_no is_active')
            .sort({ _id: 1 })
            .limit(pagination.limit + 1)
            .lean()
        : User.find(queryFilter)
            .select('name email role bus_no is_active')
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
      users: users.map((user) => ({ ...user, id: String(user._id) })),
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
    const ids = normalizeUserIds(rawIds);
    if (!ids) {
      return res.status(400).json({
        success: false,
        error: 'Select one or more valid user accounts.',
      });
    }

    const users = await getSelectedUsers(ids);
    if (!users) {
      return res.status(404).json({ success: false, error: 'One or more users were not found.' });
    }
    const accessError = await preserveSuperadminAccess(users, req, null);
    if (accessError) {
      return res.status(409).json({ success: false, error: accessError });
    }

    const result = await runGpsConfigurationMutation((session) =>
      User.deleteMany(
        { _id: { $in: ids } },
        session ? { session } : {},
      ),
    );
    if (result.deletedCount) disconnectUserSockets(ids);
    await Notification.deleteMany({ user_id: { $in: ids } });
    return res.status(200).json({
      success: true,
      deletedCount: result.deletedCount,
      message: `${result.deletedCount} user account(s) permanently deleted.`,
    });
  } catch (error) {
    logSafeError('deleteUsers failed', error);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
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
    const ids = normalizeUserIds(req.body?.ids);
    const { role } = req.body || {};
    if (!ids || !VALID_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        error: 'Select valid users and a supported role.',
      });
    }

    const users = await getSelectedUsers(ids);
    if (!users) {
      return res.status(404).json({ success: false, error: 'One or more users were not found.' });
    }
    const accessError = await preserveSuperadminAccess(users, req, role);
    if (accessError) {
      return res.status(409).json({ success: false, error: accessError });
    }

    const changedUserIds = users
      .filter((user) => user.role !== role)
      .map((user) => String(user._id));
    const result = await runGpsConfigurationMutation((session) =>
      User.updateMany(
        { _id: { $in: ids } },
        { $set: { role } },
        { runValidators: true, ...(session ? { session } : {}) },
      ),
    );
    if (result.modifiedCount && changedUserIds.length) {
      disconnectUserSockets(changedUserIds);
    }
    return res.status(200).json({
      success: true,
      updatedCount: ids.length,
      message: `Role updated for ${ids.length} user account(s).`,
    });
  } catch (error) {
    logSafeError('updateUsersRole failed', error);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
}

async function updateUser(req, res) {
  try {
    const { id } = req.params;
    const { name, role, bus_no } = req.body || {};

    const update = {};
    let roleChanged = false;
    let currentUser = null;
    if (name !== undefined) update.name = String(name).trim();
    if (role !== undefined && !VALID_ROLES.includes(role)) {
      return res.status(400).json({ success: false, error: 'Select a supported role.' });
    }
    if (role !== undefined || bus_no !== undefined) {
      currentUser = await User.findById(id)
        .select('_id role is_active bus_no')
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
      update.role = role;
    }
    if (bus_no !== undefined) update.bus_no = bus_no ? String(bus_no).trim() : null;

    if (!Object.keys(update).length) {
      return res.status(400).json({ success: false, error: 'No valid fields provided' });
    }

    const updateUser = async (session) =>
      User.findByIdAndUpdate(id, update, {
        new: true,
        runValidators: true,
        ...(session ? { session } : {}),
      }).select('name email role bus_no is_active');
    const updated =
      bus_no !== undefined || roleChanged || Object.hasOwn(update, 'is_active')
        ? await runGpsConfigurationMutation(updateUser)
        : await updateUser(null);

    if (!updated) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const normalizeAssignment = (value) =>
      String(value ?? '').trim().toUpperCase();
    if (
      bus_no !== undefined &&
      normalizeAssignment(currentUser?.bus_no) !==
        normalizeAssignment(updated.bus_no)
    ) {
      emitBusAssignmentNotification(updated._id, updated.bus_no);
    }
    if (roleChanged) disconnectUserSockets(id);

    return res.status(200).json({
      success: true,
      user: {
        id: updated._id,
        name: updated.name,
        email: updated.email,
        role: updated.role,
        bus_no: updated.bus_no,
      },
    });
  } catch (error) {
    logSafeError('updateUser failed', error);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
}

module.exports = {
  getUsers,
  deleteUser,
  deleteSelectedUsers,
  updateUsersRole,
  updateUser,
};
