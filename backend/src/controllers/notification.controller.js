const Notification = require('../models/Notification');

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
        oldBusNo: notification.old_bus_no,
        newBusNo: notification.new_bus_no,
        planName: notification.plan_name,
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

module.exports = { getNotifications, getUnreadCount, markNotificationsRead };
