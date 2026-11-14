"use strict";

const mongoose = require("mongoose");

const importRowSchema = new mongoose.Schema(
  {
    _id: { type: String },
    operation_id: {
      type: String,
      ref: "ImportOperation",
      required: true,
    },
    row_number: { type: Number, required: true },
    source_row_number: { type: Number, default: null },
    normalized_identity: { type: String, required: true },
    input: { type: mongoose.Schema.Types.Mixed, default: null },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed", "conflict"],
      default: "pending",
    },
    expected_version: { type: Number, default: null },
    expected_version_captured: { type: Boolean, default: false },
    expected_assignment_revision: { type: Number, default: null },
    attempt_count: { type: Number, default: 0 },
    claim_owner: { type: String, default: null },
    claim_until: { type: Date, default: null },
    retryable: { type: Boolean, default: false },
    last_error_category: { type: String, default: null },
    last_error: { type: String, default: null },
    result_resource_id: { type: String, default: null },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    completed_at: { type: Date, default: null },
  },
  { timestamps: true, minimize: false, autoIndex: false },
);

importRowSchema.index(
  { operation_id: 1, row_number: 1 },
  { unique: true, name: "import_row_number_unique" },
);
importRowSchema.index(
  { operation_id: 1, status: 1, claim_until: 1, row_number: 1 },
  { name: "import_row_claim" },
);

module.exports = mongoose.model("ImportRow", importRowSchema);
