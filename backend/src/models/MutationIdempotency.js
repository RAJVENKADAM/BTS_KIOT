"use strict";

const mongoose = require("mongoose");

const mutationIdempotencySchema = new mongoose.Schema(
  {
    _id: { type: String },
    scope: { type: String, required: true },
    request_hash: { type: String, required: true },
    actor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    response: { type: mongoose.Schema.Types.Mixed, default: null },
    resource_id: { type: String, default: null },
    resource_version: { type: Number, default: null },
  },
  { timestamps: true, minimize: false, autoIndex: false },
);

module.exports = mongoose.model(
  "MutationIdempotency",
  mutationIdempotencySchema,
);
