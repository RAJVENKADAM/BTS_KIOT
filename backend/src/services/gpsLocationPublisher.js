"use strict";

const { randomUUID } = require("node:crypto");
const BusLiveLocation = require("../models/BusLiveLocation");
const { getIO } = require("../socket");

const DEFAULT_CLAIM_TTL_MS = 30_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MAX_RETRY_ATTEMPTS = 8;

function logPublicationEvent(event, details = {}) {
  try {
    console.log(JSON.stringify({ event, ...details }));
  } catch {
    // Publication logging must not affect durable state.
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

function toVersionString(value) {
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  if (value?._bsontype === "Long" && !value.isNegative()) {
    return value.toString();
  }
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function buildLocationPayload(location, staleThresholdMs) {
  const lastSuccessfulGpsUpdate = location.lastSuccessfulGpsUpdate ?? null;
  return {
    previewNumber: location.publicationPreviewNumber ?? null,
    latitude: location.latitude ?? null,
    longitude: location.longitude ?? null,
    speed: location.speed ?? 0,
    status: location.is_online ? "online" : "offline",
    source: location.source || "offline",
    is_online: !!location.is_online,
    lastSuccessfulGpsUpdate,
    lastUpdated:
      lastSuccessfulGpsUpdate ?? location.updatedAt ?? location.lastUpdated ?? null,
    providerTimestamp: location.providerTimestamp ?? null,
    locationVersion: toVersionString(location.locationVersion),
    gpsOfflineThresholdMs: staleThresholdMs,
  };
}

function createGpsLocationPublisher({
  model = BusLiveLocation,
  socketGetter = getIO,
  transportReady = () => true,
  transportGeneration = () => 0,
  publishEvent,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  intervalMs = 1_000,
  claimTtlMs = DEFAULT_CLAIM_TTL_MS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  batchSize = DEFAULT_BATCH_SIZE,
  maxRetryAttempts = DEFAULT_MAX_RETRY_ATTEMPTS,
  staleThresholdMs =
    Number(process.env.GPS_OFFLINE_THRESHOLD_MS) || 3 * 60 * 1000,
  claimIdFactory = randomUUID,
} = {}) {
  let started = false;
  let interval = null;
  let inFlightDrain = null;
  let startupRecovery = null;
  let lastDrain = null;
  let lastBacklogCheckAt = 0;
  let observedTransportGeneration = transportGeneration();

  function claimFilter() {
    const claimUntilType = { $type: "$publicationClaimUntil" };
    const nextAttemptType = { $type: "$publicationNextAttemptAt" };
    return {
      publicationPending: true,
      publicationRetryExhausted: { $ne: true },
      $expr: {
        $and: [
          {
            $or: [
              { $in: [claimUntilType, ["missing", "null"]] },
              {
                $and: [
                  { $eq: [claimUntilType, "date"] },
                  { $lte: ["$publicationClaimUntil", "$$NOW"] },
                ],
              },
            ],
          },
          {
            $or: [
              { $in: [nextAttemptType, ["missing", "null"]] },
              {
                $and: [
                  { $eq: [nextAttemptType, "date"] },
                  { $lte: ["$publicationNextAttemptAt", "$$NOW"] },
                ],
              },
            ],
          },
        ],
      },
    };
  }

  async function claimNext() {
    const claimId = claimIdFactory();
    return model.findOneAndUpdate(
      claimFilter(),
      [
        {
          $set: {
            publicationClaimId: claimId,
            publicationClaimUntil: {
              $dateAdd: {
                startDate: "$$NOW",
                unit: "millisecond",
                amount: claimTtlMs,
              },
            },
            publicationAttempts: {
              $min: [
                { $add: [{ $ifNull: ["$publicationAttempts", 0] }, 1] },
                2_147_483_647,
              ],
            },
          },
        },
      ],
      {
        new: true,
        returnDocument: "after",
        sort: { updatedAt: 1, _id: 1 },
        lean: true,
      },
    );
  }

  async function publish(location, io) {
    const version = toVersionString(location.locationVersion);
    if (!version) throw new Error("GPS location publication version is invalid.");

    const rooms = Array.isArray(location.publicationRooms)
      ? [...new Set(location.publicationRooms.filter(
          (room) => typeof room === "string" && room.length > 0,
        ))]
      : [];
    if (!rooms.length) {
      return version;
    }

    const payload = {
      ...buildLocationPayload(location, staleThresholdMs),
      locationVersion: version,
      eventId: `${String(location._id)}:${version}`,
    };
    if (publishEvent) {
      await publishEvent(rooms, "locationUpdate", payload);
      return version;
    }

    let broadcaster = io;
    for (const room of rooms) broadcaster = broadcaster.to(room);
    broadcaster.emit("locationUpdate", payload);
    return version;
  }

  function activeClaimFilter(location, claimId) {
    return {
      _id: location._id,
      publicationClaimId: claimId,
      $expr: {
        $and: [
          { $eq: [{ $type: "$publicationClaimUntil" }, "date"] },
          { $gt: ["$publicationClaimUntil", "$$NOW"] },
        ],
      },
    };
  }

  async function markPublished(location, claimId, version) {
    return model.updateOne(
      activeClaimFilter(location, claimId),
      [
        {
          $set: {
            publishedVersion: {
              $max: [
                { $ifNull: ["$publishedVersion", 0n] },
                BigInt(version),
              ],
            },
            publicationPending: {
              $gt: [
                { $ifNull: ["$locationVersion", 0n] },
                BigInt(version),
              ],
            },
            publicationClaimId: null,
            publicationClaimUntil: null,
            publicationNextAttemptAt: null,
            publicationAttempts: 0,
            publicationRetryExhausted: false,
            publicationLastErrorCode: null,
            publicationLastPublishedAt: "$$NOW",
          },
        },
      ],
    );
  }

  async function releaseAfterFailure(location, claimId, attempt, error) {
    const delayMs = Math.min(
      MAX_RETRY_DELAY_MS,
      retryBaseMs * 2 ** Math.min(Math.max(0, attempt - 1), 16),
    );
    const safeError = getSafeError(error);
    await model.updateOne(
      activeClaimFilter(location, claimId),
      [
        {
          $set: {
            publicationPending: true,
            publicationClaimId: null,
            publicationClaimUntil: null,
            publicationLastErrorCode: safeError.code || safeError.name,
            publicationRetryExhausted: attempt >= maxRetryAttempts,
            publicationNextAttemptAt:
              attempt >= maxRetryAttempts
                ? null
                : {
                    $dateAdd: {
                      startDate: "$$NOW",
                      unit: "millisecond",
                      amount: delayMs,
                    },
                  },
          },
        },
      ],
    );
    return {
      delayMs,
      retryExhausted: attempt >= maxRetryAttempts,
      safeError,
    };
  }

  async function resetExhaustedRetries() {
    if (typeof model.updateMany !== "function") return;
    await model.updateMany(
      { publicationPending: true, publicationRetryExhausted: true },
      [
        {
          $set: {
            publicationRetryExhausted: false,
            publicationAttempts: 0,
            publicationNextAttemptAt: null,
          },
        },
      ],
    );
  }

  async function resetPendingRetries() {
    if (typeof model.updateMany !== "function") return;
    await model.updateMany(
      { publicationPending: true },
      [
        {
          $set: {
            publicationRetryExhausted: false,
            publicationAttempts: 0,
            publicationNextAttemptAt: null,
          },
        },
      ],
    );
  }

  async function performDrain() {
    if (!transportReady()) return { published: 0, failed: 0, deferred: true };
    const currentGeneration = transportGeneration();
    if (currentGeneration !== observedTransportGeneration) {
      await resetPendingRetries();
      observedTransportGeneration = currentGeneration;
    }
    const io = socketGetter();
    if (!io) return { published: 0, failed: 0, deferred: true };

    let published = 0;
    let failed = 0;
    let maxDelayMs = 0;
    let pending = lastDrain?.pending ?? null;
    for (let index = 0; index < batchSize; index += 1) {
      if (!transportReady()) break;
      const location = await claimNext();
      if (!location) break;
      const claimId = location.publicationClaimId;
      const version = toVersionString(location.locationVersion);
      if (typeof claimId !== "string") {
        failed += 1;
        logPublicationEvent("GPS_LOCATION_PUBLICATION_CLAIM_INVALID");
        continue;
      }
      if (!version) {
        failed += 1;
        const error = new Error("Claimed GPS publication version is invalid.");
        await releaseAfterFailure(
          location,
          claimId,
          Number(location.publicationAttempts) || 1,
          error,
        );
        continue;
      }

      try {
        await publish(location, io);
        const result = await markPublished(location, claimId, version);
        if (result.matchedCount === 1) {
          published += 1;
          if (location.publicationCreatedAt instanceof Date) {
            maxDelayMs = Math.max(
              0,
              Date.now() - location.publicationCreatedAt.getTime(),
              maxDelayMs,
            );
          }
        }
      } catch (error) {
        const { delayMs, retryExhausted, safeError } = await releaseAfterFailure(
          location,
          claimId,
          Number(location.publicationAttempts) || 1,
          error,
        );
        failed += 1;
        logPublicationEvent("GPS_LOCATION_PUBLICATION_FAILED", {
          ...safeError,
          retryInMs: delayMs,
          retryExhausted,
        });
      }
    }

    if (
      typeof model.countDocuments === "function" &&
      Date.now() - lastBacklogCheckAt >= 30_000
    ) {
      pending = await model.countDocuments({ publicationPending: true });
      lastBacklogCheckAt = Date.now();
    }
    lastDrain = {
      at: new Date().toISOString(),
      published,
      failed,
      maxDelayMs,
      pending,
    };
    if (published || failed || pending > 0) {
      logPublicationEvent("GPS_LOCATION_PUBLICATION_DRAIN_COMPLETED", lastDrain);
    }
    return lastDrain;
  }

  function drain() {
    if (inFlightDrain) return inFlightDrain;
    inFlightDrain = performDrain().catch((error) => {
      logPublicationEvent("GPS_LOCATION_PUBLICATION_DRAIN_FAILED", getSafeError(error));
      throw error;
    }).finally(() => {
      inFlightDrain = null;
    });
    return inFlightDrain;
  }

  function start() {
    if (started) return;
    started = true;
    startupRecovery = resetExhaustedRetries()
      .then(() => {
        if (started) return drain();
        return null;
      })
      .catch((error) => {
        logPublicationEvent(
          "GPS_LOCATION_PUBLICATION_RECOVERY_RESET_FAILED",
          getSafeError(error),
        );
      })
      .finally(() => {
        startupRecovery = null;
      });
    interval = setIntervalFn(() => {
      if (startupRecovery) return;
      void drain().catch(() => {});
    }, intervalMs);
    interval?.unref?.();
  }

  async function stop() {
    started = false;
    if (interval) {
      clearIntervalFn(interval);
      interval = null;
    }
    await Promise.all(
      [startupRecovery, inFlightDrain].filter(Boolean),
    );
  }

  return {
    drain,
    getStatus: () => ({ started, draining: Boolean(inFlightDrain), lastDrain }),
    start,
    stop,
  };
}

module.exports = {
  createGpsLocationPublisher,
  toVersionString,
};
