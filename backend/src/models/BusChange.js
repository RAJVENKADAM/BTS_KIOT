const mongoose = require("mongoose");

const busSnapshotSchema = new mongoose.Schema(
  {
    busId: { type: mongoose.Schema.Types.ObjectId, ref: "Bus", required: true },
    busNo: { type: String, required: true },
    status: { type: String, enum: ["active", "inactive"], required: true },
    alteredToBusId: { type: mongoose.Schema.Types.ObjectId, ref: "Bus", default: null },
    alteredToPreview: { type: String, default: null },
    alterationType: { type: String, enum: ["alter", "combine"], default: null },
    alterationRouteSource: { type: String, enum: ["source", "target", "custom"], default: null },
    alterationRoutes: { type: [mongoose.Schema.Types.Mixed], default: [] },
    alteredAt: { type: Date, default: null },
    combinedRouteSource: { type: String, enum: ["source", "target", "custom"], default: null },
    combinedRoutes: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { _id: false },
);

const assignmentSnapshotSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    beforeBusNo: { type: String, default: null },
    afterBusNo: { type: String, default: null },
  },
  { _id: false },
);

const busChangeSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["alter", "combine"], required: true, index: true },
    status: {
      type: String,
      enum: ["applying", "active", "rolled_back"],
      default: "applying",
      index: true,
    },
    sourceBusId: { type: mongoose.Schema.Types.ObjectId, ref: "Bus", required: true },
    sourceBusNo: { type: String, required: true },
    sourcePreview: { type: String, default: null },
    targetBusId: { type: mongoose.Schema.Types.ObjectId, ref: "Bus", required: true },
    targetBusNo: { type: String, required: true },
    targetPreview: { type: String, default: null },
    routeSource: { type: String, enum: ["source", "target", "custom"], default: null },
    busSnapshots: { type: [busSnapshotSchema], required: true },
    assignmentSnapshots: { type: [assignmentSnapshotSchema], default: [] },
    affectedUsersCount: { type: Number, default: 0 },
    rolledBackAt: { type: Date, default: null },
  },
  { timestamps: true },
);

busChangeSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("BusChange", busChangeSchema);
