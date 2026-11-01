const mongoose = require('mongoose');
const User = require('../models/User');
const Notification = require('../models/Notification');

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
    const users = await User.find({ is_active: { $ne: false } })
      .select('name email role bus_no is_active')
      .sort({ name: 1, email: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      users: users.map((user) => ({ ...user, id: String(user._id) })),
    });
  } catch (error) {
    console.error('getUsers error:', error);
    return res.status(500).json({ success: false, error: error.message });
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

    const result = await User.deleteMany({ _id: { $in: ids } });
    await Notification.deleteMany({ user_id: { $in: ids } });
    return res.status(200).json({
      success: true,
      deletedCount: result.deletedCount,
      message: `${result.deletedCount} user account(s) permanently deleted.`,
    });
  } catch (error) {
    console.error('deleteUsers error:', error);
    return res.status(500).json({ success: false, error: error.message });
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

    await User.updateMany(
      { _id: { $in: ids } },
      { $set: { role } },
      { runValidators: true },
    );
    return res.status(200).json({
      success: true,
      updatedCount: ids.length,
      message: `Role updated for ${ids.length} user account(s).`,
    });
  } catch (error) {
    console.error('updateUsersRole error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

async function updateUser(req, res) {
  try {
    const { id } = req.params;
    const { name, role, bus_no } = req.body || {};

    const update = {};
    if (name !== undefined) update.name = String(name).trim();
    if (role !== undefined) {
      if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ success: false, error: 'Select a supported role.' });
      }

      const currentUser = await User.findById(id).select('_id role is_active').lean();
      if (!currentUser) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }
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
      update.role = role;
    }
    if (bus_no !== undefined) update.bus_no = bus_no ? String(bus_no).trim() : null;

    if (!Object.keys(update).length) {
      return res.status(400).json({ success: false, error: 'No valid fields provided' });
    }

    const updated = await User.findByIdAndUpdate(id, update, {
      new: true,
      runValidators: true,
    }).select('name email role bus_no is_active');

    if (!updated) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

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
    console.error('updateUser error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

module.exports = {
  getUsers,
  deleteUser,
  deleteSelectedUsers,
  updateUsersRole,
  updateUser,
};
