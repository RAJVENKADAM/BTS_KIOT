const DEFAULT_GPS_SNAPSHOT_INTERVAL_MS = 60_000;
const MIN_GPS_SNAPSHOT_INTERVAL_MS = 30_000;
const MAX_GPS_SNAPSHOT_INTERVAL_MS = 300_000;
const GPS_SNAPSHOT_JITTER_RATIO = 0.2;

function getGpsSnapshotIntervalMs(value = process.env.EXPO_PUBLIC_GPS_SNAPSHOT_INTERVAL_MS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_GPS_SNAPSHOT_INTERVAL_MS;
  }
  return Math.min(
    MAX_GPS_SNAPSHOT_INTERVAL_MS,
    Math.max(MIN_GPS_SNAPSHOT_INTERVAL_MS, Math.floor(parsed)),
  );
}

function getGpsSnapshotDelay(intervalMs, random = Math.random) {
  const interval = getGpsSnapshotIntervalMs(intervalMs);
  const sample = Number(random());
  const boundedSample = Number.isFinite(sample)
    ? Math.max(0, Math.min(1, sample))
    : 0.5;
  const jitter = (boundedSample * 2 - 1) * GPS_SNAPSHOT_JITTER_RATIO;
  return Math.round(interval * (1 + jitter));
}

function createGpsSnapshotPoller({
  request,
  intervalMs,
  random = Math.random,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (typeof request !== "function") {
    throw new TypeError("GPS snapshot polling requires a request function.");
  }

  let selectedKey = null;
  let generation = 0;
  let timer = null;
  let requestInFlight = false;

  function schedule() {
    if (selectedKey === null || timer !== null) return;
    timer = setTimeoutFn(() => {
      timer = null;
      void refreshNow();
    }, getGpsSnapshotDelay(intervalMs, random));
  }

  async function refreshNow() {
    if (selectedKey === null) return false;
    if (requestInFlight) {
      schedule();
      return false;
    }
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }

    const requestKey = selectedKey;
    const requestGeneration = generation;
    requestInFlight = true;
    try {
      await request(requestKey);
      return true;
    } finally {
      requestInFlight = false;
      if (
        selectedKey === requestKey &&
        generation === requestGeneration
      ) {
        schedule();
      }
    }
  }

  function start(key) {
    stop();
    if (typeof key !== "string" || key.length === 0) return;
    selectedKey = key;
    generation += 1;
    schedule();
  }

  function stop() {
    generation += 1;
    selectedKey = null;
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  return {
    refreshNow,
    start,
    stop,
  };
}

module.exports = {
  DEFAULT_GPS_SNAPSHOT_INTERVAL_MS,
  MAX_GPS_SNAPSHOT_INTERVAL_MS,
  MIN_GPS_SNAPSHOT_INTERVAL_MS,
  createGpsSnapshotPoller,
  getGpsSnapshotDelay,
  getGpsSnapshotIntervalMs,
};
