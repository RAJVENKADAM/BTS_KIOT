const StopMaster = require("../models/StopMaster");
const uniqueStopCoordinateRows = require("../utils/uniqueStopCoordinateRows");
const { logSafeError } = require("../utils/safeErrorLog");

async function getCoordinateSheet(req, res) {
  try {
    const storedStops = await StopMaster.find({})
      .select("stopId name latitude longitude status")
      .sort({ name: 1, stopId: 1 })
      .lean();
    return res.json({
      success: true,
      stops: uniqueStopCoordinateRows(storedStops).map((stop) => ({
        stopId: stop.stopId,
        name: stop.name,
        latitude: stop.latitude,
        longitude: stop.longitude,
        status: stop.status,
      })),
    });
  } catch (error) {
    logSafeError("getCoordinateSheet failed", error);
    return res.status(500).json({
      success: false,
      error: "Failed to download the Stop Master coordinate sheet.",
    });
  }
}

async function importCoordinates(req, res) {
  return res.status(410).json({
    success: false,
    code: "STOP_COORDINATE_IMPORT_RETIRED",
    error: "Stop-coordinate replacement is temporarily retired until revision-checked transactional import is available.",
  });
}

module.exports = { getCoordinateSheet, importCoordinates };
