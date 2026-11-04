const mongoose = require('mongoose');
const normalizeBusNumber = require('../utils/normalizeBusNumber');

const busSchema = new mongoose.Schema(
  {
    bus_no: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      set: normalizeBusNumber,
    },
    bus_name: {
      type: String,
      default: null
    },
    reg_no: {
      type: String,
      default: null
    },
    gps_device_id: {
      type: String,
      required: true,
      unique: true
    },
    gps_device_aliases: {
      type: [String],
      default: [],
    },
    reg_no_aliases: {
      type: [String],
      default: [],
    },
    preview_number: {
      type: String,
      unique: true,
      sparse: true,
      default: null
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active'
    },
    mobile_live: {
      type: Boolean,
      default: false
    },
    altered_to_bus_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Bus',
      default: null
    },
    altered_to_preview: {
      type: String,
      default: null
    },
    alteration_type: {
      type: String,
      enum: ['alter', 'combine'],
      default: null
    },
    alteration_route_source: {
      type: String,
      enum: ['source', 'target', 'custom'],
      default: null
    },
    alteration_routes: {
      type: [{
        plan_name: { type: String, required: true },
        stop_name: { type: String, required: true },
        stop_order: { type: Number, required: true },
        stopId: { type: String, required: true }
      }],
      default: []
    },
    combined_route_source: {
      type: String,
      enum: ["source", "target", "custom"],
      default: null,
    },
    combined_routes: {
      type: [{
        plan_name: { type: String, required: true },
        stop_name: { type: String, required: true },
        stop_order: { type: Number, required: true },
        stopId: { type: String, default: null },
        arrival_time: { type: String, default: null },
      }],
      default: [],
    },
    altered_at: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
);

busSchema.index({ altered_to_bus_id: 1, alteration_type: 1 });

module.exports = mongoose.model('Bus', busSchema);
