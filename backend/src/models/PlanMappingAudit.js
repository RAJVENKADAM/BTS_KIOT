"use strict";

const mongoose = require("mongoose");

const planMappingAuditSchema = new mongoose.Schema(
  {
    _id: { type: String },
    actor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    action: { type: String, required: true },
    scope: { type: String, required: true },
    request_hash: { type: String, required: true },
    expected_version: { type: Number, required: true },
    version: { type: Number, required: true },
    assignment_revisions: { type: [mongoose.Schema.Types.Mixed], default: [] },
    previous_state: { type: mongoose.Schema.Types.Mixed, default: null },
    new_state: { type: mongoose.Schema.Types.Mixed, required: true },
    response: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true, minimize: false, autoIndex: false },
);

planMappingAuditSchema.index({ createdAt: -1, _id: -1 });

module.exports = mongoose.model("PlanMappingAudit", planMappingAuditSchema);
