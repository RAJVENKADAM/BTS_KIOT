const mongoose = require("mongoose");

const planMappingSchema = new mongoose.Schema(
  {
    plan_name: {
      type: String,
      enum: ["PLAN B", "PLAN C", "PLAN D"],
      required: true,
      uppercase: true,
      trim: true,
    },
    cluster_name: {
      type: String,
      required: true,
      trim: true,
    },
    root_bus_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Bus",
      required: true,
    },
    member_bus_ids: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "Bus",
      default: [],
    },
  },
  { timestamps: true },
);

planMappingSchema.index({ plan_name: 1, root_bus_id: 1 });
planMappingSchema.index({ plan_name: 1, member_bus_ids: 1 });

module.exports = mongoose.model("PlanMapping", planMappingSchema);
