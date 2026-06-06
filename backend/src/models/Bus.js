const mongoose = require('mongoose');

const busSchema = new mongoose.Schema(
  {
    bus_no: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true
    },
    bus_name: {
      type: String,
      default: null
    },
    reg_no: {
      type: String,
      default: null
    },
    gps_device_id: {
      type: String,
      required: true,
      unique: true
    },
    preview_number: {
      type: String,
      unique: true,
      sparse: true,
      default: null
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active'
    },
    current_plan: {
      type: String,
      default: 'PLAN A'
    },
    mobile_live: {
      type: Boolean,
      default: false
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Bus', busSchema);
