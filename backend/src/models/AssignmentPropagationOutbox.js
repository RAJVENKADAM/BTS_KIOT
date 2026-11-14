"use strict";

const mongoose = require("mongoose");

const assignmentPropagationOutboxSchema = new mongoose.Schema(
  {
    _id: { type: String },
    actor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    operation: { type: String, required: true },
    recipients: { type: [mongoose.Schema.Types.Mixed], default: [] },
    previous_state: { type: mongoose.Schema.Types.Mixed, default: null },
    new_state: { type: mongoose.Schema.Types.Mixed, default: null },
    version: { type: Number, default: null },
    replay_of: { type: String, default: null },
    replay_request_id: { type: String, default: null },
    notification_source_id: { type: String, default: null },
    cursor: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "dead_letter"],
      default: "pending",
    },
    attempts: { type: Number, default: 0 },
    max_attempts: { type: Number, default: null },
    next_attempt_at: { type: Date, default: Date.now },
    lease_owner: { type: String, default: null },
    lease_expires_at: { type: Date, default: null },
    last_error_code: { type: String, default: null },
    last_error_name: { type: String, default: null },
    last_error_at: { type: Date, default: null },
    dead_letter_at: { type: Date, default: null },
    completed_at: { type: Date, default: null },
    active_replay_job_id: { type: String, default: null },
    replay_history: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { timestamps: true, minimize: false, autoIndex: false },
);

assignmentPropagationOutboxSchema.index({
  status: 1,
  next_attempt_at: 1,
  lease_expires_at: 1,
  createdAt: 1,
});
assignmentPropagationOutboxSchema.index({ replay_of: 1, status: 1 });

module.exports = mongoose.model(
  "AssignmentPropagationOutbox",
  assignmentPropagationOutboxSchema,
);
