const { createHmac, randomUUID } = require("node:crypto");
const mongoose = require("mongoose");
const LoginAttemptBucket = require("../models/LoginAttemptBucket");
const { sanitizeDiagnosticText } = require("./safeErrorLog");

const INDEX_NAME = "ttl_expires_at";
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_ACCOUNT_LIMIT = 10;
const DEFAULT_PENDING_RESERVATION_TTL_MS = 2 * 60 * 1000;
const TRANSACTION_TIMEOUT_MS = 5000;
const INDEX_CHECK_INTERVAL_MS = 5_000;

const positiveInteger = (name, fallback, max) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
};

const LIMITER_CONFIG = Object.freeze({
  windowMs: positiveInteger(
    "LOGIN_ATTEMPT_WINDOW_MS",
    DEFAULT_WINDOW_MS,
    24 * 60 * 60 * 1000,
  ),
  accountLimit: positiveInteger(
    "LOGIN_MAX_ACCOUNT_FAILURES",
    DEFAULT_ACCOUNT_LIMIT,
    100,
  ),
  pendingReservationTtlMs: positiveInteger(
    "LOGIN_PENDING_RESERVATION_TTL_MS",
    DEFAULT_PENDING_RESERVATION_TTL_MS,
    5 * 60 * 1000,
  ),
});

function getDiagnosticError(error) {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (
      !current?.cause ||
      typeof current.cause !== "object" ||
      current.cause === current
    ) {
      break;
    }
    current = current.cause;
  }
  return current;
}

function logLimiterFailure(stage, error) {
  const diagnostic = getDiagnosticError(error);
  const rawMessage =
    typeof diagnostic?.message === "string" ? diagnostic.message : "";
  const message = sanitizeDiagnosticText(rawMessage)
    ?.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_ACCOUNT]")
    ?.replace(/account:[a-f0-9]{64}/gi, "account:[REDACTED]")
    ?.slice(0, 1_000);
  const labels = Array.isArray(diagnostic?.errorLabels)
    ? [...new Set(
        diagnostic.errorLabels.filter(
          (label) =>
            typeof label === "string" &&
            /^[A-Za-z][A-Za-z0-9]{0,59}$/.test(label),
        ),
      )].slice(0, 8)
    : [];
  const details = {
    stage,
    name:
      typeof diagnostic?.name === "string" &&
      /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(diagnostic.name)
        ? diagnostic.name
        : "Error",
    code:
      Number.isSafeInteger(diagnostic?.code) ||
      (typeof diagnostic?.code === "string" &&
        /^[A-Z0-9_]{1,60}$/.test(diagnostic.code))
        ? diagnostic.code
        : null,
    codeName:
      typeof diagnostic?.codeName === "string" &&
      /^[A-Za-z0-9_]{1,60}$/.test(diagnostic.codeName)
        ? diagnostic.codeName
        : null,
    errorLabels: labels,
    message: message || null,
  };
  try {
    console.error("Login attempt limiter operation failed", details);
  } catch {
    // Diagnostics must not change authentication behavior.
  }
}

function limiterUnavailable(stage, cause) {
  const error = new Error(
    "Login protection is temporarily unavailable",
    cause ? { cause } : undefined,
  );
  error.status = 503;
  error.code = "LOGIN_LIMITER_UNAVAILABLE";
  error.retryAfter = 2;
  error.failureStage = stage;
  logLimiterFailure(stage, cause);
  return error;
}

function bucketId(kind, identity, secret) {
  if (typeof secret !== "string" || secret.length < 1) {
    throw limiterUnavailable("LOGIN_LIMITER_CONFIGURATION_FAILED");
  }
  return `${kind}:${createHmac("sha256", secret)
    .update(identity)
    .digest("hex")}`;
}

function normalizeEmail(email) {
  if (typeof email !== "string" || !email.trim()) {
    throw limiterUnavailable("LOGIN_LIMITER_CONFIGURATION_FAILED");
  }
  return email.trim().toLowerCase();
}

function pruneAttempts(bucket, now, windowMs, pendingReservationTtlMs) {
  return (bucket?.attempts || []).filter((attempt) => {
    const createdAt = new Date(attempt.createdAt).getTime();
    if (!Number.isFinite(createdAt)) return false;
    const ttl =
      attempt.state === "pending" ? pendingReservationTtlMs : windowMs;
    return now - createdAt < ttl;
  });
}

function retryAfterSeconds(
  attempts,
  now,
  windowMs,
  pendingReservationTtlMs,
) {
  if (!attempts.length) return 1;
  const nextAvailableAt = Math.min(
    ...attempts.map((attempt) => {
      const ttl =
        attempt.state === "pending" ? pendingReservationTtlMs : windowMs;
      return new Date(attempt.createdAt).getTime() + ttl;
    }),
  );
  return Math.max(1, Math.ceil((nextAvailableAt - now) / 1000));
}

function createLoginAttemptLimiter({
  mongoose: mongo = mongoose,
  collection = LoginAttemptBucket.collection,
  secretProvider = () =>
    process.env.LOGIN_LIMITER_HASH_SECRET || process.env.JWT_SECRET,
  now = () => Date.now(),
  windowMs = LIMITER_CONFIG.windowMs,
  accountLimit = LIMITER_CONFIG.accountLimit,
  pendingReservationTtlMs = LIMITER_CONFIG.pendingReservationTtlMs,
  transactionTimeoutMs = TRANSACTION_TIMEOUT_MS,
  indexCheckIntervalMs = INDEX_CHECK_INTERVAL_MS,
} = {}) {
  let indexCheckedAt = 0;
  let indexCheckPromise = null;

  const getKeys = (email) => {
    const normalizedEmail = normalizeEmail(email);
    const secret = secretProvider();
    return {
      account: bucketId("account", normalizedEmail, secret),
    };
  };

  const verifyTtlIndex = async () => {
    if (mongo.connection?.readyState !== 1 || !collection) {
      throw limiterUnavailable("LOGIN_LIMITER_DATABASE_NOT_READY");
    }
    if (
      indexCheckPromise &&
      now() - indexCheckedAt < indexCheckIntervalMs
    ) {
      return indexCheckPromise;
    }

    indexCheckedAt = now();
    indexCheckPromise = (async () => {
      try {
        const indexes = await collection.listIndexes().toArray();
        const ttlIndex = indexes.find((index) => index.name === INDEX_NAME);
        const indexKeys = Object.keys(ttlIndex?.key || {});
        if (
          !ttlIndex ||
          indexKeys.length !== 1 ||
          indexKeys[0] !== "expiresAt" ||
          ttlIndex.key?.expiresAt !== 1 ||
          ttlIndex.expireAfterSeconds !== 0
        ) {
          throw Object.assign(
            new Error("Required TTL index is missing or misconfigured"),
            { code: "LOGIN_LIMITER_TTL_INDEX_INVALID" },
          );
        }
      } catch (error) {
        indexCheckPromise = null;
        throw limiterUnavailable("LOGIN_LIMITER_INDEX_CHECK_FAILED", error);
      }
    })();
    return indexCheckPromise;
  };

  const ensureBucketsExist = async (keys) => {
    try {
      try {
        await collection.updateOne(
          { _id: keys.account },
          {
            $setOnInsert: {
              _id: keys.account,
              attempts: [],
              expiresAt: new Date(now() + windowMs),
            },
          },
          { upsert: true },
        );
      } catch (error) {
        // A concurrent upsert may win on the unique _id index.
        if (error?.code !== 11000) throw error;
      }
    } catch (error) {
      throw limiterUnavailable("LOGIN_LIMITER_BUCKET_UPSERT_FAILED", error);
    }
  };

  const withTransaction = async (keys, operation) => {
    await verifyTtlIndex();
    await ensureBucketsExist(keys);
    let session;
    let timeoutId;
    let timedOut = false;
    try {
      session = await mongo.startSession();
      const transaction = session.withTransaction(
        () => operation(session),
        { maxCommitTimeMS: transactionTimeoutMs },
      );
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          const timeoutCause = Object.assign(
            new Error("Login attempt limiter transaction timed out."),
            { code: "LOGIN_LIMITER_TRANSACTION_TIMEOUT" },
          );
          try {
            Promise.resolve(session.abortTransaction()).catch((error) =>
              logLimiterFailure(
                "LOGIN_LIMITER_TRANSACTION_ABORT_FAILED",
                error,
              ),
            );
          } catch (error) {
            logLimiterFailure(
              "LOGIN_LIMITER_TRANSACTION_ABORT_FAILED",
              error,
            );
          }
          reject(
            limiterUnavailable(
              "LOGIN_LIMITER_TRANSACTION_TIMEOUT",
              timeoutCause,
            ),
          );
        }, transactionTimeoutMs);
      });
      return await Promise.race([transaction, timeout]);
    } catch (error) {
      if (error?.status === 503 && error?.code === "LOGIN_LIMITER_UNAVAILABLE") {
        throw error;
      }
      throw limiterUnavailable("LOGIN_LIMITER_TRANSACTION_FAILED", error);
    } finally {
      clearTimeout(timeoutId);
      if (session) {
        try {
          await session.endSession();
        } catch (error) {
          if (!timedOut) {
            logLimiterFailure("LOGIN_LIMITER_SESSION_CLEANUP_FAILED", error);
          }
        }
      }
    }
  };

  const readAccountAttempts = async (keys, session, timestamp) => {
    const accountBucket = await collection.findOne(
      { _id: keys.account },
      { session },
    );
    return pruneAttempts(
      accountBucket,
      timestamp,
      windowMs,
      pendingReservationTtlMs,
    );
  };

  const writeBucket = async (id, attempts, timestamp, session) => {
    if (!attempts.length) {
      await collection.deleteOne({ _id: id }, { session });
      return;
    }
    const expiry = Math.max(
      ...attempts.map((attempt) => {
        const ttl =
          attempt.state === "pending" ? pendingReservationTtlMs : windowMs;
        return new Date(attempt.createdAt).getTime() + ttl;
      }),
    );
    await collection.replaceOne(
      { _id: id },
      {
        _id: id,
        attempts,
        expiresAt: new Date(Math.max(timestamp, expiry)),
      },
      { upsert: true, session },
    );
  };

  const updateReservation = async (
    email,
    transformAccount,
  ) => {
    const keys = getKeys(email);
    return withTransaction(keys, async (session) => {
      const timestamp = now();
      const attempts = await readAccountAttempts(keys, session, timestamp);
      await writeBucket(
        keys.account,
        transformAccount(attempts),
        timestamp,
        session,
      );
    });
  };

  const reserveLoginAttempt = async (email) => {
    const keys = getKeys(email);
    return withTransaction(keys, async (session) => {
      const timestamp = now();
      const attempts = await readAccountAttempts(keys, session, timestamp);
      if (attempts.length >= accountLimit) {
        return {
          allowed: false,
          source: "account",
          retryAfter: retryAfterSeconds(
            attempts,
            timestamp,
            windowMs,
            pendingReservationTtlMs,
          ),
        };
      }

      const reservationId = randomUUID();
      const reservation = {
        reservationId,
        createdAt: new Date(timestamp),
        state: "pending",
      };
      await writeBucket(keys.account, [...attempts, reservation], timestamp, session);
      return { allowed: true, reservationId, source: "account" };
    });
  };

  const releaseLoginAttempt = (email, reservationId) =>
    updateReservation(email, (attempts) =>
      attempts.filter((attempt) => attempt.reservationId !== reservationId),
    );

  const markLoginAttemptFailed = (email, reservationId) =>
    updateReservation(
      email,
      (attempts) =>
        attempts.map((attempt) =>
          attempt.reservationId === reservationId
            ? { ...attempt, state: "failed" }
            : attempt,
        ),
    );

  const completeLoginAttempt = async (email, reservationId) => {
    const keys = getKeys(email);
    return withTransaction(keys, async (session) => {
      const timestamp = now();
      const attempts = await readAccountAttempts(keys, session, timestamp);
      const accountAttempts = attempts.filter(
        (attempt) => attempt.state === "pending" &&
          attempt.reservationId !== reservationId,
      );
      await writeBucket(keys.account, accountAttempts, timestamp, session);
    });
  };

  return {
    reserveLoginAttempt,
    releaseLoginAttempt,
    markLoginAttemptFailed,
    completeLoginAttempt,
    verifyTtlIndex,
  };
}

const defaultLimiter = createLoginAttemptLimiter();

module.exports = {
  INDEX_NAME,
  LIMITER_CONFIG,
  createLoginAttemptLimiter,
  reserveLoginAttempt: (...args) =>
    defaultLimiter.reserveLoginAttempt(...args),
  releaseLoginAttempt: (...args) =>
    defaultLimiter.releaseLoginAttempt(...args),
  markLoginAttemptFailed: (...args) =>
    defaultLimiter.markLoginAttemptFailed(...args),
  completeLoginAttempt: (...args) =>
    defaultLimiter.completeLoginAttempt(...args),
};
