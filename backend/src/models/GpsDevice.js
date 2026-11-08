"use strict";

const mongoose = require("mongoose");

const gpsDeviceSchema = new mongoose.Schema(
  {
    deviceId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 128,
      unique: true,
    },
    source: {
      type: String,
      required: true,
      enum: ["REAL", "SIMULATED"],
    },
    bus_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Bus",
      required: true,
    },
    is_active: {
      type: Boolean,
      default: true,
    },
    gpsFenceToken: {
      type: mongoose.Schema.Types.BigInt,
      default: 0n,
    },
    lastAttemptedUpdate: {
      type: Date,
      default: null,
    },
    lastSuccessfulUpdate: {
      type: Date,
      default: null,
    },
    providerTimestamp: {
      type: Date,
      default: null,
    },
    lastLatitude: {
      type: Number,
      default: null,
      min: -90,
      max: 90,
    },
    lastLongitude: {
      type: Number,
      default: null,
      min: -180,
      max: 180,
    },
    healthStatus: {
      type: String,
      enum: ["UNKNOWN", "PENDING", "HEALTHY", "STALE", "ERROR", "INACTIVE"],
      default: "UNKNOWN",
    },
    lastErrorCode: {
      type: String,
      default: null,
      maxlength: 80,
    },
  },
  { timestamps: true },
);

gpsDeviceSchema.index(
  { bus_id: 1 },
  {
    unique: true,
    partialFilterExpression: { is_active: true },
  },
);

module.exports = mongoose.model("GpsDevice", gpsDeviceSchema);
