const Bus = require("../models/Bus");
const BusLiveLocation = require("../models/BusLiveLocation");
const User = require("../models/User");
const gpsService = require("../services/gpsService");
const { getIO } = require("../socket");

const GPS_SYNC_INTERVAL_MS = 35_000;
const DEFAULT_STALE_THRESHOLD_MS = 3 * 60 * 1000;

// These guards are process-local; multiple backend processes still need
// external coordination and a shared Socket.IO adapter.
const distanceMeters = (pointA, pointB) => {
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
};

function getBusLocation(bus, locationMap) {
  if (!locationMap) return null;

  for (const deviceId of [
    bus.gps_device_id,
    ...(bus.gps_device_aliases || []),
  ]) {
    if (deviceId == null || deviceId === "") continue;
    const location = locationMap.get(String(deviceId));
    if (location) return location;
  }

  for (const regNo of [bus.reg_no, ...(bus.reg_no_aliases || [])]) {
    if (regNo == null || regNo === "") continue;
    const location = locationMap.get(`reg:${regNo}`);
    if (location) return location;
  }
  return null;
}

function buildUsersByBus(assignedUsers) {
  const usersByBus = new Map();
  for (const user of assignedUsers) {
    const busNumber = String(user.bus_no || "").trim().toUpperCase();
    if (!busNumber) continue;
    const users = usersByBus.get(busNumber) || new Set();
    users.add(String(user._id));
    usersByBus.set(busNumber, users);
  }
  return usersByBus;
}

function getLocationPayload(bus, location, now, staleThresholdMs) {
  const lastSuccessfulGpsUpdate = location?.lastSuccessfulGpsUpdate ?? null;
  const updatedAt = location?.updatedAt ?? now;
  return {
    previewNumber: bus.preview_number || null,
    latitude: location?.latitude ?? null,
    longitude: location?.longitude ?? null,
    speed: location?.speed ?? 0,
    status: location?.is_online ? "online" : "offline",
    source: location?.source || "offline",
    is_online: !!location?.is_online,
    lastSuccessfulGpsUpdate,
    lastUpdated: lastSuccessfulGpsUpdate || updatedAt,
    gpsOfflineThresholdMs: staleThresholdMs,
  };
}

class GpsSyncWorker {
  constructor({
    BusModel = Bus,
    LiveLocationModel = BusLiveLocation,
    UserModel = User,
    service = gpsService,
    socketGetter = getIO,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = {}) {
    this.Bus = BusModel;
    this.BusLiveLocation = LiveLocationModel;
    this.User = UserModel;
    this.gpsService = service;
    this.socketGetter = socketGetter;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;

    this.started = false;
    this.stopped = false;
    this.stopping = false;
    this.syncIntervalMs = GPS_SYNC_INTERVAL_MS;
    this.staleThresholdMs =
      Number(process.env.GPS_OFFLINE_THRESHOLD_MS) || DEFAULT_STALE_THRESHOLD_MS;
    this.timeoutPerAttemptMs =
      Number(process.env.GPS_PROVIDER_TIMEOUT_MS) || 10000;
    this.syncLock = false;
    this.interval = null;
    this.inFlightCycle = null;
  }

  start() {
    if (this.started || this.stopping) return;
    this.started = true;
    this.stopped = false;

    console.log(
      `GPS sync worker started: interval=${GPS_SYNC_INTERVAL_MS}ms, staleThreshold=${this.staleThresholdMs}ms`,
    );

    this.runCycle().catch((error) =>
      console.error("Initial gpsSyncWorker cycle failed:", error),
    );

    this.interval = this.setIntervalFn(() => {
      this.runCycle().catch((error) =>
        console.error("gpsSyncWorker cycle failed:", error),
      );
    }, GPS_SYNC_INTERVAL_MS);
  }

  async stop() {
    this.started = false;
    this.stopped = true;
    this.stopping = true;
    if (this.interval) {
      this.clearIntervalFn(this.interval);
      this.interval = null;
    }

    try {
      await this.inFlightCycle;
    } finally {
      this.stopping = false;
    }
  }

  async runCycle() {
    if (this.syncLock || this.stopping || this.stopped) {
      console.log("GPS sync cycle skipped: previous cycle is active or stopping");
      return;
    }

    this.syncLock = true;
    const cycle = this.executeCycle();
    this.inFlightCycle = cycle;
    try {
      await cycle;
    } finally {
      if (this.inFlightCycle === cycle) this.inFlightCycle = null;
      this.syncLock = false;
    }
  }

  async executeCycle() {
    const cycleStart = Date.now();
    let locationMap = null;
    try {
      locationMap = await this.gpsService.getAllCurrentLocations({
        timeoutMs: this.timeoutPerAttemptMs,
      });
    } catch (error) {
      console.error(`GPS bulk fetch failed: ${error?.message || error}`);
    }

    const buses = await this.Bus.find({ status: "active" })
      .select(
        "_id gps_device_id gps_device_aliases reg_no reg_no_aliases bus_no preview_number",
      )
      .lean();
    const assignedUsers = await this.User.find({
      role: "student",
      is_active: true,
      bus_no: { $nin: [null, ""] },
    })
      .select("_id bus_no")
      .lean();
    const usersByBus = buildUsersByBus(assignedUsers);

    let existingLocations = [];
    if (buses.length) {
      existingLocations = await this.BusLiveLocation.find({
        bus_id: { $in: buses.map((bus) => bus._id) },
      })
        .select(
          "bus_id user_id latitude longitude speed is_online source lastSuccessfulGpsUpdate lastUpdated updatedAt",
        )
        .lean();
    }
    const locationsByBus = new Map(
      existingLocations.map((location) => [
        String(location.bus_id),
        location,
      ]),
    );

    console.log(`GPS Sync Started - buses=${buses.length}`);
    const now = new Date();
    let successCount = 0;
    let failCount = 0;

    for (const bus of buses) {
      const busId = bus._id;
      const identifier = bus.preview_number || bus.reg_no || String(busId);
      const previousLocation = locationsByBus.get(String(busId));
      const providerLocation = getBusLocation(bus, locationMap);

      try {
        let update;
        if (providerLocation) {
          const previousTimestamp = previousLocation?.lastSuccessfulGpsUpdate
            ? new Date(previousLocation.lastSuccessfulGpsUpdate).getTime()
            : NaN;
          const elapsedSeconds =
            (now.getTime() - previousTimestamp) / 1000;
          const hasPreviousPoint =
            Number.isFinite(Number(previousLocation?.latitude)) &&
            Number.isFinite(Number(previousLocation?.longitude)) &&
            Number.isFinite(elapsedSeconds) &&
            elapsedSeconds > 0 &&
            elapsedSeconds <= this.staleThresholdMs / 1000;
          const derivedSpeedKmh = hasPreviousPoint
            ? (distanceMeters(previousLocation, providerLocation) /
                elapsedSeconds) *
              3.6
            : null;
          update = {
            latitude: providerLocation.latitude,
            longitude: providerLocation.longitude,
            speed: providerLocation.speed,
            speedKmh:
              derivedSpeedKmh != null && derivedSpeedKmh <= 150
                ? derivedSpeedKmh
                : null,
            is_online: true,
            lastSuccessfulGpsUpdate: now,
            lastUpdated: now,
          };
        } else {
          const lastSuccess = previousLocation?.lastSuccessfulGpsUpdate
            ? new Date(previousLocation.lastSuccessfulGpsUpdate).getTime()
            : NaN;
          const shouldBeOnline =
            Number.isFinite(lastSuccess) &&
            now.getTime() - lastSuccess <= this.staleThresholdMs;
          update = {
            is_online: shouldBeOnline,
            lastUpdated: now,
          };
        }

        const currentLocation = {
          ...previousLocation,
          ...update,
          bus_id: busId,
          source: previousLocation
            ? previousLocation.source
            : "gps",
          updatedAt: now,
        };
        await this.BusLiveLocation.updateOne(
          { bus_id: busId },
          { $set: update },
          { upsert: true },
        );
        if (providerLocation) successCount++;
        else failCount++;
        try {
          this.emitLocation(bus, currentLocation, usersByBus, now);
        } catch (error) {
          console.error(
            `GPS event emit failed for bus ${identifier}: ${error?.message || error}`,
          );
        }
      } catch (error) {
        failCount++;
        console.error(
          `GPS processing failed for bus ${identifier}: ${error?.message || error}`,
        );
      }
    }

    console.log(
      `GPS Sync Completed - success=${successCount}, failed=${failCount}`,
    );
    console.log(`Polling Time: ${Date.now() - cycleStart}ms`);
  }

  emitLocation(bus, location, usersByBus, now) {
    const io = this.socketGetter();
    if (!io) return;

    const rooms = new Set();
    if (bus.preview_number != null) {
      rooms.add(`preview_${String(bus.preview_number)}`);
    }
    const assignedUserIds =
      usersByBus.get(String(bus.bus_no || "").trim().toUpperCase()) ||
      new Set();
    for (const userId of assignedUserIds) rooms.add(`user_${userId}`);
    if (location.user_id) rooms.add(`user_${String(location.user_id)}`);
    if (!rooms.size) return;

    const payload = getLocationPayload(
      bus,
      location,
      now,
      this.staleThresholdMs,
    );
    let broadcaster = io;
    for (const room of rooms) broadcaster = broadcaster.to(room);
    broadcaster.emit("locationUpdate", payload);
  }
}

const gpsSyncWorker = new GpsSyncWorker();
gpsSyncWorker.GpsSyncWorker = GpsSyncWorker;
gpsSyncWorker.getBusLocation = getBusLocation;
gpsSyncWorker.buildUsersByBus = buildUsersByBus;
gpsSyncWorker.GPS_SYNC_INTERVAL_MS = GPS_SYNC_INTERVAL_MS;

module.exports = gpsSyncWorker;
