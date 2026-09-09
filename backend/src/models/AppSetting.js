const mongoose = require('mongoose');

const appSettingSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    value: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      default: null,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model('AppSetting', appSettingSchema);
