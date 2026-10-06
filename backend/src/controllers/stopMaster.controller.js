const StopMaster = require("../models/StopMaster");
const { getIO } = require("../socket");
const normalizeStopName = require("../utils/normalizeStopName");
const uniqueStopCoordinateRows = require("../utils/uniqueStopCoordinateRows");

function validCoordinates(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

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
    console.error("getCoordinateSheet error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to download the Stop Master coordinate sheet.",
    });
  }
}

async function importCoordinates(req, res) {
  const rows = req.body?.stops;
  if (!Array.isArray(rows) || rows.length > 10000) {
    return res.status(400).json({
      success: false,
      error: "Provide a coordinate sheet with no more than 10,000 stop rows.",
    });
  }

  try {
    const knownStops = await StopMaster.find({})
      .select("stopId name")
      .lean();
    const byName = new Map();
    const byId = new Map(knownStops.map((stop) => [stop.stopId, stop]));
    for (const stop of knownStops) {
      const key = normalizeStopName(stop.name);
      byName.set(key, [...(byName.get(key) || []), stop]);
    }

    const rowIndexesByName = new Map();
    rows.forEach((row, index) => {
      const key = row?.stopId
        ? `ID:${String(row.stopId).trim()}`
        : normalizeStopName(row?.name);
      if (key) {
        rowIndexesByName.set(key, [
          ...(rowIndexesByName.get(key) || []),
          index,
        ]);
      }
    });
    const duplicateRows = new Set();
    for (const indexes of rowIndexesByName.values()) {
      if (indexes.length > 1) indexes.forEach((index) => duplicateRows.add(index));
    }

    const operations = [];
    const rowResults = [];
    rows.forEach((row, index) => {
      const name = String(row?.name || "").trim().replace(/\s+/g, " ");
      const key = normalizeStopName(name);
      const rawLatitude = row?.latitude;
      const rawLongitude = row?.longitude;
      const hasLatitude = String(rawLatitude ?? "").trim() !== "";
      const hasLongitude = String(rawLongitude ?? "").trim() !== "";
      const stopId = String(row?.stopId || "").trim();

      if (!name || name.length > 160) {
        rowResults.push({
          row: index + 2,
          name,
          status: "invalid",
          reason: "Stop name is required and must be 160 characters or fewer.",
        });
        return;
      }
      if (duplicateRows.has(index)) {
        rowResults.push({
          row: index + 2,
          name,
          status: "ambiguous",
          reason: "The sheet contains this stop name more than once.",
        });
        return;
      }
      const identifiedStop = stopId ? byId.get(stopId) : null;
      if (stopId && !identifiedStop) {
        rowResults.push({
          row: index + 2,
          name,
          status: "not_found",
          reason: "Stop ID does not match Stop Master.",
        });
        return;
      }
      if (
        identifiedStop &&
        normalizeStopName(identifiedStop.name) !== key
      ) {
        rowResults.push({
          row: index + 2,
          name,
          status: "invalid",
          reason: "The stop name does not match the supplied Stop ID.",
        });
        return;
      }
      const matches = identifiedStop
        ? [identifiedStop]
        : byName.get(key) || [];
      if (!matches.length) {
        rowResults.push({
          row: index + 2,
          name,
          status: "not_found",
          reason: "Stop name does not match Stop Master.",
        });
        return;
      }
      if (matches.length > 1) {
        rowResults.push({
          row: index + 2,
          name,
          status: "ambiguous",
          reason: "This name matches multiple Stop Master entries.",
        });
        return;
      }
      if (!hasLatitude && !hasLongitude) {
        rowResults.push({ row: index + 2, name, status: "missing_coordinates" });
        return;
      }

      const latitude = Number(rawLatitude);
      const longitude = Number(rawLongitude);
      if (
        !hasLatitude ||
        !hasLongitude ||
        !validCoordinates(latitude, longitude)
      ) {
        rowResults.push({
          row: index + 2,
          name,
          status: "invalid",
          reason: "Both coordinate values must be valid (X = longitude, Y = latitude).",
        });
        return;
      }

      for (const match of matches) {
        operations.push({
          updateOne: {
            filter: { stopId: match.stopId },
            update: {
              $set: {
                latitude,
                longitude,
                source: "ADMIN",
                status: "VERIFIED",
                verifiedBy: req.user.id,
                verifiedAt: new Date(),
              },
            },
          },
        });
      }
      rowResults.push({ row: index + 2, name, status: "updated" });
    });

    if (operations.length) {
      await StopMaster.bulkWrite(operations);
      getIO()?.emit("bus-update", {
        actionType: "STOP_COORDINATES_UPDATED",
        count: operations.length,
      });
    }
    const summary = {
      totalRows: rows.length,
      updated: operations.length,
      missingCoordinates: rowResults.filter(
        (row) => row.status === "missing_coordinates",
      ).length,
      notFound: rowResults.filter((row) => row.status === "not_found").length,
      ambiguous: rowResults.filter((row) => row.status === "ambiguous").length,
      invalid: rowResults.filter((row) => row.status === "invalid").length,
    };
    return res.json({ success: true, summary, rowResults });
  } catch (error) {
    console.error("importCoordinates error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to import stop coordinates.",
    });
  }
}

module.exports = { getCoordinateSheet, importCoordinates };
