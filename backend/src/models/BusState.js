const mongoose = require('mongoose');

const busStateSchema = new mongoose.Schema(
  {
    bus_no: {
      type: String,
      required: true,
      unique: true
    },
    state: {
      type: String,
      enum: ['moving', 'waiting', 'stopped'],
      default: 'moving'
    },
    last_latitude: {
      type: Number,
      default: null
    },
    last_longitude: {
      type: Number,
      default: null
    },
    last_coords_time: {
      type: Date,
      default: null
    },
    state_changed_at: {
      type: Date,
      default: Date.now
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('BusState', busStateSchema);
