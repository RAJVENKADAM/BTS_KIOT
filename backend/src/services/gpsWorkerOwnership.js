"use strict";

const { randomUUID } = require("node:crypto");
const mongoose = require("mongoose");
const GpsWorkerOwnership = require("../models/GpsWorkerOwnership");

const OWNERSHIP_ID = "gps-worker";
const DEFAULT_LEASE_TTL_MS = 90_000;
const MAX_TRANSACTION_ATTEMPTS = 3;
const MAX_COMMIT_ATTEMPTS = 3;
const LONG_ONE = mongoose.mongo.Long.fromInt(1);
const LONG_MAX = mongoose.mongo.Long.fromString("9223372036854775807");

function logOwnershipEvent(event, details = {}) {
  try {
    console.log(JSON.stringify({ event, ...details }));
  } catch {
    // Ownership observability must not affect fencing.
  }
}

function makeError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.gpsLeaseError = true;
  return error;
}

function makeConfigurationError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.gpsConfigurationError = true;
  return error;
}

function isLabelled(error, label) {
  return typeof error?.hasErrorLabel === "function"
    ? error.hasErrorLabel(label)
    : Array.isArray(error?.errorLabels) && error.errorLabels.includes(label);
}

function isMongoConnectivityError(error) {
  const connectivityNames = new Set([
    "MongoNetworkError",
    "MongoNetworkTimeoutError",
    "MongoServerSelectionError",
    "MongoTopologyClosedError",
  ]);
  const connectivityCodes = new Set([
    6, 7, 89, 91, 189, 11600, 11602, 13435, 13436,
  ]);
  return connectivityNames.has(error?.name) || connectivityCodes.has(error?.code);
}

function isValidState(document) {
  if (
    !document ||
    document._id !== OWNERSHIP_ID ||
    !isNonnegativeInt64(document.token) ||
    !isNonnegativeInt64(document.writeVersion) ||
    !isNonnegativeInt64(document.configVersion) ||
    !["active", "inactive"].includes(document.state) ||
    !(document.leaseExpiresAt instanceof Date) ||
    !Number.isFinite(document.leaseExpiresAt.getTime()) ||
    !(document.updatedAt instanceof Date) ||
    !Number.isFinite(document.updatedAt.getTime())
  ) {
    return false;
  }
  return document.state === "active"
    ? typeof document.ownerId === "string" && document.ownerId.length > 0
    : document.ownerId === null;
}

function isNonnegativeInt64(value) {
  return (
    value?._bsontype === "Long" &&
    value.greaterThanOrEqual(mongoose.mongo.Long.ZERO) &&
    value.lessThanOrEqual(LONG_MAX)
  );
}

function toBigInt(value) {
  if (
    typeof value === "bigint" &&
    value >= 0n &&
    value <= 9223372036854775807n
  ) {
    return value;
  }
  if (value?._bsontype === "Long" && isNonnegativeInt64(value)) {
    return value.toBigInt();
  }
  throw makeError("GPS worker ownership token is invalid.", "GPS_OWNERSHIP_INVALID");
}

function int64TypeExpression(field, { equals, lessThan } = {}) {
  const conditions = [
    { $eq: [{ $type: `$${field}` }, "long"] },
    { $gte: [`$${field}`, mongoose.mongo.Long.ZERO] },
  ];
  if (equals !== undefined) {
    conditions.push({ $eq: [`$${field}`, equals] });
  }
  if (lessThan !== undefined) {
    conditions.push({ $lt: [`$${field}`, lessThan] });
  }
  return conditions;
}

function getLeaseTtlMs(env = process.env) {
  const raw = env.GPS_WORKER_LEASE_TTL_MS;
  const ttlMs = raw === undefined || raw === "" ? DEFAULT_LEASE_TTL_MS : Number(raw);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 10_000 || ttlMs > 300_000) {
    throw new Error("GPS_WORKER_LEASE_TTL_MS must be between 10000 and 300000.");
  }
  return ttlMs;
}

function createGpsWorkerOwnershipService({
  collection = GpsWorkerOwnership.collection,
  connection = mongoose.connection,
  ownerIdFactory = randomUUID,
  maxTransactionAttempts = MAX_TRANSACTION_ATTEMPTS,
  maxCommitAttempts = MAX_COMMIT_ATTEMPTS,
} = {}) {
  async function activate({ ttlMs = DEFAULT_LEASE_TTL_MS } = {}) {
    const ownerId = ownerIdFactory();
    const document = await collection.findOneAndUpdate(
      {
        _id: OWNERSHIP_ID,
        leaseExpiresAt: { $type: "date" },
        updatedAt: { $type: "date" },
        $expr: {
          $and: [
            ...int64TypeExpression("token", { lessThan: LONG_MAX }),
            ...int64TypeExpression("writeVersion"),
            ...int64TypeExpression("configVersion"),
            {
              $or: [
                { $eq: ["$state", "inactive"] },
                {
                  $and: [
                    { $eq: ["$state", "active"] },
                    { $lte: ["$leaseExpiresAt", "$$NOW"] },
                  ],
                },
              ],
            },
            {
              $or: [
                {
                  $and: [
                    { $eq: ["$state", "inactive"] },
                    { $eq: ["$ownerId", null] },
                  ],
                },
                {
                  $and: [
                    { $eq: ["$state", "active"] },
                    { $eq: [{ $type: "$ownerId" }, "string"] },
                    { $ne: ["$ownerId", ""] },
                  ],
                },
              ],
            },
          ],
        },
      },
      [
        {
          $set: {
            token: { $add: ["$token", LONG_ONE] },
            ownerId,
            state: "active",
            leaseExpiresAt: {
              $dateAdd: {
                startDate: "$$NOW",
                unit: "millisecond",
                amount: ttlMs,
              },
            },
            updatedAt: "$$NOW",
          },
        },
      ],
      {
        returnDocument: "after",
        writeConcern: { w: "majority" },
        promoteLongs: false,
      },
    );

    if (!document) {
      const current = await collection.findOne(
        { _id: OWNERSHIP_ID },
        { promoteLongs: false },
      );
      if (!current) {
        throw makeError(
          "GPS worker ownership state is not provisioned.",
          "GPS_OWNERSHIP_STATE_MISSING",
        );
      }
      if (!isValidState(current)) {
        throw makeError(
          "GPS worker ownership state is invalid.",
          "GPS_OWNERSHIP_INVALID",
        );
      }
      return null;
    }
    if (!isValidState(document) || document.ownerId !== ownerId || document.state !== "active") {
      throw makeError(
        "MongoDB did not confirm GPS worker ownership activation.",
        "GPS_OWNERSHIP_ACTIVATION_UNCONFIRMED",
      );
    }

    const token = toBigInt(document.token);
    logOwnershipEvent("GPS_WORKER_OWNERSHIP_ACTIVATED", { ttlMs });
    let ownershipUncertain = false;
    function int64(value) {
      if (typeof value === "bigint") {
        if (value < 0n || value > 9223372036854775807n) {
          throw makeError("GPS configuration version is invalid.", "GPS_OWNERSHIP_INVALID");
        }
        return mongoose.mongo.Long.fromString(value.toString());
      }
      if (value?._bsontype === "Long" && isNonnegativeInt64(value)) return value;
      throw makeError("GPS configuration version is invalid.", "GPS_OWNERSHIP_INVALID");
    }

    const leaseFilter = (
      expectedConfigVersion,
      {
        requireWriteCapacity = false,
        requireUnexpiredLease = true,
      } = {},
    ) => ({
      _id: OWNERSHIP_ID,
      ownerId,
      state: "active",
      $expr: {
        $and: [
          ...int64TypeExpression("token", {
            equals: mongoose.mongo.Long.fromString(token.toString()),
          }),
          ...int64TypeExpression(
            "writeVersion",
            requireWriteCapacity ? { lessThan: LONG_MAX } : {},
          ),
          ...int64TypeExpression(
            "configVersion",
            expectedConfigVersion === undefined
              ? {}
              : { equals: int64(expectedConfigVersion) },
          ),
          ...(requireUnexpiredLease
            ? [{ $gt: ["$leaseExpiresAt", "$$NOW"] }]
            : []),
        ],
      },
    });

    async function runTransaction(operation, { expectedConfigVersion } = {}) {
      if (ownershipUncertain) {
        throw makeError(
          "GPS worker ownership is uncertain after an unresolved commit.",
          "GPS_OWNERSHIP_UNCERTAIN",
        );
      }
      let session;
      try {
        session = await connection.startSession();
      } catch (error) {
        error.gpsLeaseError = true;
        throw error;
      }
      try {
        for (let attempt = 1; attempt <= maxTransactionAttempts; attempt += 1) {
          try {
            session.startTransaction({
              readConcern: { level: "snapshot" },
              writeConcern: { w: "majority" },
              readPreference: "primary",
            });
          } catch (error) {
            error.gpsLeaseError = true;
            throw error;
          }
          let authorityConfirmed = false;
          let committing = false;
          try {
            const authorityResult = await collection.updateOne(
              leaseFilter(expectedConfigVersion, {
                requireWriteCapacity: true,
              }),
              [
                {
                  $set: {
                    writeVersion: { $add: ["$writeVersion", LONG_ONE] },
                    updatedAt: "$$NOW",
                  },
                },
              ],
              { session },
            );
            if (authorityResult.matchedCount !== 1) {
              if (expectedConfigVersion !== undefined) {
                const current = await collection.findOne(
                  leaseFilter(),
                  { session, promoteLongs: false },
                );
                if (
                  isValidState(current) &&
                  current.ownerId === ownerId &&
                  toBigInt(current.configVersion) !==
                    toBigInt(expectedConfigVersion)
                ) {
                  throw makeConfigurationError(
                    "GPS configuration changed during the worker cycle.",
                    "GPS_CONFIGURATION_CHANGED",
                  );
                }
              }
              throw makeError(
                "GPS worker no longer owns the MongoDB lease.",
                "GPS_LEASE_LOST",
              );
            }
            authorityConfirmed = true;

            const result = await operation(session);
            committing = true;
            let committed = false;
            for (let commitAttempt = 1; commitAttempt <= maxCommitAttempts; commitAttempt += 1) {
              try {
                await session.commitTransaction();
                committed = true;
                break;
              } catch (error) {
                if (isLabelled(error, "UnknownTransactionCommitResult")) {
                  if (commitAttempt === maxCommitAttempts) {
                    ownershipUncertain = true;
                    throw makeError(
                      "GPS transaction commit result is unknown; ownership is suspended.",
                      "GPS_OWNERSHIP_UNCERTAIN",
                    );
                  }
                  logOwnershipEvent("GPS_OWNERSHIP_COMMIT_RETRY", {
                    attempt: commitAttempt,
                    maxAttempts: maxCommitAttempts,
                  });
                  continue;
                }
                throw error;
              }
            }
            if (committed) return result;
          } catch (error) {
            try {
              if (session.inTransaction()) await session.abortTransaction();
            } catch {
              // Preserve the transaction error; no worker writes are retried after ownership loss.
            }
            if (
              error?.gpsLeaseError ||
              error?.gpsConfigurationError
            ) {
              throw error;
            }
            if (
              isLabelled(error, "TransientTransactionError") &&
              attempt < maxTransactionAttempts
            ) {
              logOwnershipEvent("GPS_OWNERSHIP_TRANSACTION_RETRY", {
                attempt,
                maxAttempts: maxTransactionAttempts,
              });
              continue;
            }
            if (
              !authorityConfirmed ||
              committing ||
              isMongoConnectivityError(error) ||
              isLabelled(error, "TransientTransactionError")
            ) {
              error.gpsLeaseError = true;
            }
            throw error;
          }
        }
        throw makeError(
          "GPS transaction retry limit was exceeded.",
          "GPS_TRANSACTION_RETRY_EXHAUSTED",
        );
      } finally {
        try {
          await session.endSession();
        } catch (error) {
          error.gpsLeaseError = true;
          throw error;
        }
      }
    }

    return {
      ownerId,
      fencingToken: token,
      ttlMs,
      runTransaction,
    async getConfigurationVersion() {
      if (ownershipUncertain) {
        throw makeError(
          "GPS worker ownership is uncertain after an unresolved commit.",
          "GPS_OWNERSHIP_UNCERTAIN",
        );
      }
      const current = await collection.findOne(leaseFilter(), {
        promoteLongs: false,
      });
      if (!isValidState(current) || current.ownerId !== ownerId) {
        throw makeError(
          "GPS worker ownership state is invalid or no longer active.",
          "GPS_LEASE_LOST",
        );
      }
      return toBigInt(current.configVersion);
    },
      async renew() {
        if (ownershipUncertain) return false;
        const result = await collection.updateOne(
          leaseFilter(),
          [
            {
              $set: {
                leaseExpiresAt: {
                  $dateAdd: {
                    startDate: "$$NOW",
                    unit: "millisecond",
                    amount: ttlMs,
                  },
                },
                updatedAt: "$$NOW",
              },
            },
          ],
          { writeConcern: { w: "majority" } },
        );
        const renewed = result.matchedCount === 1;
        if (!renewed) {
          logOwnershipEvent("GPS_WORKER_OWNERSHIP_RENEWAL_REJECTED");
        }
        return renewed;
      },
      async release() {
        if (ownershipUncertain) return false;
        const result = await collection.updateOne(
          leaseFilter(undefined, { requireUnexpiredLease: false }),
          [{ $set: { state: "inactive", ownerId: null, leaseExpiresAt: "$$NOW", updatedAt: "$$NOW" } }],
          { writeConcern: { w: "majority" } },
        );
        const released = result.matchedCount === 1;
        logOwnershipEvent(
          released
            ? "GPS_WORKER_OWNERSHIP_RELEASED"
            : "GPS_WORKER_OWNERSHIP_RELEASE_REJECTED",
        );
        return released;
      },
      async assertOwned() {
        if (ownershipUncertain) return false;
        const current = await collection.findOne(leaseFilter(), {
          promoteLongs: false,
        });
        return Boolean(current && current.ownerId === ownerId);
      },
    };
  }

  async function runGpsConfigurationTransaction(operation) {
    const session = await connection.startSession();
    try {
      for (let attempt = 1; attempt <= maxTransactionAttempts; attempt += 1) {
        session.startTransaction({
          readConcern: { level: "snapshot" },
          writeConcern: { w: "majority" },
          readPreference: "primary",
        });
        let operationStarted = false;
        try {
          const current = await collection.findOne(
            { _id: OWNERSHIP_ID },
            { session, promoteLongs: false },
          );
          if (!isValidState(current)) {
            throw makeError(
              "GPS worker ownership state is missing or invalid.",
              current ? "GPS_OWNERSHIP_INVALID" : "GPS_OWNERSHIP_STATE_MISSING",
            );
          }
          const barrier = await collection.updateOne(
            {
              _id: OWNERSHIP_ID,
              $expr: {
                $and: [
                  ...int64TypeExpression("token", {
                    equals: int64(current.token),
                  }),
                  ...int64TypeExpression("writeVersion", {
                    lessThan: LONG_MAX,
                  }),
                  ...int64TypeExpression("configVersion", {
                    equals: int64(current.configVersion),
                    lessThan: LONG_MAX,
                  }),
                ],
              },
            },
            [
              {
                $set: {
                  configVersion: { $add: ["$configVersion", LONG_ONE] },
                  writeVersion: { $add: ["$writeVersion", LONG_ONE] },
                  updatedAt: "$$NOW",
                },
              },
            ],
            { session },
          );
          if (barrier.matchedCount !== 1) {
            throw makeConfigurationError(
              "GPS configuration changed during its transaction.",
              "GPS_CONFIGURATION_CHANGED",
            );
          }

          operationStarted = true;
          const result = await operation(session);
          let committed = false;
          for (let commitAttempt = 1; commitAttempt <= maxCommitAttempts; commitAttempt += 1) {
            try {
              await session.commitTransaction();
              committed = true;
              break;
            } catch (error) {
              if (!isLabelled(error, "UnknownTransactionCommitResult")) throw error;
              if (commitAttempt === maxCommitAttempts) {
                throw makeError(
                  "GPS configuration transaction commit result is unknown.",
                  "GPS_CONFIGURATION_COMMIT_UNCERTAIN",
                );
              }
              logOwnershipEvent("GPS_CONFIGURATION_COMMIT_RETRY", {
                attempt: commitAttempt,
                maxAttempts: maxCommitAttempts,
              });
            }
          }
          if (committed) return result;
        } catch (error) {
          try {
            if (session.inTransaction()) await session.abortTransaction();
          } catch {
            // Preserve the transaction error.
          }
          if (error?.gpsLeaseError || !isLabelled(error, "TransientTransactionError")) {
            throw error;
          }
          if (operationStarted || attempt === maxTransactionAttempts) throw error;
          logOwnershipEvent("GPS_CONFIGURATION_TRANSACTION_RETRY", {
            attempt,
            maxAttempts: maxTransactionAttempts,
          });
        }
      }
      throw makeError(
        "GPS configuration transaction retry limit was exceeded.",
        "GPS_CONFIGURATION_RETRY_EXHAUSTED",
      );
    } finally {
      await session.endSession();
    }
  }

  function int64(value) {
    if (typeof value === "bigint") {
      if (value < 0n || value > 9223372036854775807n) {
        throw makeError("GPS ownership value is invalid.", "GPS_OWNERSHIP_INVALID");
      }
      return mongoose.mongo.Long.fromString(value.toString());
    }
    if (value?._bsontype === "Long" && isNonnegativeInt64(value)) return value;
    throw makeError("GPS ownership value is invalid.", "GPS_OWNERSHIP_INVALID");
  }

  return { activate, runGpsConfigurationTransaction };
}

const defaultService = createGpsWorkerOwnershipService();

module.exports = {
  DEFAULT_LEASE_TTL_MS,
  GPS_WORKER_OWNERSHIP_ID: OWNERSHIP_ID,
  createGpsWorkerOwnershipService,
  getGpsWorkerLeaseTtlMs: getLeaseTtlMs,
  activateGpsWorkerOwnership: (options) => defaultService.activate(options),
  runGpsConfigurationTransaction: (operation) =>
    defaultService.runGpsConfigurationTransaction(operation),
  isValidGpsWorkerOwnershipState: isValidState,
  toGpsWorkerOwnershipBigInt: toBigInt,
};
