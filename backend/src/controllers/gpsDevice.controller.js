"use strict";

const mongoose = require("mongoose");
const Bus = require("../models/Bus");
const GpsDevice = require("../models/GpsDevice");
const BusLiveLocation = require("../models/BusLiveLocation");
const { runGpsConfigurationMutation } = require("../services/gpsConfigurationBarrier");

const listGpsDevices = async (_req, res, next) => {
  try {
    const devices = await GpsDevice.find({})
      .select(
        "deviceId source bus_id is_active lastAttemptedUpdate lastSuccessfulUpdate providerTimestamp lastLatitude lastLongitude healthStatus lastErrorCode updatedAt",
      )
      .sort({ deviceId: 1 })
      .lean();
    return res.json({ devices });
  } catch (error) {
    return next(error);
  }
};

const saveGpsDevice = async (req, res, next) => {
  const deviceId = String(req.params.deviceId || "").trim();
  const { source, busId, isActive = true } = req.body || {};
  if (
    !deviceId ||
    deviceId.length > 128 ||
    !["REAL", "SIMULATED"].includes(source) ||
    typeof isActive !== "boolean" ||
    !mongoose.isValidObjectId(busId)
  ) {
    return res.status(400).json({ error: "Invalid GPS device configuration." });
  }

  try {
    const bus = await Bus.findById(busId).select("_id").lean();
    if (!bus) return res.status(404).json({ error: "Assigned bus was not found." });
    const previousDevice = await GpsDevice.findOne({ deviceId })
      .select("bus_id source is_active")
      .lean();

    const conflict = await GpsDevice.findOne({
      bus_id: bus._id,
      is_active: true,
      deviceId: { $ne: deviceId },
    })
      .select("deviceId")
      .lean();
    if (isActive && conflict) {
      return res.status(409).json({
        error: "An active GPS device is already assigned to this bus.",
        code: "GPS_DEVICE_ASSIGNMENT_CONFLICT",
      });
    }

    const resetProviderTimestamp =
      !isActive ||
      previousDevice?.is_active === false ||
      String(previousDevice?.bus_id || "") !== String(bus._id) ||
      previousDevice?.source !== source;
    const affectedBusIds = new Set([String(bus._id)]);
    if (previousDevice?.bus_id) {
      affectedBusIds.add(String(previousDevice.bus_id));
    }
    const device = await runGpsConfigurationMutation(async (session) => {
      const savedDevice = await GpsDevice.findOneAndUpdate(
        { deviceId },
        {
          $set: {
            source,
            bus_id: bus._id,
            is_active: isActive,
            ...(resetProviderTimestamp ? { providerTimestamp: null } : {}),
            ...(isActive ? {} : { healthStatus: "INACTIVE" }),
          },
          $setOnInsert: {
            healthStatus: isActive ? "UNKNOWN" : "INACTIVE",
          },
        },
        {
          new: true,
          upsert: true,
          runValidators: true,
          setDefaultsOnInsert: true,
          ...(session ? { session } : {}),
        },
      )
        .select(
          "deviceId source bus_id is_active lastAttemptedUpdate lastSuccessfulUpdate providerTimestamp lastLatitude lastLongitude healthStatus lastErrorCode updatedAt",
        )
        .lean();
      if (resetProviderTimestamp) {
        await BusLiveLocation.updateMany(
          { bus_id: { $in: [...affectedBusIds] } },
          {
            $inc: { locationVersion: 1n },
            $set: {
              is_online: false,
              lastUpdated: new Date(),
              providerTimestamp: null,
              publicationPending: true,
              publicationNextAttemptAt: null,
              publicationRetryExhausted: false,
              publicationAttempts: 0,
              publicationCreatedAt: new Date(),
              publicationClaimId: null,
              publicationClaimUntil: null,
            },
          },
          session ? { session } : {},
        );
      }
      return savedDevice;
    });
    return res.json({ device });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        error: "An active GPS device is already assigned to this bus.",
        code: "GPS_DEVICE_ASSIGNMENT_CONFLICT",
      });
    }
    return next(error);
  }
};

module.exports = { listGpsDevices, saveGpsDevice };
