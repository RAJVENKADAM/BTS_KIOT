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
  socketGetter = () => null,
  timers = {},
} = {}) {
  const updates = [];
  let locationReads = 0;
  let locationReadFilter = null;
  const worker = new GpsSyncWorker({
    BusModel: {
      find: () => query(buses),
    },
    UserModel: {
      find: () => query(users),
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

test("uses one fixed 35-second provider request per active cycle and preserves immediate startup polling", async () => {
  let intervalCallback;
  let intervalDelay;
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
  let providerCalls = 0;
  const { worker, updates } = createWorker({
    provider: async () => {
      providerCalls++;
      if (providerCalls === 1) throw new Error("provider unavailable");
      return new Map();
    },
    buses: [{ _id: "bus-1", bus_no: "BUS-1" }],
  });

  await worker.runCycle();
  assert.equal(providerCalls, 1);
  assert.equal(updates.length, 1);
  await worker.runCycle();
  assert.equal(providerCalls, 2);
  assert.equal(updates.length, 2);
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
