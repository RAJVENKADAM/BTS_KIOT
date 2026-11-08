"use strict";

const mongoose = require("mongoose");

const gpsWorkerOwnershipSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: "gps-worker",
    },
    token: {
      type: mongoose.Schema.Types.BigInt,
      required: true,
    },
    ownerId: {
      type: String,
      default: null,
    },
    state: {
      type: String,
      enum: ["active", "inactive"],
      required: true,
    },
    leaseExpiresAt: {
      type: Date,
      required: true,
    },
    writeVersion: {
      type: mongoose.Schema.Types.BigInt,
      required: true,
    },
    configVersion: {
      type: mongoose.Schema.Types.BigInt,
      required: true,
    },
    updatedAt: {
      type: Date,
      required: true,
    },
  },
  {
    collection: "gpsworkerownerships",
    versionKey: false,
    autoIndex: false,
  },
);

module.exports = mongoose.model(
  "GpsWorkerOwnership",
  gpsWorkerOwnershipSchema,
);
