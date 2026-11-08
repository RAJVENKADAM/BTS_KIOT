const DEFAULT_GPS_OFFLINE_THRESHOLD_MS = 3 * 60 * 1000;
const ROUTE_REFRESH_DISTANCE_METERS = 100;
const SOCKET_RECOVERY_BASE_DELAY_MS = 5_000;
const SOCKET_RECOVERY_MAX_DELAY_MS = 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_BUFFERED_LOCATION_CANDIDATES = 16;

function hasValidGpsCoordinates(data) {
  if (
    data?.latitude == null ||
    data?.longitude == null ||
    data.latitude === "" ||
    data.longitude === ""
  ) {
    return false;
  }
  const latitude = Number(data.latitude);
  const longitude = Number(data.longitude);
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function getGpsFreshnessDelay(data, now = Date.now()) {
  const timestamp = Date.parse(data?.lastSuccessfulGpsUpdate);
  if (!Number.isFinite(timestamp)) return 0;

  const configuredThreshold = Number(data?.gpsOfflineThresholdMs);
  const threshold =
    Number.isFinite(configuredThreshold) && configuredThreshold > 0
      ? configuredThreshold
      : DEFAULT_GPS_OFFLINE_THRESHOLD_MS;
  return Math.min(
    MAX_TIMEOUT_MS,
    Math.max(0, timestamp + threshold - now + 1),
  );
}

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

function normalizeLocationVersion(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const version = String(value);
  if (!/^\d+$/.test(version)) return null;
  return version.replace(/^0+(?=\d)/, "");
}

function compareLocationVersions(left, right) {
  const normalizedLeft = normalizeLocationVersion(left);
  const normalizedRight = normalizeLocationVersion(right);
  if (normalizedLeft === null || normalizedRight === null) return null;
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length < normalizedRight.length ? -1 : 1;
  }
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
}

function getLocationOrder(location) {
  return {
    version: normalizeLocationVersion(location?.locationVersion),
    providerTimestamp: Date.parse(location?.providerTimestamp),
    timestamp: Date.parse(location?.lastSuccessfulGpsUpdate),
  };
}

function hasKnownLocationOrder(order) {
  return Boolean(
    normalizeLocationVersion(order?.version) !== null ||
      Number.isFinite(order?.providerTimestamp) ||
      Number.isFinite(order?.timestamp),
  );
}

function isIncomingLocationOlder(incoming, currentOrder) {
  const current =
    currentOrder && typeof currentOrder === "object"
      ? currentOrder
      : { timestamp: Number(currentOrder) };
  const incomingVersion = normalizeLocationVersion(incoming?.locationVersion);
  const currentVersion = normalizeLocationVersion(current.version);
  if (currentVersion !== null) {
    if (incomingVersion === null) return true;
    return compareLocationVersions(incomingVersion, currentVersion) <= 0;
  }
  if (incomingVersion !== null) return false;

  const incomingProviderTimestamp = Date.parse(incoming?.providerTimestamp);
  if (Number.isFinite(current.providerTimestamp)) {
    return (
      !Number.isFinite(incomingProviderTimestamp) ||
      incomingProviderTimestamp <= current.providerTimestamp
    );
  }
  const currentTimestamp = Number(current.timestamp);
  if (!Number.isFinite(currentTimestamp)) return false;
  const incomingTimestamp = Date.parse(incoming?.lastSuccessfulGpsUpdate);
  return (
    !Number.isFinite(incomingTimestamp) ||
    incomingTimestamp < currentTimestamp
  );
}

function isStrictlyNewerLocation(incoming, current) {
  const incomingOrder = getLocationOrder(incoming);
  const currentOrder = getLocationOrder(current);
  const incomingVersion = normalizeLocationVersion(incomingOrder.version);
  const currentVersion = normalizeLocationVersion(currentOrder.version);

  if (incomingVersion !== null && currentVersion !== null) {
    return compareLocationVersions(incomingVersion, currentVersion) > 0;
  }
  if (currentVersion !== null) return false;
  if (incomingVersion !== null) return true;

  if (
    Number.isFinite(incomingOrder.providerTimestamp) &&
    Number.isFinite(currentOrder.providerTimestamp)
  ) {
    return incomingOrder.providerTimestamp > currentOrder.providerTimestamp;
  }
  if (
    Number.isFinite(incomingOrder.timestamp) &&
    Number.isFinite(currentOrder.timestamp)
  ) {
    return incomingOrder.timestamp > currentOrder.timestamp;
  }
  return false;
}

function createGpsLocationReconciler() {
  let selectionKey = null;
  let generation = 0;
  let latestLocation = null;
  let snapshotPending = false;
  let bufferedLocations = new Map();

  function select(nextSelectionKey) {
    if (selectionKey === nextSelectionKey) return generation;
    selectionKey = nextSelectionKey || null;
    generation += 1;
    latestLocation = null;
    snapshotPending = Boolean(selectionKey);
    bufferedLocations = new Map();
    return generation;
  }

  function beginSnapshot(key = selectionKey) {
    if (!key || key !== selectionKey) return null;
    snapshotPending = true;
    return generation;
  }

  function acceptLive(key, location) {
    if (!key || key !== selectionKey || !location) {
      return { accepted: false, location: latestLocation };
    }
    if (latestLocation) {
      if (!hasKnownLocationOrder(getLocationOrder(location))) {
        return { accepted: false, location: latestLocation };
      }
      if (!isStrictlyNewerLocation(location, latestLocation)) {
        return { accepted: false, location: latestLocation };
      }
    } else if (!hasKnownLocationOrder(getLocationOrder(location))) {
      return { accepted: false, location: null };
    }
    latestLocation = location;
    return { accepted: true, location: latestLocation };
  }

  function bufferLive(key, location) {
    if (
      !key ||
      key !== selectionKey ||
      !snapshotPending ||
      !location ||
      !hasKnownLocationOrder(getLocationOrder(location))
    ) {
      return false;
    }
    const identity = String(
      location.previewNumber ?? location.busNo ?? location.bus_no ?? "",
    );
    if (!identity) return false;
    const current = bufferedLocations.get(identity);
    if (current && !isStrictlyNewerLocation(location, current)) return false;
    bufferedLocations.set(identity, location);
    if (bufferedLocations.size > MAX_BUFFERED_LOCATION_CANDIDATES) {
      bufferedLocations.delete(bufferedLocations.keys().next().value);
    }
    return true;
  }

  function reconcileSnapshot(key, snapshot, expectedGeneration = generation) {
    if (
      !key ||
      key !== selectionKey ||
      expectedGeneration !== generation ||
      !snapshot
    ) {
      return { accepted: false, location: latestLocation };
    }
    const snapshotIsNewer =
      !latestLocation || isStrictlyNewerLocation(snapshot, latestLocation);
    let newestLocation = snapshotIsNewer ? snapshot : latestLocation;
    let newestFromBufferedLive = false;
    const [selectionType, selectionValue] = key.split(":", 2);
    const selectedBusNo =
      selectionType === "bus" ? selectionValue : null;
    const selectedPreview =
      selectionType === "preview" ? selectionValue : null;
    for (const candidate of bufferedLocations.values()) {
      if (
        isLocationForSelection(
          candidate,
          selectedBusNo,
          selectedPreview,
          snapshot,
          true,
        ) &&
        isStrictlyNewerLocation(candidate, newestLocation)
      ) {
        newestLocation = {
          ...snapshot,
          ...candidate,
          busNo: candidate.busNo ?? candidate.bus_no ?? snapshot.busNo ?? snapshot.bus_no,
          bus_no: candidate.bus_no ?? snapshot.bus_no,
          previewNumber: candidate.previewNumber ?? snapshot.previewNumber,
        };
        newestFromBufferedLive = true;
      }
    }
    if (!snapshotIsNewer && !newestFromBufferedLive) {
      snapshotPending = false;
      bufferedLocations = new Map();
      return { accepted: false, location: latestLocation };
    }
    latestLocation = newestLocation;
    snapshotPending = false;
    bufferedLocations = new Map();
    return {
      accepted: true,
      location: latestLocation,
      fromBufferedLive: newestFromBufferedLive,
    };
  }

  function invalidate() {
    selectionKey = null;
    generation += 1;
    latestLocation = null;
    snapshotPending = false;
    bufferedLocations = new Map();
  }

  return {
    acceptLive,
    bufferLive,
    beginSnapshot,
    getState: () => ({
      generation,
      latestLocation,
      selectionKey,
      snapshotPending,
    }),
    invalidate,
    reconcileSnapshot,
    select,
  };
}

function isLocationForSelection(
  data,
  selectedBusNo,
  selectedPreviewNumber,
  busData,
  allowUnresolvedBus = false,
) {
  if ((!selectedBusNo && !selectedPreviewNumber) || !data) {
    return false;
  }
  if (
    busData &&
    (busData.isBusActiveInCurrentPlan === false || busData.notActiveMessage)
  ) {
    return false;
  }

  if (!busData) {
    if (selectedPreviewNumber) {
      return String(data.previewNumber ?? "") === String(selectedPreviewNumber);
    }
    const incomingBusNo = data.busNo ?? data.bus_no ?? data.busNumber;
    if (incomingBusNo) {
      return String(incomingBusNo).trim().toUpperCase() ===
        String(selectedBusNo).trim().toUpperCase();
    }
    return allowUnresolvedBus && Boolean(data.previewNumber);
  }

  const incomingBusNo = data.busNo ?? data.bus_no ?? data.busNumber;

  const expectedPreviewNumbers = [
    selectedPreviewNumber,
    busData.previewNumber,
    busData.preview_number,
    busData.effectivePreviewNumber,
  ]
    .filter(Boolean)
    .map(String);
  if (expectedPreviewNumbers.length) {
    return expectedPreviewNumbers.includes(String(data.previewNumber ?? ""));
  }
  if (incomingBusNo && selectedBusNo) {
    return String(incomingBusNo).trim().toUpperCase() ===
      String(selectedBusNo).trim().toUpperCase();
  }
  return Boolean(!selectedBusNo && data.previewNumber);
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
  getGpsFreshnessDelay,
  getLocationOrder,
  getSocketRecoveryDelay,
  hasKnownLocationOrder,
  hasValidGpsCoordinates,
  isGpsStale,
  isIncomingLocationOlder,
  isLocationForSelection,
  isStrictlyNewerLocation,
  createGpsLocationReconciler,
  normalizeLocationVersion,
  compareLocationVersions,
  shouldRefreshRoute,
};
