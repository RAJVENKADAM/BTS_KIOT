const mongoose = require("mongoose");

const stopMasterSchema = new mongoose.Schema(
  {
    stopId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    aliases: { type: [String], default: [] },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    source: {
      type: String,
      enum: ["OSM", "ADMIN", "EXISTING_STOP"],
      required: true,
      default: "EXISTING_STOP",
    },
    status: {
      type: String,
      enum: ["PENDING", "VERIFIED"],
      required: true,
      default: "PENDING",
      index: true,
    },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    verifiedAt: { type: Date, default: null },
    proposedLocation: {
      name: { type: String, default: null },
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
      osmId: { type: String, default: null },
      osmType: { type: String, default: null },
      fetchedAt: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

stopMasterSchema.index({ name: 1, status: 1 });
stopMasterSchema.index({ aliases: 1, status: 1 });

module.exports = mongoose.model("StopMaster", stopMasterSchema);
