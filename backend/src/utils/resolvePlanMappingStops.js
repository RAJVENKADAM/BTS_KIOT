const StopMaster = require("../models/StopMaster");
const normalizeStopName = require("./normalizeStopName");

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function resolvePlanMappingStops(inputs) {
  const stopIds = [
    ...new Set(inputs.map((input) => String(input?.stopId || "").trim()).filter(Boolean)),
  ];
  const names = [
    ...new Set(inputs.map((input) => String(input?.stopName || "").trim()).filter(Boolean)),
  ];
  const namePatterns = names.map(
    (name) => new RegExp(`^${escapeRegExp(name)}$`, "i"),
  );
  const conditions = [
    ...(stopIds.length ? [{ stopId: { $in: stopIds } }] : []),
    {
      status: "VERIFIED",
      $or: [
        { name: { $in: namePatterns } },
        { aliases: { $in: namePatterns } },
      ],
    },
    { status: "PENDING", name: { $in: namePatterns } },
  ];
  const stops = await StopMaster.find({ $or: conditions })
    .select("stopId name aliases status")
    .lean();
  const stopsById = new Map(stops.map((stop) => [stop.stopId, stop]));

  return inputs.map((input) => {
    const stopName = String(input?.stopName || "").trim();
    const stopId = String(input?.stopId || "").trim();
    if (stopId) {
      const stop = stopsById.get(stopId);
      return {
        stop:
          stop && stop.name.trim().toLowerCase() === stopName.toLowerCase()
            ? stop
            : null,
        ambiguous: false,
      };
    }

    const normalizedName = normalizeStopName(stopName);
    const verifiedMatches = stops.filter(
      (stop) =>
        stop.status === "VERIFIED" &&
        (normalizeStopName(stop.name) === normalizedName ||
          (stop.aliases || []).some(
            (alias) => normalizeStopName(alias) === normalizedName,
          )),
    );
    if (verifiedMatches.length === 1) {
      return { stop: verifiedMatches[0], ambiguous: false };
    }
    if (verifiedMatches.length > 1) {
      return { stop: null, ambiguous: true };
    }

    return {
      stop:
        stops.find(
          (stop) => stop.status === "PENDING" && stop.name === stopName,
        ) || null,
      ambiguous: false,
    };
  });
}

module.exports = resolvePlanMappingStops;
