const Notification = require('../models/Notification');
const mongoose = require('mongoose');

async function getNotifications(req, res) {
  try {
    const notifications = await Notification.find({ user_id: req.user.id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const unreadCount = await Notification.countDocuments({
      user_id: req.user.id,
      read_at: null,
    });

    res.json({
      success: true,
      notifications: notifications.map((notification) => ({
        id: notification._id,
        type: notification.type,
        message: notification.message,
        oldPreview: notification.old_preview,
        newPreview: notification.new_preview,
        isBusActive: notification.is_bus_active,
        read: !!notification.read_at,
        createdAt: notification.createdAt,
      })),
      unreadCount,
    });
  } catch (error) {
    console.error('getNotifications error:', error);
    res.status(500).json({ success: false, error: 'Failed to load notifications.' });
  }
}

async function getUnreadCount(req, res) {
  try {
    const unreadCount = await Notification.countDocuments({
      user_id: req.user.id,
      read_at: null,
    });
    res.json({ success: true, unreadCount });
  } catch (error) {
    console.error('getUnreadCount error:', error);
    res.status(500).json({ success: false, error: 'Failed to load unread notifications.' });
  }
}

async function markNotificationsRead(req, res) {
  try {
    await Notification.updateMany(
      { user_id: req.user.id, read_at: null },
      { read_at: new Date() },
    );
    res.json({ success: true });
  } catch (error) {
    console.error('markNotificationsRead error:', error);
    res.status(500).json({ success: false, error: 'Failed to update notifications.' });
  }
}

async function markNotificationRead(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid notification id.' });
    }
    const result = await Notification.updateOne(
      { _id: req.params.id, user_id: req.user.id },
      { $set: { read_at: new Date() } },
    );
    if (!result.matchedCount) {
      return res.status(404).json({ success: false, error: 'Notification not found.' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('markNotificationRead error:', error);
    res.status(500).json({ success: false, error: 'Failed to update notification.' });
  }
}

async function deleteNotification(req, res) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid notification id.' });
    }
    const result = await Notification.deleteOne({
      _id: req.params.id,
      user_id: req.user.id,
    });
    if (!result.deletedCount) {
      return res.status(404).json({ success: false, error: 'Notification not found.' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('deleteNotification error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete notification.' });
  }
}

module.exports = {
  getNotifications,
  getUnreadCount,
  markNotificationsRead,
  markNotificationRead,
  deleteNotification,
};
