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
    speedKmh: {
      type: Number,
      default: null,
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
    providerTimestamp: {
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
    gpsFenceToken: {
      type: mongoose.Schema.Types.BigInt,
      default: 0n,
    },
    locationVersion: {
      type: mongoose.Schema.Types.BigInt,
      default: 0n,
    },
    publishedVersion: {
      type: mongoose.Schema.Types.BigInt,
      default: 0n,
    },
    publicationPending: {
      type: Boolean,
      default: false,
    },
    publicationRooms: {
      type: [String],
      default: [],
    },
    publicationPreviewNumber: {
      type: String,
      default: null,
    },
    publicationClaimId: {
      type: String,
      default: null,
    },
    publicationClaimUntil: {
      type: Date,
      default: null,
    },
    publicationNextAttemptAt: {
      type: Date,
      default: null,
    },
    publicationCreatedAt: {
      type: Date,
      default: null,
    },
    publicationAttempts: {
      type: Number,
      default: 0,
    },
    publicationRetryExhausted: {
      type: Boolean,
      default: false,
    },
    publicationLastErrorCode: {
      type: String,
      default: null,
      maxlength: 80,
    },
    publicationLastPublishedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

busLiveLocationSchema.index({
  publicationPending: 1,
  publicationRetryExhausted: 1,
  publicationNextAttemptAt: 1,
  publicationClaimUntil: 1,
  updatedAt: 1,
});

// Ensure the schema always has an initial consistent shape even when
// upserting from worker before the first successful provider response.
busLiveLocationSchema.pre('save', function (next) {
  if (!this.source) this.source = 'gps';
  next();
});

module.exports = mongoose.model('BusLiveLocation', busLiveLocationSchema);
