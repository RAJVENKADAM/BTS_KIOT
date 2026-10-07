const { randomUUID } = require("crypto");
const StopMaster = require("../models/StopMaster");
const { getIO } = require("../socket");
const normalizeStopName = require("../utils/normalizeStopName");
const uniqueStopCoordinateRows = require("../utils/uniqueStopCoordinateRows");
const buildStopCoordinateOperations = require("../utils/buildStopCoordinateOperations");

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
      .select("stopId name aliases")
      .lean();
    const byName = new Map();
    const byId = new Map(knownStops.map((stop) => [stop.stopId, stop]));
    for (const stop of knownStops) {
      const key = normalizeStopName(stop.name);
      byName.set(key, [...(byName.get(key) || []), stop]);
    }

    const importedStops = [];
    const rowIndexesByName = new Map();
    const rowResults = [];
    rows.forEach((row, index) => {
      const name = String(row?.name || "").trim().replace(/\s+/g, " ");
      const key = normalizeStopName(name);
      const rawLatitude = row?.latitude;
      const rawLongitude = row?.longitude;
      const hasLatitude = String(rawLatitude ?? "").trim() !== "";
      const hasLongitude = String(rawLongitude ?? "").trim() !== "";
      const stopId = String(row?.stopId || "").trim();
      const normalizedName = normalizeStopName(name);

      if (!name || name.length > 160) {
        rowResults.push({
          row: index + 2,
          name,
          status: "invalid",
          reason: "Stop name is required and must be 160 characters or fewer.",
        });
        return;
      }
      if (rowIndexesByName.has(normalizedName)) {
        rowResults.push({
          row: index + 2,
          name,
          status: "ambiguous",
          reason: "The sheet contains this stop name more than once.",
        });
        return;
      }
      rowIndexesByName.set(normalizedName, index);

      const identifiedStop = stopId ? byId.get(stopId) : null;
      if (stopId && !identifiedStop) {
        rowResults.push({
          row: index + 2,
          name,
          status: "not_found",
          reason: "Stop ID does not match Stop Master. Download a fresh sheet and retry.",
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
      if (matches.length > 1) {
        rowResults.push({
          row: index + 2,
          name,
          status: "ambiguous",
          reason: "This name matches multiple Stop Master entries.",
        });
        return;
      }

      if (hasLatitude !== hasLongitude) {
        rowResults.push({
          row: index + 2,
          name,
          status: "invalid",
          reason: "Provide both latitude and longitude, or leave both blank.",
        });
        return;
      }

      const latitude = hasLatitude ? Number(rawLatitude) : null;
      const longitude = hasLongitude ? Number(rawLongitude) : null;
      if (hasLatitude && !validCoordinates(latitude, longitude)) {
        rowResults.push({
          row: index + 2,
          name,
          status: "invalid",
          reason: "Latitude must be between -90 and 90 and longitude between -180 and 180.",
        });
        return;
      }

      const matchedStop = matches[0];
      importedStops.push({
        stopId: matchedStop?.stopId || `STOP-${randomUUID()}`,
        name,
        latitude,
        longitude,
      });
      rowResults.push({
        row: index + 2,
        name,
        status: hasLatitude ? "updated" : "missing_coordinates",
      });
    });

    const invalidRows = rowResults.filter((row) =>
      ["invalid", "ambiguous", "not_found"].includes(row.status),
    );
    if (invalidRows.length) {
      const rowDetails = invalidRows
        .slice(0, 5)
        .map(
          (row) =>
            `Row ${row.row} (${row.name || "unnamed"}): ${row.reason || row.status}`,
        )
        .join("\n");
      return res.status(400).json({
        success: false,
        error: `The stop sheet has invalid rows; no database records were changed.\n${rowDetails}`,
        rowResults,
      });
    }
    if (!importedStops.length || !importedStops.some((stop) => stop.latitude != null)) {
      return res.status(400).json({
        success: false,
        error: "The sheet must contain at least one stop with valid coordinates; no database records were changed.",
      });
    }

    const operations = buildStopCoordinateOperations(
      importedStops,
      req.user.id,
      new Date(),
    );
    await StopMaster.bulkWrite(operations);
    const importedStopIds = importedStops.map((stop) => stop.stopId);
    const removed = knownStops.filter(
      (stop) => !importedStopIds.includes(stop.stopId),
    ).length;
    await StopMaster.deleteMany({ stopId: { $nin: importedStopIds } });
    getIO()?.emit("bus-update", {
      actionType: "STOP_COORDINATES_UPDATED",
      count: importedStops.filter((stop) => stop.latitude != null).length,
      removed,
    });

    const summary = {
      totalRows: rows.length,
      updated: importedStops.filter((stop) => stop.latitude != null).length,
      added: importedStops.filter((stop) => !byId.has(stop.stopId)).length,
      removed,
      missingCoordinates: rowResults.filter(
        (row) => row.status === "missing_coordinates",
      ).length,
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
