const User = require('../models/User');

async function deactivateUser(req, res) {
  try {
    const { id } = req.params;

    const result = await User.updateOne(
      { _id: id },
      { is_active: false, deleted_by_user: true }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    return res.status(200).json({ success: true, message: 'User deactivated successfully' });
  } catch (error) {
    console.error('deactivateUser error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

async function updateUser(req, res) {
  try {
    const { id } = req.params;
    const { name, role, bus_no } = req.body || {};

    const update = {};
    if (name !== undefined) update.name = String(name).trim();
    if (role !== undefined) update.role = role;
    if (bus_no !== undefined) update.bus_no = bus_no ? String(bus_no).trim() : null;

    // Never allow role to be undefined in update; mongo schema will validate.
    if (!Object.keys(update).length) {
      return res.status(400).json({ success: false, error: 'No valid fields provided' });
    }

    const updated = await User.findByIdAndUpdate(id, update, { new: true }).select('name email role bus_no is_active deleted_by_user');

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
        is_active: updated.is_active,
        deleted_by_user: updated.deleted_by_user,
      },
    });
  } catch (error) {
    console.error('updateUser error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

module.exports = {
  deactivateUser,
  updateUser,
};

