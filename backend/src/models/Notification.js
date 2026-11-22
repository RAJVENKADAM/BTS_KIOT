const mongoose = require('mongoose');
const {
  invalidateNotificationUnreadCount,
} = require('../utils/readCache');

const notificationSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: [
        'bus_altered',
        'bus_combined',
        'bus_reassigned',
        'bus_unassigned',
        'bus_change_rolled_back',
        'plan_changed',
        'bus_status',
      ],
      required: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    // Internal bus numbers (kept for admin/audit purposes). Prefer preview fields for user-facing notifications.
    old_bus_no: {
      type: String,
      default: null,
    },
    new_bus_no: {
      type: String,
      default: null,
    },
    // New preview fields: safe to surface to end users.
    old_preview: {
      type: String,
      default: null,
    },
    new_preview: {
      type: String,
      default: null,
    },
    plan_name: {
      type: String,
      default: null,
    },
    is_bus_active: {
      type: Boolean,
      default: null,
    },
    read_at: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

notificationSchema.index({ user_id: 1, createdAt: -1 });
notificationSchema.index({ user_id: 1, read_at: 1, createdAt: -1 });

const createdAtIndex = notificationSchema.indexes().find(
  ([keys]) => Object.keys(keys).length === 1 && keys.createdAt === 1,
);
if (!createdAtIndex) {
  notificationSchema.index(
    { createdAt: 1 },
    { expireAfterSeconds: 172800, name: 'notification_created_at_ttl' },
  );
}

function invalidateForUserFilter(filter) {
  const userIds = filter?.user_id;
  if (userIds == null) {
    invalidateNotificationUnreadCount();
    return;
  }
  const values = Array.isArray(userIds.$in) ? userIds.$in : [userIds];
  for (const userId of values) {
    invalidateNotificationUnreadCount(userId);
  }
}

notificationSchema.post('save', (notification) => {
  invalidateNotificationUnreadCount(notification.user_id);
});
notificationSchema.post('insertMany', (notifications) => {
  for (const notification of notifications) {
    invalidateNotificationUnreadCount(notification.user_id);
  }
});
for (const operation of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'deleteOne',
  'deleteMany',
]) {
  notificationSchema.post(operation, function invalidateUnreadCount() {
    invalidateForUserFilter(this.getFilter());
  });
}

module.exports = mongoose.model('Notification', notificationSchema);
