const mongoose = require('mongoose');

const busRouteSchema = new mongoose.Schema(
  {
    bus_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Bus',
      required: true
    },
    plan_name: {
      type: String,
      required: true
    },
    stop_name: {
      type: String,
      required: true
    },
    stop_order: {
      type: Number,
      required: true
    }
  },
  { timestamps: true }
);

busRouteSchema.index({ bus_id: 1, plan_name: 1 });

module.exports = mongoose.model('BusRoute', busRouteSchema);
