"use strict";

const mongoose = require("mongoose");

const administrativeChangeAuditSchema = new mongoose.Schema(
  {
    _id: { type: String },
    actor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    action: { type: String, required: true },
    resource_id: { type: String, default: null },
    request_id: { type: String, default: null },
    resource_revision_before: { type: mongoose.Schema.Types.Mixed, default: null },
    resource_revision_after: { type: mongoose.Schema.Types.Mixed, default: null },
    assignment_revision_before: { type: mongoose.Schema.Types.Mixed, default: null },
    assignment_revision_after: { type: mongoose.Schema.Types.Mixed, default: null },
    bus_revision_before: { type: mongoose.Schema.Types.Mixed, default: null },
    bus_revision_after: { type: mongoose.Schema.Types.Mixed, default: null },
    previous_state: { type: mongoose.Schema.Types.Mixed, default: null },
    new_state: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true, minimize: false, autoIndex: false },
);

administrativeChangeAuditSchema.index({ createdAt: -1, action: 1 });

module.exports = mongoose.model(
  "AdministrativeChangeAudit",
  administrativeChangeAuditSchema,
);
