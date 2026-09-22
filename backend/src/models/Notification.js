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
      enum: ['bus_altered'],
      required: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    old_bus_no: {
      type: String,
      required: true,
    },
    new_bus_no: {
      type: String,
      required: true,
    },
    read_at: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

notificationSchema.index({ user_id: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
