"use strict";

const mongoose = require("mongoose");

const importOperationSchema = new mongoose.Schema(
  {
    _id: { type: String },
    actor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    import_type: {
      type: String,
      enum: ["users", "excel-users", "bus-routes"],
      required: true,
    },
    idempotency_key: { type: String, required: true },
    content_hash: { type: String, required: true },
    status: {
      type: String,
      enum: ["staging", "processing", "completed", "partial"],
      default: "staging",
    },
    staging_owner: { type: String, default: null },
    staging_lease_until: { type: Date, default: null },
    total_rows: { type: Number, default: 0 },
    completed_rows: { type: Number, default: 0 },
    failed_rows: { type: Number, default: 0 },
    checkpoint: { type: Number, default: 0 },
    business_upload_id: { type: mongoose.Schema.Types.ObjectId, default: null },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true, minimize: false, autoIndex: false },
);

importOperationSchema.index(
  { actor_id: 1, import_type: 1, idempotency_key: 1 },
  { unique: true, name: "import_actor_type_key_unique" },
);
importOperationSchema.index({ status: 1, updatedAt: 1 });

module.exports = mongoose.model("ImportOperation", importOperationSchema);
