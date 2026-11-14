"use strict";

const mongoose = require("mongoose");

const assignmentPropagationReplaySchema = new mongoose.Schema(
  {
    _id: { type: String },
    original_job_id: { type: String, required: true },
    replay_job_id: { type: String, required: true },
    administrator_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    reason: { type: String, required: true },
    request_hash: { type: String, required: true },
    mode: { type: String, enum: ["resume", "full"], required: true },
    status: {
      type: String,
      enum: ["requested", "processing", "completed", "dead_letter"],
      default: "requested",
    },
    completed_at: { type: Date, default: null },
    last_error_code: { type: String, default: null },
  },
  { timestamps: true, minimize: false, autoIndex: false },
);

assignmentPropagationReplaySchema.index({ original_job_id: 1, createdAt: -1 });

module.exports = mongoose.model(
  "AssignmentPropagationReplay",
  assignmentPropagationReplaySchema,
);
