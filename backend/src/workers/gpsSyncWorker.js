const Bus = require("../models/Bus");
const BusLiveLocation = require("../models/BusLiveLocation");
const User = require("../models/User");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const gpsService = require("../services/gpsService");
const { getIO } = require("../socket");

const GPS_SYNC_INTERVAL_MS = 35_000;
const DEFAULT_STALE_THRESHOLD_MS = 3 * 60 * 1000;

function logGpsEvent(event, details = {}) {
  try {
    console.log(JSON.stringify({ event, ...details }));
  } catch {
    // Logging must not interrupt GPS synchronization.
  }
}

function getSafeError(error) {
  return {
    name: typeof error?.name === "string" ? error.name : "Error",
    code:
      typeof error?.code === "string" || typeof error?.code === "number"
        ? error.code
        : null,
  };
}

function elapsedMs(startedAt) {
  return Math.max(0, performance.now() - startedAt);
}

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
    this.activeCycleId = null;
    this.skippedTimerTicks = 0;
    this.lastCycleMetrics = null;
  }

  getStatus() {
    return {
      started: this.started,
      stopping: this.stopping,
      syncIntervalMs: this.syncIntervalMs,
      activeCycleId: this.activeCycleId,
      skippedTimerTicks: this.skippedTimerTicks,
      lastCycle: this.lastCycleMetrics
        ? { ...this.lastCycleMetrics }
        : null,
    };
  }

  start() {
    if (this.started || this.stopping) return;
    this.started = true;
    this.stopped = false;

    logGpsEvent("GPS_WORKER_STARTED", {
      intervalMs: GPS_SYNC_INTERVAL_MS,
      staleThresholdMs: this.staleThresholdMs,
    });

    this.runCycle().catch((error) =>
      logGpsEvent("GPS_CYCLE_UNHANDLED_FAILURE", {
        source: "INITIAL_CYCLE",
        ...getSafeError(error),
      }),
    );

    this.interval = this.setIntervalFn(() => {
      this.runCycle().catch((error) =>
        logGpsEvent("GPS_CYCLE_UNHANDLED_FAILURE", {
          source: "SCHEDULED_CYCLE",
          ...getSafeError(error),
        }),
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
    if (this.syncLock) {
      this.skippedTimerTicks++;
      logGpsEvent("GPS_CYCLE_SKIPPED", {
        reason: "CYCLE_IN_PROGRESS",
        activeCycleId: this.activeCycleId,
        skippedTimerTicks: this.skippedTimerTicks,
      });
      return;
    }
    if (this.stopping || this.stopped) {
      logGpsEvent("GPS_CYCLE_SKIPPED", {
        reason: this.stopping ? "WORKER_STOPPING" : "WORKER_STOPPED",
        activeCycleId: this.activeCycleId,
      });
      return;
    }

    this.syncLock = true;
    this.skippedTimerTicks = 0;
    const cycle = this.executeCycle();
    this.inFlightCycle = cycle;
    try {
      await cycle;
    } finally {
      if (this.inFlightCycle === cycle) this.inFlightCycle = null;
      this.activeCycleId = null;
      this.syncLock = false;
    }
  }

  async executeCycle() {
    const cycleId = `${process.pid}-${randomUUID()}`;
    this.activeCycleId = cycleId;
    const startedAt = new Date().toISOString();
    const cycleStarted = performance.now();
    const metrics = {
      cycleId,
      startedAt,
      completedAt: null,
      durationMs: null,
      providerDurationMs: null,
      busQueryDurationMs: null,
      studentQueryDurationMs: null,
      locationReadDurationMs: null,
      locationWriteDurationMs: 0,
      activeBusCount: null,
      assignedStudentCount: null,
      normalizedProviderRecordCount: null,
      successfulWrites: 0,
      failedWrites: 0,
      processingFailures: 0,
      skippedTimerTicks: 0,
      providerFailures: 0,
      databaseReadFailures: 0,
      failureStage: null,
      failureName: null,
      failureCode: null,
      status: "FAILED",
    };
    logGpsEvent("GPS_CYCLE_STARTED", { cycleId, startedAt });

    const timedRead = async (durationField, operation) => {
      const readStarted = performance.now();
      try {
        return await operation();
      } catch (error) {
        metrics.databaseReadFailures++;
        metrics.failureStage ||= durationField;
        const safeError = getSafeError(error);
        metrics.failureName ||= safeError.name;
        metrics.failureCode ??= safeError.code;
        throw error;
      } finally {
        metrics[durationField] = elapsedMs(readStarted);
      }
    };

    try {
      let locationMap = null;
      let providerRequestFailed = false;
      const providerStarted = performance.now();
      try {
        locationMap = await this.gpsService.getAllCurrentLocations({
          timeoutMs: this.timeoutPerAttemptMs,
        });
      } catch (error) {
        providerRequestFailed = true;
        metrics.providerFailures++;
        const safeError = getSafeError(error);
        metrics.failureStage = "PROVIDER_REQUEST";
        metrics.failureName = safeError.name;
        metrics.failureCode = safeError.code;
        logGpsEvent("GPS_PROVIDER_REQUEST_FAILED", {
          cycleId,
          ...safeError,
        });
      } finally {
        metrics.providerDurationMs = elapsedMs(providerStarted);
      }
      if (locationMap == null) {
        if (!providerRequestFailed) {
          metrics.providerFailures++;
          metrics.failureStage = "PROVIDER_RESPONSE";
          logGpsEvent("GPS_PROVIDER_RESPONSE_UNUSABLE", { cycleId });
        }
        metrics.status = "COMPLETED_WITH_ERRORS";
        return;
      }
      metrics.normalizedProviderRecordCount = locationMap
        ? new Set(locationMap.values()).size
        : 0;

      const busRead = timedRead("busQueryDurationMs", () =>
        this.Bus.find({ status: "active" })
          .select(
            "_id gps_device_id gps_device_aliases reg_no reg_no_aliases bus_no preview_number",
          )
          .lean(),
      );
      const userRead = timedRead("studentQueryDurationMs", () =>
        this.User.find({
          role: "student",
          is_active: true,
          bus_no: { $nin: [null, ""] },
        })
          .select("_id bus_no")
          .lean(),
      );
      let buses;
      let assignedUsers;
      try {
        [buses, assignedUsers] = await Promise.all([busRead, userRead]);
      } catch (error) {
        await Promise.allSettled([busRead, userRead]);
        throw error;
      }
      metrics.activeBusCount = buses.length;
      metrics.assignedStudentCount = assignedUsers.length;
      const usersByBus = buildUsersByBus(assignedUsers);

      let existingLocations = [];
      if (buses.length) {
        existingLocations = await timedRead("locationReadDurationMs", () =>
          this.BusLiveLocation.find({
            bus_id: { $in: buses.map((bus) => bus._id) },
          })
            .select(
              "bus_id user_id latitude longitude speed is_online source lastSuccessfulGpsUpdate lastUpdated updatedAt",
            )
            .lean(),
        );
      } else {
        metrics.locationReadDurationMs = 0;
      }
      const locationsByBus = new Map(
        existingLocations.map((location) => [
          String(location.bus_id),
          location,
        ]),
      );

      const now = new Date();
      for (const bus of buses) {
        const busId = bus._id;
        const previousLocation = locationsByBus.get(String(busId));
        const providerLocation = getBusLocation(bus, locationMap);
        let writeAttempted = false;

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
            source: previousLocation ? previousLocation.source : "gps",
            updatedAt: now,
          };
          const writeStarted = performance.now();
          writeAttempted = true;
          try {
            await this.BusLiveLocation.updateOne(
              { bus_id: busId },
              { $set: update },
              { upsert: true },
            );
            metrics.successfulWrites++;
          } finally {
            metrics.locationWriteDurationMs += elapsedMs(writeStarted);
          }
          try {
            this.emitLocation(bus, currentLocation, usersByBus, now);
          } catch (error) {
            logGpsEvent("GPS_LOCATION_EVENT_FAILED", {
              cycleId,
              ...getSafeError(error),
            });
          }
        } catch (error) {
          if (writeAttempted) {
            metrics.failedWrites++;
            logGpsEvent("GPS_LOCATION_WRITE_FAILED", {
              cycleId,
              ...getSafeError(error),
            });
          } else {
            metrics.processingFailures++;
            logGpsEvent("GPS_LOCATION_PROCESSING_FAILED", {
              cycleId,
              ...getSafeError(error),
            });
          }
        }
      }
      metrics.status =
        metrics.providerFailures ||
        metrics.failedWrites ||
        metrics.processingFailures
          ? "COMPLETED_WITH_ERRORS"
          : "COMPLETED";
    } catch (error) {
      metrics.failureStage ||= "CYCLE";
      const safeError = getSafeError(error);
      metrics.failureName ||= safeError.name;
      metrics.failureCode ??= safeError.code;
      throw error;
    } finally {
      metrics.completedAt = new Date().toISOString();
      metrics.durationMs = elapsedMs(cycleStarted);
      metrics.skippedTimerTicks = this.skippedTimerTicks;
      this.lastCycleMetrics = { ...metrics };
      logGpsEvent("GPS_CYCLE_COMPLETED", metrics);
    }
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
