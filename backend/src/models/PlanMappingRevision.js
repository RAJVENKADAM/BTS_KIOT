"use strict";

const mongoose = require("mongoose");

const planMappingRevisionSchema = new mongoose.Schema(
  {
    _id: { type: String },
    version: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.model(
  "PlanMappingRevision",
  planMappingRevisionSchema,
);
