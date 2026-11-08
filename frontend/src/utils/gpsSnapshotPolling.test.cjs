const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DEFAULT_GPS_SNAPSHOT_INTERVAL_MS,
  MAX_GPS_SNAPSHOT_INTERVAL_MS,
  MIN_GPS_SNAPSHOT_INTERVAL_MS,
  createGpsSnapshotPoller,
  getGpsSnapshotDelay,
  getGpsSnapshotIntervalMs,
} = require("./gpsSnapshotPolling.cjs");
const { createGpsLocationReconciler } = require("./gpsLocationPolicy.cjs");

function createFakeTimers() {
  let nextId = 0;
  const jobs = new Map();
  return {
    clearTimeout(id) {
      jobs.delete(id);
    },
    runNext() {
      const first = jobs.entries().next().value;
      if (!first) return false;
      const [id, job] = first;
      jobs.delete(id);
      job.callback();
      return true;
    },
    setTimeout(callback, delay) {
      const id = ++nextId;
      jobs.set(id, { callback, delay });
      return id;
    },
    get size() {
      return jobs.size;
    },
    get delays() {
      return [...jobs.values()].map(({ delay }) => delay);
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("snapshot polling uses a configurable bounded interval with jitter", () => {
  assert.equal(getGpsSnapshotIntervalMs(undefined), DEFAULT_GPS_SNAPSHOT_INTERVAL_MS);
  assert.equal(getGpsSnapshotIntervalMs(1), MIN_GPS_SNAPSHOT_INTERVAL_MS);
  assert.equal(getGpsSnapshotIntervalMs(999_999), MAX_GPS_SNAPSHOT_INTERVAL_MS);
  assert.equal(getGpsSnapshotDelay(60_000, () => 0), 48_000);
  assert.equal(getGpsSnapshotDelay(60_000, () => 1), 72_000);
});

test("a connected client that misses an event recovers the latest state from a periodic snapshot", async () => {
  const timers = createFakeTimers();
  const reconciler = createGpsLocationReconciler();
  const selection = "bus:BUS-4";
  reconciler.select(selection);
  const snapshots = [
    {
      busNo: "BUS-4",
      locationVersion: "4",
      providerTimestamp: "2026-11-07T08:00:04Z",
      latitude: 11,
      longitude: 78,
    },
  ];
  const poller = createGpsSnapshotPoller({
    intervalMs: 60_000,
    random: () => 0.5,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    async request(key) {
      const generation = reconciler.beginSnapshot(key);
      const snapshot = snapshots.shift();
      const result = reconciler.reconcileSnapshot(key, snapshot, generation);
      assert.equal(result.accepted, true);
    },
  });
  poller.start(selection);

  assert.equal(timers.runNext(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reconciler.getState().latestLocation.locationVersion, "4");
  assert.equal(timers.size, 1);
  poller.stop();
});

test("an older periodic snapshot cannot replace a newer live socket event", async () => {
  const timers = createFakeTimers();
  const reconciler = createGpsLocationReconciler();
  const selection = "bus:BUS-4";
  reconciler.select(selection);
  const generation = reconciler.beginSnapshot(selection);
  const poller = createGpsSnapshotPoller({
    intervalMs: 60_000,
    random: () => 0.5,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    async request(key) {
      const snapshotGeneration = reconciler.beginSnapshot(key);
      const result = reconciler.reconcileSnapshot(
        key,
        {
          locationVersion: "8",
          providerTimestamp: "2026-11-07T08:00:08Z",
          latitude: 8,
          longitude: 78,
        },
        snapshotGeneration,
      );
      assert.equal(result.accepted, false);
    },
  });
  reconciler.acceptLive(selection, {
    locationVersion: "9",
    providerTimestamp: "2026-11-07T08:00:09Z",
    latitude: 9,
    longitude: 78,
  });
  poller.start(selection);
  assert.equal(timers.runNext(), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(reconciler.getState().latestLocation.locationVersion, "9");
  assert.equal(reconciler.getState().latestLocation.latitude, 9);
  assert.notEqual(generation, null);
  poller.stop();
});

test("overlapping snapshot requests are suppressed until the active request settles", async () => {
  const timers = createFakeTimers();
  const request = deferred();
  let requestCount = 0;
  const poller = createGpsSnapshotPoller({
    intervalMs: 60_000,
    random: () => 0.5,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    request() {
      requestCount++;
      return request.promise;
    },
  });
  poller.start("bus:BUS-4");
  const firstRefresh = poller.refreshNow();
  assert.equal(await poller.refreshNow(), false);
  assert.equal(requestCount, 1);
  request.resolve();
  assert.equal(await firstRefresh, true);
  assert.equal(timers.size, 1);
  poller.stop();
});

for (const lifecycle of ["blur", "unmount"]) {
  test(`snapshot polling stops on ${lifecycle}`, async () => {
    const timers = createFakeTimers();
    let requestCount = 0;
    const poller = createGpsSnapshotPoller({
      intervalMs: 60_000,
      random: () => 0.5,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      async request() {
        requestCount++;
      },
    });
    poller.start("bus:BUS-4");
    poller.stop();
    assert.equal(timers.size, 0);
    assert.equal(timers.runNext(), false);
    assert.equal(requestCount, 0);
  });
}

test("changing the selected bus cancels its timer and polls only the new bus", async () => {
  const timers = createFakeTimers();
  const requestedBuses = [];
  const poller = createGpsSnapshotPoller({
    intervalMs: 60_000,
    random: () => 0.5,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    async request(key) {
      requestedBuses.push(key);
    },
  });
  poller.start("bus:BUS-4");
  poller.start("preview:5");
  assert.equal(timers.size, 1);
  assert.equal(timers.runNext(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requestedBuses, ["preview:5"]);
  poller.stop();
});

test("changing buses during an in-flight request resumes polling the new selection", async () => {
  const timers = createFakeTimers();
  const firstRequest = deferred();
  const requestedBuses = [];
  const poller = createGpsSnapshotPoller({
    intervalMs: 60_000,
    random: () => 0.5,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    request(key) {
      requestedBuses.push(key);
      return key === "bus:BUS-4" ? firstRequest.promise : Promise.resolve();
    },
  });
  poller.start("bus:BUS-4");
  const firstRefresh = poller.refreshNow();
  poller.start("preview:5");

  assert.equal(timers.runNext(), true);
  assert.deepEqual(requestedBuses, ["bus:BUS-4"]);
  assert.equal(timers.size, 1);
  firstRequest.resolve();
  await firstRefresh;
  assert.equal(timers.runNext(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requestedBuses, ["bus:BUS-4", "preview:5"]);
  poller.stop();
});
