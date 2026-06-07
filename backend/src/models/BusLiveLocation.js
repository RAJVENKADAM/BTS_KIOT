const mongoose = require('mongoose');

const busLiveLocationSchema = new mongoose.Schema(
  {
    bus_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Bus',
      required: true,
      unique: true,
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // Current last known coordinates (keep these unchanged on provider failures)
    latitude: {
  type: Number,
  default: null,
},
longitude: {
  type: Number,
  default: null,
},

    speed: {
      type: Number,
      default: 0,
    },

    // Only switch to true on a confirmed successful GPS provider response.
    // Offline detection is handled time-based using lastSuccessfulGpsUpdate.
    is_online: {
      type: Boolean,
      default: true,
    },

    // Explicit requirement: track when GPS provider last succeeded
    lastSuccessfulGpsUpdate: {
      type: Date,
      default: null,
    },

    // Explicit requirement: updated every worker cycle (success or failure)
    // This is separate from timestamps.updatedAt.
    lastUpdated: {
      type: Date,
      default: null,
    },

    source: {
      type: String,
      default: 'gps',
    },
  },
  { timestamps: true }
);

// Ensure the schema always has an initial consistent shape even when
// upserting from worker before the first successful provider response.
busLiveLocationSchema.pre('save', function (next) {
  if (!this.source) this.source = 'gps';
  next();
});

module.exports = mongoose.model('BusLiveLocation', busLiveLocationSchema);

