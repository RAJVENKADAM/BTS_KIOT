const DEFAULT_GPS_OFFLINE_THRESHOLD_MS = 3 * 60 * 1000;
const ROUTE_REFRESH_DISTANCE_METERS = 100;
const SOCKET_RECOVERY_BASE_DELAY_MS = 5_000;
const SOCKET_RECOVERY_MAX_DELAY_MS = 60_000;

function distanceMeters(pointA, pointB) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const latitudeA = radians(Number(pointA.latitude));
  const latitudeB = radians(Number(pointB.latitude));
  const latitudeDelta = latitudeB - latitudeA;
  const longitudeDelta =
    radians(Number(pointB.longitude) - Number(pointA.longitude));
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeA) *
      Math.cos(latitudeB) *
      Math.sin(longitudeDelta / 2) ** 2;
  const boundedHaversine = Math.max(0, Math.min(1, haversine));
  return (
    2 *
    6371000 *
    Math.atan2(Math.sqrt(boundedHaversine), Math.sqrt(1 - boundedHaversine))
  );
}

function shouldRefreshRoute(previousPoint, nextPoint) {
  return (
    !previousPoint ||
    distanceMeters(previousPoint, nextPoint) >= ROUTE_REFRESH_DISTANCE_METERS
  );
}

function isGpsStale(data, now = Date.now()) {
  if (!data) return true;

  const status = String(data.status || "").toLowerCase();
  if (status === "offline" || data.is_online === false) return true;
  if (status !== "online" && data.is_online !== true) return true;

  const timestamp = Date.parse(data.lastSuccessfulGpsUpdate);
  if (!Number.isFinite(timestamp)) return true;

  const configuredThreshold = Number(data.gpsOfflineThresholdMs);
  const threshold =
    Number.isFinite(configuredThreshold) && configuredThreshold > 0
      ? configuredThreshold
      : DEFAULT_GPS_OFFLINE_THRESHOLD_MS;
  return now - timestamp > threshold;
}

function isIncomingLocationOlder(incoming, currentTimestamp) {
  const current = Number(currentTimestamp);
  if (!Number.isFinite(current)) return false;
  const incomingTimestamp = Date.parse(incoming?.lastSuccessfulGpsUpdate);
  return (
    !Number.isFinite(incomingTimestamp) || incomingTimestamp < current
  );
}

function isLocationForSelection(
  data,
  selectedBusNo,
  selectedPreviewNumber,
  busData,
) {
  if ((!selectedBusNo && !selectedPreviewNumber) || !busData || !data) {
    return false;
  }
  if (
    busData.isBusActiveInCurrentPlan === false ||
    busData.notActiveMessage
  ) {
    return false;
  }

  const incomingBusNo =
    data.busNo ?? data.bus_no ?? data.busNumber ?? data.previewNumber;
  if (!incomingBusNo) return false;

  const expectedPreviewNumbers = [
    selectedPreviewNumber,
    busData.effectivePreviewNumber,
  ]
    .filter(Boolean)
    .map(String);
  return (
    !expectedPreviewNumbers.length ||
    expectedPreviewNumbers.includes(String(data.previewNumber ?? ""))
  );
}

function getSocketRecoveryDelay(attempt, random = Math.random()) {
  const numericAttempt = Number(attempt);
  const normalizedAttempt =
    Number.isFinite(numericAttempt) && numericAttempt > 0
      ? Math.min(Math.floor(numericAttempt), 16)
      : 0;
  const ceiling = Math.min(
    SOCKET_RECOVERY_MAX_DELAY_MS,
    SOCKET_RECOVERY_BASE_DELAY_MS * 2 ** normalizedAttempt,
  );
  const normalizedRandom = Number.isFinite(random)
    ? Math.max(0, Math.min(1, random))
    : 0.5;
  return Math.floor(ceiling * (0.5 + normalizedRandom * 0.5));
}

module.exports = {
  DEFAULT_GPS_OFFLINE_THRESHOLD_MS,
  ROUTE_REFRESH_DISTANCE_METERS,
  SOCKET_RECOVERY_BASE_DELAY_MS,
  SOCKET_RECOVERY_MAX_DELAY_MS,
  distanceMeters,
  getSocketRecoveryDelay,
  isGpsStale,
  isIncomingLocationOlder,
  isLocationForSelection,
  shouldRefreshRoute,
};
