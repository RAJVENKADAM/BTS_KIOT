const mongoose = require('mongoose');

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
      enum: ['bus_altered', 'plan_changed', 'bus_status'],
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

module.exports = mongoose.model('Notification', notificationSchema);
