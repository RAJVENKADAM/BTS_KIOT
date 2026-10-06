const StopMaster = require("../models/StopMaster");
const normalizeStopName = require("./normalizeStopName");

const escapeRegExp = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function findVerifiedStop({ stopId, name }) {
  if (stopId) {
    const stop = await StopMaster.findOne({
      stopId: String(stopId),
      status: "VERIFIED",
    }).lean();
    return { stop, ambiguous: false };
  }

  const normalizedName = String(name || "").trim().replace(/\s+/g, " ");
  if (!normalizedName) return { stop: null, ambiguous: false };
  const exact = new RegExp(`^${escapeRegExp(normalizedName)}$`, "i");
  const found = await StopMaster.find({
    status: "VERIFIED",
    $or: [{ name: exact }, { aliases: exact }],
  })
    .limit(10)
    .lean();
  const matches = found.filter(
    (stop) =>
      normalizeStopName(stop.name) === normalizeStopName(normalizedName) ||
      (stop.aliases || []).some(
        (alias) =>
          normalizeStopName(alias) === normalizeStopName(normalizedName),
      ),
  );
  return {
    stop: matches.length === 1 ? matches[0] : null,
    ambiguous: matches.length > 1,
  };
}

module.exports = findVerifiedStop;
