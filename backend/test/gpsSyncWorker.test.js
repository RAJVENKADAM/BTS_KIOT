const assert = require("node:assert/strict");
const test = require("node:test");
const axios = require("axios");
const BusLiveLocation = require("../src/models/BusLiveLocation");
const gpsService = require("../src/services/gpsService");
const {
  GPS_SYNC_INTERVAL_MS,
  GpsSyncWorker,
  buildUsersByBus,
  getBusLocation,
} = require("../src/workers/gpsSyncWorker");

function query(result) {
  return {
    select() {
      return this;
    },
    lean: async () => result,
  };
}

function createWorker({
  buses = [],
  users = [],
  locations = [],
  provider,
  update,
  busFind,
  userFind,
  socketGetter = () => null,
  timers = {},
} = {}) {
  const updates = [];
  let locationReads = 0;
  let locationReadFilter = null;
  const worker = new GpsSyncWorker({
    BusModel: {
      find: busFind || (() => query(buses)),
    },
    UserModel: {
      find: userFind || (() => query(users)),
    },
    LiveLocationModel: {
      find: (filter) => {
        locationReads++;
        locationReadFilter = filter;
        return query(locations);
      },
      updateOne: async (filter, operation, options) => {
        updates.push({ filter, operation, options });
        if (update) await update(filter);
      },
    },
    service: {
      getAllCurrentLocations: provider || (async () => new Map()),
    },
    socketGetter,
    setIntervalFn: timers.setInterval || (() => "timer"),
    clearIntervalFn: timers.clearInterval || (() => {}),
  });
  return {
    worker,
    updates,
    get locationReads() {
      return locationReads;
    },
    get locationReadFilter() {
      return locationReadFilter;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("worker status exposes lifecycle and sanitized latest cycle metrics", async () => {
  const { worker } = createWorker();
  assert.deepEqual(worker.getStatus(), {
    started: false,
    stopping: false,
    syncIntervalMs: GPS_SYNC_INTERVAL_MS,
    activeCycleId: null,
    skippedTimerTicks: 0,
    lastCycle: null,
  });

  test("worker lifecycle continues when console logging throws", async () => {
    const originalLog = console.log;
    const { worker } = createWorker();
    console.log = () => {
      throw new Error("simulated logger failure");
    };
    try {
      worker.start();
      await worker.inFlightCycle;
      assert.equal(worker.started, true);
      assert.equal(worker.getStatus().lastCycle.status, "COMPLETED");
      await worker.stop();
    } finally {
      console.log = originalLog;
    }
  });

  await worker.runCycle();
  const status = worker.getStatus();
  assert.equal(status.started, false);
  assert.equal(status.lastCycle.status, "COMPLETED");
  assert.equal(status.lastCycle.activeBusCount, 0);
  assert.equal("latitude" in status.lastCycle, false);
});

test("uses one fixed 35-second provider request per active cycle and preserves immediate startup polling", async () => {
  let intervalCallback;
  let intervalDelay;
  let intervalCalls = 0;
  let resolveProvider;
  let providerCalls = 0;
  const { worker } = createWorker({
    provider: () => {
      providerCalls++;
      return new Promise((resolve) => {
        resolveProvider = resolve;
      });
    },
    timers: {
      setInterval(callback, delay) {
        intervalCalls++;
        intervalCallback = callback;
        intervalDelay = delay;
        return "gps-timer";
      },
      clearInterval(timer) {
        assert.equal(timer, "gps-timer");
      },
    },
  });

  worker.start();
  worker.start();
  assert.equal(intervalCalls, 1);
  assert.equal(intervalDelay, 35_000);
  assert.equal(GPS_SYNC_INTERVAL_MS, 35_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(providerCalls, 1);

  intervalCallback();
  await worker.runCycle();
  assert.equal(providerCalls, 1);

  let stopped = false;
  const stopping = worker.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  resolveProvider(new Map());
  await stopping;
  assert.equal(stopped, true);

  await worker.runCycle();
  assert.equal(providerCalls, 1);
});

test("provider failure has no immediate retry and the next cycle can recover", async () => {
  const records = [];
  const originalLog = console.log;
  console.log = (line) => records.push(JSON.parse(line));
  let providerCalls = 0;
  const { worker, updates } = createWorker({
    provider: async () => {
      providerCalls++;
      if (providerCalls === 1) throw new Error("provider unavailable");
      return new Map();
    },
    buses: [{ _id: "bus-1", bus_no: "BUS-1" }],
  });

  try {
    await worker.runCycle();
    assert.equal(providerCalls, 1);
    assert.equal(updates.length, 0);
    await worker.runCycle();
    assert.equal(providerCalls, 2);
    assert.equal(updates.length, 1);
  } finally {
    console.log = originalLog;
  }

  const providerFailure = records.find(
    (record) => record.event === "GPS_PROVIDER_REQUEST_FAILED",
  );
  const completed = records.find(
    (record) => record.event === "GPS_CYCLE_COMPLETED",
  );
  assert.ok(providerFailure.cycleId);
  assert.equal(providerFailure.name, "Error");
  assert.equal(providerFailure.code, null);
  assert.equal(completed.cycleId, providerFailure.cycleId);
  assert.equal(completed.failureName, "Error");
  assert.equal(completed.failureCode, null);
  assert.equal(JSON.stringify(records).includes("provider unavailable"), false);
});

test("unusable provider response is reported without changing stored locations", async () => {
  const records = [];
  const originalLog = console.log;
  console.log = (line) => records.push(JSON.parse(line));
  const previous = {
    bus_id: "bus-1",
    latitude: 10,
    longitude: 77,
    is_online: true,
    lastSuccessfulGpsUpdate: new Date(0),
    source: "gps",
  };
  const { worker, updates } = createWorker({
    buses: [{ _id: "bus-1", bus_no: "BUS-1", gps_device_id: "device-1" }],
    locations: [previous],
    provider: async () => null,
  });

  try {
    await worker.runCycle();
  } finally {
    console.log = originalLog;
  }

  const completed = records.find((record) => record.event === "GPS_CYCLE_COMPLETED");
  assert.equal(completed.status, "COMPLETED_WITH_ERRORS");
  assert.equal(completed.providerFailures, 1);
  assert.equal(completed.failureStage, "PROVIDER_RESPONSE");
  assert.equal(updates.length, 0);
});

test("valid empty provider response is not counted as a provider failure", async () => {
  const records = [];
  const originalLog = console.log;
  console.log = (line) => records.push(JSON.parse(line));
  const { worker, updates } = createWorker({
    buses: [{ _id: "bus-1", bus_no: "BUS-1", gps_device_id: "device-1" }],
    provider: async () => new Map(),
  });

  try {
    await worker.runCycle();
  } finally {
    console.log = originalLog;
  }

  const completed = records.find((record) => record.event === "GPS_CYCLE_COMPLETED");
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.providerFailures, 0);
  assert.equal(completed.normalizedProviderRecordCount, 0);
  assert.equal(updates.length, 1);
});

test("one bus write failure does not prevent other buses from being processed", async () => {
  const context = createWorker({
    buses: [
      { _id: "bus-1", bus_no: "BUS-1", gps_device_id: "device-1" },
      { _id: "bus-2", bus_no: "BUS-2", gps_device_id: "device-2" },
    ],
    provider: async () =>
      new Map([
        ["device-1", { latitude: 10, longitude: 77, speed: 1 }],
        ["device-2", { latitude: 11, longitude: 78, speed: 2 }],
      ]),
    update: async (filter) => {
      if (filter.bus_id === "bus-1") throw new Error("write failed");
    },
  });
  const { worker, updates } = context;

  await worker.runCycle();
  assert.equal(updates.length, 2);
  assert.equal(updates[1].filter.bus_id, "bus-2");
  assert.equal(context.locationReads, 1);
  assert.deepEqual(context.locationReadFilter.bus_id.$in, ["bus-1", "bus-2"]);
});

test("failed location persistence emits no event while other buses continue", async () => {
  const emissions = [];
  const pendingRooms = [];
  const socket = {
    to(room) {
      pendingRooms.push(room);
      return this;
    },
    emit(event, payload) {
      emissions.push({ event, payload, rooms: pendingRooms.splice(0) });
      return this;
    },
  };
  const context = createWorker({
    buses: [
      {
        _id: "bus-1",
        bus_no: "BUS-1",
        gps_device_id: "device-1",
        preview_number: "PREVIEW-1",
      },
      {
        _id: "bus-2",
        bus_no: "BUS-2",
        gps_device_id: "device-2",
        preview_number: "PREVIEW-2",
      },
    ],
    provider: async () =>
      new Map([
        ["device-1", { latitude: 10, longitude: 77, speed: 1 }],
        ["device-2", { latitude: 11, longitude: 78, speed: 2 }],
      ]),
    update: async (filter) => {
      if (filter.bus_id === "bus-1") throw new Error("write failed");
    },
    socketGetter: () => socket,
  });

  await context.worker.runCycle();

  assert.equal(context.updates.length, 2);
  assert.equal(context.updates[1].filter.bus_id, "bus-2");
  assert.equal(emissions.length, 1);
  assert.equal(emissions[0].event, "locationUpdate");
  assert.equal(emissions[0].payload.previewNumber, "PREVIEW-2");
  assert.deepEqual(emissions[0].rooms, ["preview_PREVIEW-2"]);
});

test("starts bus and student reads independently and waits for both before location reads and writes", async () => {
  const pendingBuses = deferred();
  const pendingUsers = deferred();
  const startedReads = [];
  let locationReads = 0;
  let writes = 0;
  const worker = new GpsSyncWorker({
    BusModel: {
      find: (filter) => {
        startedReads.push("buses");
        assert.deepEqual(filter, { status: "active" });
        return query(pendingBuses.promise);
      },
    },
    UserModel: {
      find: (filter) => {
        startedReads.push("users");
        assert.deepEqual(filter, {
          role: "student",
          is_active: true,
          bus_no: { $nin: [null, ""] },
        });
        return query(pendingUsers.promise);
      },
    },
    LiveLocationModel: {
      find: () => {
        locationReads++;
        return query([]);
      },
      updateOne: async () => {
        writes++;
      },
    },
    service: { getAllCurrentLocations: async () => new Map() },
    socketGetter: () => null,
  });

  const cycle = worker.runCycle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(startedReads, ["buses", "users"]);
  assert.equal(locationReads, 0);
  assert.equal(writes, 0);

  pendingBuses.resolve([{ _id: "bus-1", bus_no: "BUS-1" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(locationReads, 0);
  assert.equal(writes, 0);

  pendingUsers.resolve([{ _id: "student-1", bus_no: "BUS-1" }]);
  await cycle;
  assert.equal(locationReads, 1);
  assert.equal(writes, 1);
});

for (const failingRead of ["buses", "users"]) {
  test(`${failingRead} read failure prevents writes and a subsequent cycle recovers`, async () => {
    let readAttempts = 0;
    const updates = [];
    let locationReads = 0;
    const failOnce = (result) => {
      readAttempts++;
      return query(
        readAttempts === 1
          ? Promise.reject(new Error(`${failingRead} read failed`))
          : result,
      );
    };
    const worker = new GpsSyncWorker({
      BusModel: {
        find: () =>
          failingRead === "buses"
            ? failOnce([{ _id: "bus-1" }])
            : query([{ _id: "bus-1" }]),
      },
      UserModel: {
        find: () => (failingRead === "users" ? failOnce([]) : query([])),
      },
      LiveLocationModel: {
        find: () => {
          locationReads++;
          return query([]);
        },
        updateOne: async (...args) => updates.push(args),
      },
      service: { getAllCurrentLocations: async () => new Map() },
      socketGetter: () => null,
    });

    await assert.rejects(worker.runCycle(), new RegExp(`${failingRead} read failed`));
    assert.equal(locationReads, 0);
    assert.equal(updates.length, 0);

    await worker.runCycle();
    assert.equal(locationReads, 1);
    assert.equal(updates.length, 1);
  });
}

test("a failed read keeps the cycle locked until the other read settles", async () => {
  const pendingUsers = deferred();
  let busReadAttempts = 0;
  let userReadAttempts = 0;
  let providerCalls = 0;
  let writes = 0;
  const worker = new GpsSyncWorker({
    BusModel: {
      find: () => {
        busReadAttempts++;
        return query(
          busReadAttempts === 1
            ? Promise.reject(new Error("bus read failed"))
            : [{ _id: "bus-1" }],
        );
      },
    },
    UserModel: {
      find: () => {
        userReadAttempts++;
        return query(userReadAttempts === 1 ? pendingUsers.promise : []);
      },
    },
    LiveLocationModel: {
      find: () => query([]),
      updateOne: async () => {
        writes++;
      },
    },
    service: {
      getAllCurrentLocations: async () => {
        providerCalls++;
        return new Map();
      },
    },
    socketGetter: () => null,
  });

  let cycleSettled = false;
  const failedCycle = worker.runCycle().finally(() => {
    cycleSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cycleSettled, false);
  assert.equal(worker.syncLock, true);

  await worker.runCycle();
  assert.equal(providerCalls, 1);
  assert.equal(writes, 0);

  pendingUsers.resolve([]);
  await assert.rejects(failedCycle, /bus read failed/);
  assert.equal(worker.syncLock, false);

  await worker.runCycle();
  assert.equal(providerCalls, 2);
  assert.equal(writes, 1);
});

test("cycle observability reports timings, counts, failures, and skipped ticks without GPS data", async () => {
  const pendingProvider = deferred();
  const records = [];
  const originalLog = console.log;
  console.log = (line) => records.push(JSON.parse(line));
  const { worker, updates } = createWorker({
    buses: [
      { _id: "bus-1", bus_no: "BUS-1", gps_device_id: "device-1" },
      { _id: "bus-2", bus_no: "BUS-2", gps_device_id: "device-2" },
    ],
    users: [
      { _id: "student-1", bus_no: "BUS-1" },
      { _id: "student-2", bus_no: "BUS-1" },
      { _id: "student-3", bus_no: "BUS-2" },
    ],
    provider: () => pendingProvider.promise,
    update: async (filter) => {
      if (filter.bus_id === "bus-2") {
        const error = new Error("write failed");
        error.code = "WRITE_FAILED";
        throw error;
      }
    },
  });

  try {
    const cycle = worker.runCycle();
    await new Promise((resolve) => setImmediate(resolve));
    await worker.runCycle();

    pendingProvider.resolve(
      new Map([
        ["device-1", { latitude: 10, longitude: 77, speed: 1 }],
        ["device-2", { latitude: 11, longitude: 78, speed: 2 }],
      ]),
    );
    await cycle;
  } finally {
    console.log = originalLog;
  }

  const completed = records.find((record) => record.event === "GPS_CYCLE_COMPLETED");
  const skipped = records.find((record) => record.event === "GPS_CYCLE_SKIPPED");
  assert.ok(completed);
  assert.ok(skipped);
  assert.equal(completed.status, "COMPLETED_WITH_ERRORS");
  assert.equal(completed.activeBusCount, 2);
  assert.equal(completed.assignedStudentCount, 3);
  assert.equal(completed.normalizedProviderRecordCount, 2);
  assert.equal(completed.successfulWrites, 1);
  assert.equal(completed.failedWrites, 1);
  assert.equal(completed.skippedTimerTicks, 1);
  assert.equal(skipped.skippedTimerTicks, 1);
  for (const field of [
    "durationMs",
    "providerDurationMs",
    "busQueryDurationMs",
    "studentQueryDurationMs",
    "locationReadDurationMs",
    "locationWriteDurationMs",
  ]) {
    assert.ok(Number.isFinite(completed[field]));
    assert.ok(completed[field] >= 0);
  }
  assert.ok(Date.parse(completed.completedAt) >= Date.parse(completed.startedAt));
  assert.equal(updates.length, 2);
  assert.equal(JSON.stringify(records).includes("latitude"), false);
  assert.equal(JSON.stringify(records).includes("longitude"), false);
});

test("GPS synchronization continues when structured logging throws", async () => {
  const originalLog = console.log;
  const { worker, updates } = createWorker({
    buses: [{ _id: "bus-1", bus_no: "BUS-1" }],
  });
  console.log = () => {
    throw new Error("logger unavailable");
  };

  try {
    await worker.runCycle();
  } finally {
    console.log = originalLog;
  }

  assert.equal(updates.length, 1);
});

test("location read failures are timed, reported, and prevent location writes", async () => {
  const records = [];
  const originalLog = console.log;
  console.log = (line) => records.push(JSON.parse(line));
  const worker = new GpsSyncWorker({
    BusModel: {
      find: () => query([{ _id: "bus-1", bus_no: "BUS-1" }]),
    },
    UserModel: {
      find: () => query([]),
    },
    LiveLocationModel: {
      find: () => query(Promise.reject(new Error("database details omitted"))),
      updateOne: async () => assert.fail("writes must not run after a read failure"),
    },
    service: { getAllCurrentLocations: async () => new Map() },
    socketGetter: () => null,
  });

  try {
    await assert.rejects(worker.runCycle(), /database details omitted/);
  } finally {
    console.log = originalLog;
  }

  const completed = records.find((record) => record.event === "GPS_CYCLE_COMPLETED");
  const started = records.find((record) => record.event === "GPS_CYCLE_STARTED");
  assert.equal(completed.status, "FAILED");
  assert.equal(completed.cycleId, started.cycleId);
  assert.equal(completed.databaseReadFailures, 1);
  assert.equal(completed.failureStage, "locationReadDurationMs");
  assert.equal(completed.failureName, "Error");
  assert.equal(completed.failureCode, null);
  assert.ok(completed.locationReadDurationMs >= 0);
  assert.equal(JSON.stringify(records).includes("database details omitted"), false);
});

test("matches primary and alias device IDs before registration numbers", () => {
  const preferred = { latitude: 10, longitude: 77 };
  const regMatch = { latitude: 11, longitude: 78 };
  const locations = new Map([
    ["device-alias", preferred],
    ["reg:REG-ALIAS", regMatch],
  ]);
  assert.equal(
    getBusLocation(
      {
        gps_device_id: "device-main",
        gps_device_aliases: ["device-alias"],
        reg_no: "REG-MAIN",
        reg_no_aliases: ["REG-ALIAS"],
      },
      locations,
    ),
    preferred,
  );
  assert.equal(
    getBusLocation(
      {
        gps_device_id: "unmatched",
        gps_device_aliases: [],
        reg_no: "REG-MAIN",
        reg_no_aliases: ["REG-ALIAS"],
      },
      locations,
    ),
    regMatch,
  );
});

test("deduplicates assigned user room identifiers", () => {
  const usersByBus = buildUsersByBus([
    { _id: "student-1", bus_no: " bus-1 " },
    { _id: "student-1", bus_no: "BUS-1" },
  ]);
  assert.deepEqual([...usersByBus.get("BUS-1")], ["student-1"]);
});

test("bulk provider response rejects invalid coordinates and indexes registration-only records", async () => {
  const originalGet = axios.get;
  const originalToken = gpsService.token;
  const originalEmail = gpsService.email;
  gpsService.token = "test-token";
  gpsService.email = "test-email";
  let providerCalls = 0;
  axios.get = async () => {
    providerCalls++;
    return {
      data: [
        { regNo: "REG-1", latitude: "12.5", longitude: "78.5", speed: "0" },
        { deviceId: "bad", regNo: "REG-2", latitude: 100, longitude: 78 },
      ],
    };
  };

  try {
    const locations = await gpsService.getAllCurrentLocations();
    assert.equal(providerCalls, 1);
    assert.equal(locations.get("reg:REG-1").latitude, 12.5);
    assert.equal(locations.has("bad"), false);
    assert.equal(locations.has("reg:REG-2"), false);
  } finally {
    axios.get = originalGet;
    gpsService.token = originalToken;
    gpsService.email = originalEmail;
  }
});

test("GPS service distinguishes an explicit empty fleet from an unusable response", async () => {
  const originalGet = axios.get;
  const originalToken = gpsService.token;
  const originalEmail = gpsService.email;
  gpsService.token = "test-token";
  gpsService.email = "test-email";
  let response = { data: { data: [] } };
  axios.get = async () => response;

  try {
    assert.deepEqual(await gpsService.getAllCurrentLocations(), new Map());
    response = { data: { message: "unusable" } };
    assert.equal(await gpsService.getAllCurrentLocations(), null);
  } finally {
    axios.get = originalGet;
    gpsService.token = originalToken;
    gpsService.email = originalEmail;
  }
});

test("GPS service returns null when every record in a non-empty fleet is unusable", async () => {
  const originalGet = axios.get;
  const originalToken = gpsService.token;
  const originalEmail = gpsService.email;
  gpsService.token = "test-token";
  gpsService.email = "test-email";
  axios.get = async () => ({
    data: [
      { deviceId: "invalid-coordinates", latitude: 100, longitude: 78 },
      { latitude: 12, longitude: 78 },
    ],
  });

  try {
    const locations = await gpsService.getAllCurrentLocations();
    assert.equal(locations, null);
    assert.equal(locations instanceof Map, false);
  } finally {
    axios.get = originalGet;
    gpsService.token = originalToken;
    gpsService.email = originalEmail;
  }
});

test("failed provider data preserves last known coordinates while updating poll status", async () => {
  const previous = {
    bus_id: "bus-1",
    latitude: 10,
    longitude: 77,
    speed: 3,
    is_online: true,
    lastSuccessfulGpsUpdate: new Date(),
    source: "gps",
  };
  const { worker, updates } = createWorker({
    buses: [{ _id: "bus-1", bus_no: "BUS-1", gps_device_id: "device-1" }],
    locations: [previous],
    provider: async () => new Map(),
  });

  await worker.runCycle();
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].operation.$set, {
    is_online: true,
    lastUpdated: updates[0].operation.$set.lastUpdated,
  });
  assert.equal(updates[0].operation.$set.latitude, undefined);
});

test("GPS service exposes only the fleet-wide retrieval path", async () => {
  let allCalls = 0;
  const { worker } = createWorker({
    buses: [{ _id: "bus-1", bus_no: "BUS-1", gps_device_id: "device-1" }],
    provider: async () => {
      allCalls++;
      return new Map();
    },
  });
  await worker.runCycle();
  assert.equal(allCalls, 1);
  assert.equal(typeof gpsService.getLocationForBus, "undefined");
});

test("live-location schema retains the unique bus relationship", () => {
  const indexes = BusLiveLocation.schema.indexes();
  assert.ok(
    indexes.some(
      ([fields, options]) =>
        fields.bus_id === 1 && options.unique === true,
    ),
  );
});
