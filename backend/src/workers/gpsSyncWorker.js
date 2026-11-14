const Bus = require("../models/Bus");
const BusLiveLocation = require("../models/BusLiveLocation");
const GpsDevice = require("../models/GpsDevice");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const gpsService = require("../services/gpsService");
const {
  captureSingleInstanceGpsConfigurationVersion,
  runSingleInstanceGpsPersistence,
} = require("../services/gpsConfigurationBarrier");

const GPS_SYNC_INTERVAL_MS = 35_000;
const DEFAULT_STALE_THRESHOLD_MS = 3 * 60 * 1000;

function logGpsEvent(event, details = {}) {
  try {
    console.log(JSON.stringify({ event, ...details }));
  } catch {
    // Logging must not interrupt GPS synchronization.
  }
}

function logStaleTimestampDiagnostic(
  providerLocation,
  serverTime,
  staleThresholdMs,
  watermark,
) {
  const providerTime = Date.parse(providerLocation.providerTimestamp);
  const watermarkTime =
    watermark == null ? NaN : new Date(watermark).getTime();

  logGpsEvent("GPS_STALE_PROVIDER_TIMESTAMP_DIAGNOSTIC", {
    timestampField: providerLocation.providerTimestampField ?? null,
    originalTimestampValueType:
      providerLocation.providerTimestampValueType ?? "unknown",
    providerTimestamp: new Date(providerTime).toISOString(),
    serverTime: serverTime.toISOString(),
    timestampAgeMs: serverTime.getTime() - providerTime,
    staleThresholdMs,
    storedWatermarkTimestamp: Number.isFinite(watermarkTime)
      ? new Date(watermarkTime).toISOString()
      : null,
  });
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

function isDuplicateKeyError(error) {
  return error?.code === 11000 || error?.code === "11000";
}

// The lock prevents local overlap; leaseGuard coordinates fleet ownership across instances.
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

function getBusLocation(bus, locationMap, registeredDevice) {
  if (!locationMap) return null;
  if (registeredDevice) {
    if (registeredDevice.source !== "REAL") return null;
    return locationMap.get(String(registeredDevice.deviceId)) || null;
  }

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

function getLocationPublicationRooms(bus) {
  const rooms = new Set();
  if (bus._id != null) {
    rooms.add(`assigned_bus_${String(bus._id)}`);
  }
  if (bus.preview_number != null) {
    rooms.add(`preview_${String(bus.preview_number)}`);
  }
  return [...rooms];
}

function isProviderTimestampNewerExpression(providerTimestamp) {
  const providerTimestampType = { $type: "$providerTimestamp" };
  return {
    $expr: {
      $or: [
        {
          $in: [providerTimestampType, ["missing", "null"]],
        },
        {
          $and: [
            { $eq: [providerTimestampType, "date"] },
            { $lt: ["$providerTimestamp", providerTimestamp] },
          ],
        },
      ],
    },
  };
}

class GpsSyncWorker {
  constructor({
    BusModel = Bus,
    LiveLocationModel = BusLiveLocation,
    GpsDeviceModel = null,
    service = gpsService,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = {}) {
    this.Bus = BusModel;
    this.BusLiveLocation = LiveLocationModel;
    this.GpsDevice = GpsDeviceModel;
    this.gpsService = service;
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
    this.lastSuccessfulGpsUpdate = null;
    this.lastProviderTimestamp = null;
    this.leaseGuard = null;
    this.fencingToken = 0;
    this.ownershipFailureHandler = null;
    this.ownershipLost = false;
    this.providerAbortController = null;
  }

  setLeaseGuard(leaseGuard, ownershipFailureHandler = null) {
    if (this.started) {
      throw new Error("Cannot change the GPS worker lease while it is running.");
    }
    const rawToken = leaseGuard?.fencingToken;
    const fencingToken =
      typeof rawToken === "bigint"
        ? rawToken
        : rawToken?._bsontype === "Long"
          ? rawToken.toBigInt()
          : 0n;
    if (
      leaseGuard &&
      (fencingToken <= 0n ||
        typeof leaseGuard.runTransaction !== "function" ||
        typeof leaseGuard.getConfigurationVersion !== "function")
    ) {
      throw new Error("GPS worker ownership requires a token and transaction guard.");
    }
    this.leaseGuard = leaseGuard;
    this.fencingToken = leaseGuard ? fencingToken : 0n;
    this.ownershipFailureHandler = leaseGuard ? ownershipFailureHandler : null;
    this.ownershipLost = false;
  }

  notifyOwnershipFailure(error) {
    if (this.ownershipLost) return;
    this.ownershipLost = true;
    this.started = false;
    this.stopped = true;
    if (this.interval) {
      this.clearIntervalFn(this.interval);
      this.interval = null;
    }
    this.providerAbortController?.abort();
    if (this.ownershipFailureHandler) {
      Promise.resolve()
        .then(() => this.ownershipFailureHandler(error))
        .catch((handlerError) =>
          logGpsEvent("GPS_OWNERSHIP_FAILURE_HANDLER_FAILED", {
            ...getSafeError(handlerError),
          }),
        );
    }
  }

  async assertLeaseOwnership() {
    if (!this.leaseGuard) return;
    if (this.ownershipLost) {
      const error = new Error("GPS worker ownership has already been lost.");
      error.code = "GPS_LEASE_LOST";
      error.gpsLeaseError = true;
      throw error;
    }
    try {
      if (await this.leaseGuard.assertOwned()) return;
    } catch (error) {
      error.gpsLeaseError = true;
      this.notifyOwnershipFailure(error);
      throw error;
    }
    const error = new Error("GPS worker lease ownership was lost.");
    error.code = "GPS_LEASE_LOST";
    error.gpsLeaseError = true;
    this.notifyOwnershipFailure(error);
    throw error;
  }

  async persistGpsOperations(operations, expectedConfigVersion) {
    const committed = [];
    const failed = [];
    const rejected = [];
    const batchSize = 25;

    const executeBatch = async (batch) => {
      const execute = async (session) => {
        const results = [];
        for (const operation of batch) {
          const filter = { ...operation.filter };
          let update = operation.update;
          if (this.leaseGuard) {
            const clauses = Array.isArray(filter.$and) ? [...filter.$and] : [];
            delete filter.$and;
            clauses.push({
              $or: [
                { gpsFenceToken: { $exists: false } },
                { gpsFenceToken: { $lte: this.fencingToken } },
              ],
            });
            filter.$and = clauses;
            update = {
              ...operation.update,
              $max: {
                ...(operation.update.$max || {}),
                gpsFenceToken: this.fencingToken,
              },
            };
          }
          const options = {
            ...(operation.options || {}),
            ...(session ? { session } : {}),
          };
          const result = await operation.model[operation.method](
            filter,
            update,
            options,
          );
          if (
            operation.staleOnNoMatch &&
            result?.matchedCount === 0 &&
            result?.upsertedCount === 0
          ) {
            results.push({ operation, result, stale: true });
            continue;
          }
          if (
            operation.requireMatch &&
            result?.matchedCount === 0 &&
            result?.upsertedCount === 0
          ) {
            throw new Error("GPS write was rejected by its document fence.");
          }
          results.push({ operation, result });
        }
        return results;
      };

      if (this.leaseGuard) {
        return this.leaseGuard.runTransaction(execute, {
          expectedConfigVersion,
        });
      }
      return execute(null);
    };

    const persistBatches = async () => {
      const recordCommitted = (operation) => {
        committed.push(operation);
        if (operation.providerAccepted) {
          this.lastSuccessfulGpsUpdate =
            operation.providerLastSuccessfulUpdate.toISOString();
          this.lastProviderTimestamp = operation.providerTimestamp.toISOString();
        }
      };
      for (let offset = 0; offset < operations.length; offset += batchSize) {
        const batch = operations.slice(offset, offset + batchSize);
        try {
          const results = await executeBatch(batch);
          for (const entry of results) {
            if (entry.stale) {
              rejected.push(entry.operation);
            } else {
              recordCommitted(entry.operation);
            }
          }
        } catch (error) {
          if (error.gpsLeaseError) {
            this.notifyOwnershipFailure(error);
            throw error;
          }
          if (error.gpsConfigurationError) throw error;
          if (
            batch.length === 1 &&
            batch[0].staleOnNoMatch &&
            isDuplicateKeyError(error)
          ) {
            rejected.push(batch[0]);
            continue;
          }
          if (batch.length > 1) {
            for (const operation of batch) {
              try {
                const [entry] = await executeBatch([operation]);
                if (entry.stale) rejected.push(entry.operation);
                else recordCommitted(entry.operation);
              } catch (individualError) {
                if (individualError.gpsLeaseError) {
                  this.notifyOwnershipFailure(individualError);
                  throw individualError;
                }
                if (individualError.gpsConfigurationError) throw individualError;
                if (
                  operation.staleOnNoMatch &&
                  isDuplicateKeyError(individualError)
                ) {
                  rejected.push(operation);
                } else {
                  failed.push({ operation, error: individualError });
                }
              }
            }
          } else {
            failed.push({ operation: batch[0], error });
          }
        }
      }
    };

    if (this.leaseGuard) {
      await persistBatches();
    } else {
      await runSingleInstanceGpsPersistence(expectedConfigVersion, persistBatches);
    }
    return { committed, failed, rejected };
  }

  getStatus() {
    return {
      started: this.started,
      stopping: this.stopping,
      syncIntervalMs: this.syncIntervalMs,
      activeCycleId: this.activeCycleId,
      skippedTimerTicks: this.skippedTimerTicks,
      distributedLease: Boolean(this.leaseGuard),
      fencingToken: this.fencingToken || null,
      lastCycle: this.lastCycleMetrics
        ? { ...this.lastCycleMetrics }
        : null,
      lastSuccessfulGpsUpdate: this.lastSuccessfulGpsUpdate,
      lastProviderTimestamp: this.lastProviderTimestamp,
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
    if (this.stopping || this.stopped || this.ownershipLost) {
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
      locationReadDurationMs: null,
      locationWriteDurationMs: 0,
      activeBusCount: null,
      normalizedProviderRecordCount: null,
      successfulWrites: 0,
      acceptedProviderUpdates: 0,
      staleProviderUpdates: 0,
      duplicateProviderUpdates: 0,
      missingProviderTimestampUpdates: 0,
      failedWrites: 0,
      processingFailures: 0,
      skippedTimerTicks: 0,
      providerFailures: 0,
      providerRequestSkipped: false,
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

    let expectedConfigVersion;
    try {
      if (this.leaseGuard) {
        try {
          expectedConfigVersion = await this.leaseGuard.getConfigurationVersion();
        } catch (error) {
          error.gpsLeaseError = true;
          this.notifyOwnershipFailure(error);
          throw error;
        }
      } else {
        expectedConfigVersion =
          await captureSingleInstanceGpsConfigurationVersion();
      }
      const activeGpsDevices = this.GpsDevice
        ? await timedRead("gpsDeviceQueryDurationMs", () =>
            this.GpsDevice.find({ is_active: true })
              .select(
                "deviceId source bus_id lastSuccessfulUpdate providerTimestamp",
              )
              .lean(),
          )
        : [];
      const realGpsDevices = activeGpsDevices.filter(
        (device) => device.source === "REAL",
      );
      const registryStrict =
        process.env.GPS_DEVICE_REGISTRY_MODE === "strict";
      metrics.providerRequestSkipped =
        registryStrict && realGpsDevices.length === 0;
      if (realGpsDevices.length) {
        await this.persistGpsOperations([
          {
            model: this.GpsDevice,
            method: "updateMany",
            filter: { _id: { $in: realGpsDevices.map((device) => device._id) } },
            update: {
            $set: {
              lastAttemptedUpdate: new Date(),
              healthStatus: "PENDING",
              lastErrorCode: null,
            },
          },
          },
        ], expectedConfigVersion);
      }
      let locationMap = metrics.providerRequestSkipped
        ? new Map()
        : null;
      let providerRequestFailed = false;
      const providerStarted = performance.now();
      if (!locationMap) {
        await this.assertLeaseOwnership();
        const abortController = this.leaseGuard ? new AbortController() : null;
        this.providerAbortController = abortController;
        try {
          locationMap = await this.gpsService.getAllCurrentLocations({
            timeoutMs: this.timeoutPerAttemptMs,
            ...(abortController ? { signal: abortController.signal } : {}),
          });
        } catch (error) {
          if (this.ownershipLost || error.gpsLeaseError) {
            error.gpsLeaseError = true;
            throw error;
          }
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
        }
        if (this.providerAbortController === abortController) {
          this.providerAbortController = null;
        }
        await this.assertLeaseOwnership();
      }
      metrics.providerDurationMs = elapsedMs(providerStarted);
      if (locationMap == null) {
        if (!providerRequestFailed) {
          metrics.providerFailures++;
          metrics.failureStage = "PROVIDER_RESPONSE";
          logGpsEvent("GPS_PROVIDER_RESPONSE_UNUSABLE", { cycleId });
        }
        if (realGpsDevices.length) {
          await this.persistGpsOperations([
            {
              model: this.GpsDevice,
              method: "updateMany",
              filter: { _id: { $in: realGpsDevices.map((device) => device._id) } },
              update: {
              $set: {
                healthStatus: "ERROR",
                lastErrorCode: providerRequestFailed
                  ? "PROVIDER_REQUEST_FAILED"
                  : "PROVIDER_RESPONSE_INVALID",
              },
            },
            },
          ], expectedConfigVersion);
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
      const buses = await busRead;
      metrics.activeBusCount = buses.length;
      const devicesByBus = new Map(
        activeGpsDevices.map((device) => [String(device.bus_id), device]),
      );
      const now = new Date();
      const gpsWriteOperations = [];
      const rejectedProviderDevices = new Set();
      const rejectProviderUpdate = (providerLocation, reason) => {
        const key = providerLocation?.deviceId || providerLocation?.regNo;
        if (key && rejectedProviderDevices.has(String(key))) return;
        if (key) rejectedProviderDevices.add(String(key));
        if (reason === "MISSING_OR_INVALID_PROVIDER_TIMESTAMP") {
          metrics.missingProviderTimestampUpdates++;
        } else if (reason === "DUPLICATE_PROVIDER_TIMESTAMP") {
          metrics.duplicateProviderUpdates++;
        } else {
          metrics.staleProviderUpdates++;
        }
        metrics.processingFailures++;
        logGpsEvent("GPS_PROVIDER_UPDATE_REJECTED", {
          cycleId,
          reason,
        });
      };

      for (const device of realGpsDevices) {
        const providerLocation = locationMap.get(String(device.deviceId));
        if (!providerLocation) {
          gpsWriteOperations.push({
            model: this.GpsDevice,
            method: "updateOne",
            filter: { _id: device._id, is_active: true },
            update: {
              $set: {
                healthStatus: "STALE",
                lastErrorCode: "DEVICE_NOT_IN_PROVIDER_RESPONSE",
              },
            },
          });
          continue;
        }
        const providerTimestamp = providerLocation.providerTimestamp
          ? new Date(providerLocation.providerTimestamp)
          : null;
        const providerTime = providerTimestamp?.getTime();
        const previousProviderTime = device.providerTimestamp
          ? new Date(device.providerTimestamp).getTime()
          : NaN;
        let rejectionReason = null;
        if (!Number.isFinite(providerTime)) {
          rejectionReason = "MISSING_OR_INVALID_PROVIDER_TIMESTAMP";
        } else if (providerTime > now.getTime() + 5 * 60 * 1000) {
          rejectionReason = "FUTURE_PROVIDER_TIMESTAMP";
        } else if (now.getTime() - providerTime > this.staleThresholdMs) {
          rejectionReason = "STALE_PROVIDER_TIMESTAMP";
        } else if (
          Number.isFinite(previousProviderTime) &&
          providerTime <= previousProviderTime
        ) {
          rejectionReason =
            providerTime === previousProviderTime
              ? "DUPLICATE_PROVIDER_TIMESTAMP"
              : "OUT_OF_ORDER_PROVIDER_TIMESTAMP";
        }
        if (rejectionReason) {
          if (rejectionReason === "STALE_PROVIDER_TIMESTAMP") {
            logStaleTimestampDiagnostic(
              providerLocation,
              now,
              this.staleThresholdMs,
              device.providerTimestamp,
            );
          }
          rejectProviderUpdate(providerLocation, rejectionReason);
          gpsWriteOperations.push({
            model: this.GpsDevice,
            method: "updateOne",
            filter: { _id: device._id, is_active: true },
            update: {
              $set: {
                healthStatus: "STALE",
                lastErrorCode: "STALE_PROVIDER_UPDATE",
              },
            },
          });
          continue;
        }
        gpsWriteOperations.push({
          model: this.GpsDevice,
          method: "updateOne",
          filter: { _id: device._id, is_active: true },
          update: {
            $set: {
              healthStatus: "HEALTHY",
              lastErrorCode: null,
              lastSuccessfulUpdate: now,
              lastLatitude: providerLocation.latitude,
              lastLongitude: providerLocation.longitude,
              ...(providerTimestamp ? { providerTimestamp } : {}),
            },
          },
        });
      }

      let existingLocations = [];
      if (buses.length) {
        existingLocations = await timedRead("locationReadDurationMs", () =>
          this.BusLiveLocation.find({
            bus_id: { $in: buses.map((bus) => bus._id) },
          })
            .select(
              "bus_id user_id latitude longitude speed is_online source gpsFenceToken providerTimestamp lastSuccessfulGpsUpdate lastUpdated publicationPreviewNumber updatedAt",
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

      for (const bus of buses) {
        const busId = bus._id;
        const previousLocation = locationsByBus.get(String(busId));
        const registeredDevice = devicesByBus.get(String(busId));
        if (registryStrict && !registeredDevice) continue;
        const providerLocation = getBusLocation(bus, locationMap, registeredDevice);
        let writeAttempted = false;
        let locationFilter = { bus_id: busId };
        let staleOnNoMatch = false;

        try {
          let update;
          if (providerLocation) {
            const providerTimestamp = providerLocation.providerTimestamp
              ? new Date(providerLocation.providerTimestamp)
              : null;
            const providerTime = providerTimestamp?.getTime();
            const previousProviderTime = previousLocation?.providerTimestamp
              ? new Date(previousLocation.providerTimestamp).getTime()
              : NaN;
            let rejectionReason = null;
            if (!Number.isFinite(providerTime)) {
              rejectionReason = "MISSING_OR_INVALID_PROVIDER_TIMESTAMP";
            } else if (providerTime > now.getTime() + 5 * 60 * 1000) {
              rejectionReason = "FUTURE_PROVIDER_TIMESTAMP";
            } else if (now.getTime() - providerTime > this.staleThresholdMs) {
              rejectionReason = "STALE_PROVIDER_TIMESTAMP";
            } else if (
              Number.isFinite(previousProviderTime) &&
              providerTime <= previousProviderTime
            ) {
              rejectionReason =
                providerTime === previousProviderTime
                  ? "DUPLICATE_PROVIDER_TIMESTAMP"
                  : "OUT_OF_ORDER_PROVIDER_TIMESTAMP";
            }
            if (rejectionReason) {
              if (rejectionReason === "STALE_PROVIDER_TIMESTAMP") {
                logStaleTimestampDiagnostic(
                  providerLocation,
                  now,
                  this.staleThresholdMs,
                  previousLocation?.providerTimestamp,
                );
              }
              rejectProviderUpdate(providerLocation, rejectionReason);
              continue;
            }
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
              ...(providerTimestamp ? { providerTimestamp } : {}),
            };
            const newerTimestampFilter =
              isProviderTimestampNewerExpression(providerTimestamp);
            metrics.acceptedProviderUpdates++;
            locationFilter = {
              bus_id: busId,
              ...newerTimestampFilter,
            };
            staleOnNoMatch = true;
          } else {
            const lastSuccess = previousLocation?.lastSuccessfulGpsUpdate
              ? new Date(previousLocation.lastSuccessfulGpsUpdate).getTime()
              : NaN;
            const shouldBeOnline =
              previousLocation?.is_online === true &&
              Number.isFinite(lastSuccess) &&
              now.getTime() - lastSuccess <= this.staleThresholdMs;
            update = {
              is_online: shouldBeOnline,
              lastUpdated: now,
              ...(registeredDevice?.source === "SIMULATED"
                ? { source: "simulated" }
                : {}),
            };
          }

          const publicationRooms = getLocationPublicationRooms(bus);
          const publicationStateChanged =
            !previousLocation ||
            previousLocation.is_online !== update.is_online ||
            (update.source && previousLocation.source !== update.source) ||
            (previousLocation.publicationPreviewNumber ?? null) !==
              (bus.preview_number == null ? null : String(bus.preview_number));
          const shouldPublish = Boolean(providerLocation || publicationStateChanged);
          const set = { ...update };
          if (shouldPublish) {
            Object.assign(set, {
              publicationPending: true,
              publicationRooms,
              publicationPreviewNumber: bus.preview_number ?? null,
              publicationNextAttemptAt: null,
              publicationRetryExhausted: false,
              publicationAttempts: 0,
              publicationClaimId: null,
              publicationClaimUntil: null,
              publicationCreatedAt: now,
            });
          }
          const filter = locationFilter || { bus_id: busId };
          writeAttempted = true;
          gpsWriteOperations.push({
            model: this.BusLiveLocation,
            method: "updateOne",
            filter,
            update: {
              $setOnInsert: {
                bus_id: busId,
                publishedVersion: 0n,
              },
              ...(shouldPublish ? { $inc: { locationVersion: 1n } } : {}),
              $set: set,
            },
            options: { upsert: !previousLocation },
            requireMatch: true,
            staleOnNoMatch,
            providerAccepted: Boolean(providerLocation),
            ...(providerLocation
              ? {
                  providerTimestamp: new Date(
                    providerLocation.providerTimestamp,
                  ),
                  providerLastSuccessfulUpdate: now,
                }
              : {}),
          });
        } catch (error) {
          if (error.gpsLeaseError) throw error;
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
      const writeStarted = performance.now();
      const writeResults = await this.persistGpsOperations(
        gpsWriteOperations,
        expectedConfigVersion,
      );
      metrics.locationWriteDurationMs += elapsedMs(writeStarted);
      metrics.successfulWrites = writeResults.committed.filter(
        (operation) => operation.model === this.BusLiveLocation,
      ).length;
      metrics.failedWrites = writeResults.failed.filter(
        ({ operation }) => operation.model === this.BusLiveLocation,
      ).length;
      metrics.staleProviderUpdates += writeResults.rejected.filter(
        (operation) => operation.model === this.BusLiveLocation,
      ).length;
      for (const operation of writeResults.rejected) {
        logGpsEvent("GPS_PROVIDER_UPDATE_REJECTED", {
          cycleId,
          reason: operation.staleOnNoMatch
            ? "CONCURRENTLY_SUPERSEDED"
            : "WRITE_REJECTED",
        });
      }
      for (const { operation, error } of writeResults.failed) {
        logGpsEvent(
          operation.model === this.BusLiveLocation
            ? "GPS_LOCATION_WRITE_FAILED"
            : "GPS_DEVICE_WRITE_FAILED",
          { cycleId, ...getSafeError(error) },
        );
      }
      metrics.status =
        metrics.providerFailures ||
        metrics.failedWrites ||
        metrics.processingFailures
          ? "COMPLETED_WITH_ERRORS"
          : "COMPLETED";
    } catch (error) {
      if (error.gpsConfigurationError) {
        metrics.status = "SKIPPED_CONFIGURATION_CHANGE";
        return;
      }
      if (error.gpsLeaseError) this.notifyOwnershipFailure(error);
      metrics.failureStage ||= "CYCLE";
      const safeError = getSafeError(error);
      metrics.failureName ||= safeError.name;
      metrics.failureCode ??= safeError.code;
      throw error;
    } finally {
      this.providerAbortController = null;
      metrics.completedAt = new Date().toISOString();
      metrics.durationMs = elapsedMs(cycleStarted);
      metrics.skippedTimerTicks = this.skippedTimerTicks;
      this.lastCycleMetrics = { ...metrics };
      logGpsEvent("GPS_CYCLE_COMPLETED", metrics);
    }
  }

}

const gpsSyncWorker = new GpsSyncWorker({ GpsDeviceModel: GpsDevice });
gpsSyncWorker.GpsSyncWorker = GpsSyncWorker;
gpsSyncWorker.getBusLocation = getBusLocation;
gpsSyncWorker.getLocationPublicationRooms = getLocationPublicationRooms;
gpsSyncWorker.GPS_SYNC_INTERVAL_MS = GPS_SYNC_INTERVAL_MS;

module.exports = gpsSyncWorker;
