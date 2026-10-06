const normalizeStopName = require("./normalizeStopName");

function hasCoordinates(stop) {
  const latitude = Number(stop.latitude);
  const longitude = Number(stop.longitude);
  return (
    stop.latitude != null &&
    stop.longitude != null &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function uniqueStopCoordinateRows(stops) {
  const uniqueStops = new Map();
  for (const stop of stops) {
    const key = normalizeStopName(stop.name);
    const current = uniqueStops.get(key);
    const currentHasCoordinates = current ? hasCoordinates(current) : false;
    const stopHasCoordinates = hasCoordinates(stop);
    if (
      !current ||
      (stopHasCoordinates && !currentHasCoordinates) ||
      (stopHasCoordinates === currentHasCoordinates &&
        stop.status === "VERIFIED" &&
        current.status !== "VERIFIED")
    ) {
      uniqueStops.set(key, stop);
    }
  }
  return [...uniqueStops.values()];
}

module.exports = uniqueStopCoordinateRows;
