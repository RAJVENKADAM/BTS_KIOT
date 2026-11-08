"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const { logSafeError } = require("../utils/safeErrorLog");
const { createHmac } = require("node:crypto");

function getSharedServiceConfig(env = process.env) {
  const mode =
    env.SOCKET_IO_MODE ||
    (env.NODE_ENV === "production" ? "" : "single-instance");
  if (!["single-instance", "redis"].includes(mode)) {
    throw new Error(
      "Set SOCKET_IO_MODE to 'redis' or explicitly to 'single-instance'.",
    );
  }
  if (mode === "redis" && !env.SOCKET_IO_REDIS_URL && !env.REDIS_URL) {
    throw new Error("SOCKET_IO_MODE=redis requires SOCKET_IO_REDIS_URL or REDIS_URL.");
  }
  const gpsDeviceRegistryMode = env.GPS_DEVICE_REGISTRY_MODE || "legacy";
  if (!["legacy", "strict"].includes(gpsDeviceRegistryMode)) {
    throw new Error("GPS_DEVICE_REGISTRY_MODE must be 'legacy' or 'strict'.");
  }
  return {
    mode,
    redisUrl: env.SOCKET_IO_REDIS_URL || env.REDIS_URL || "",
    gpsDeviceRegistryMode,
  };
}

function createSocketCluster(
  io,
  {
    env = process.env,
    loadDependencies,
    logger = logSafeError,
  } = {},
) {
  const isUnitTest =
    env.NODE_ENV === "test" ||
    env.TEST_ENVIRONMENT === "unit" ||
    Boolean(env.NODE_TEST_CONTEXT) ||
    process.env.NODE_ENV === "test" ||
    process.env.TEST_ENVIRONMENT === "unit" ||
    Boolean(process.env.NODE_TEST_CONTEXT);
  if (isUnitTest && !loadDependencies) {
    throw new Error("Unit tests cannot create live Redis clients.");
  }
  const config = getSharedServiceConfig(env);
  let state = config.mode === "redis" ? "connecting" : "disabled";
  let publisher = null;
  let subscriber = null;
  let everReady = false;
  let fullyReady = false;
  let connectionGeneration = 0;
  let closed = false;
  let ready;
  const publishOperations = new AsyncLocalStorage();

  const emitToRooms = (rooms, event, payload) => {
    let broadcaster = io;
    for (const room of rooms) broadcaster = broadcaster.to(room);
    broadcaster.emit(event, payload);
  };

  const publishSocketEvent = async (rooms, event, payload) => {
    if (!Array.isArray(rooms) || rooms.length === 0) {
      return { brokerAccepted: false };
    }
    if (config.mode !== "redis") {
      emitToRooms(rooms, event, payload);
      return { brokerAccepted: false };
    }
    if (state !== "ready" || !publisher?.isReady || !subscriber?.isReady) {
      throw new Error("Redis publication transport is not ready.");
    }

    const publishPromises = [];
    publishOperations.run(publishPromises, () => {
      emitToRooms(rooms, event, payload);
    });
    if (publishPromises.length === 0) {
      throw new Error("Redis adapter did not expose a publication operation.");
    }
    const subscriberCounts = await Promise.all(publishPromises);
    if (
      subscriberCounts.some(
        (subscriberCount) =>
          !Number.isInteger(subscriberCount) || subscriberCount < 1,
      )
    ) {
      throw new Error("Redis accepted no adapter subscribers for publication.");
    }
    return { brokerAccepted: true };
  };

  const getStatus = () => ({
    mode: config.mode,
    gpsDeviceRegistryMode: config.gpsDeviceRegistryMode,
    state,
    enabled: config.mode === "redis" && state === "ready",
    reason:
      state === "ready"
        ? "Redis publisher and subscriber are connected."
        : state === "disabled"
          ? "Single-instance mode is explicitly selected."
          : state === "connecting"
            ? "Redis publisher and subscriber are connecting."
            : state === "recovering"
              ? "Redis connection recovery is in progress."
              : state === "disconnected"
                ? "Redis publisher or subscriber is disconnected."
                : state === "closed"
                  ? "Socket cluster clients are closed."
                  : "Redis socket clustering failed.",
  });

  const incrementRateLimit = async (key, windowMs) => {
    if (config.mode !== "redis" || !publisher?.isReady) {
      throw new Error("Shared rate-limit storage is not ready.");
    }
    const secret = env.LOGIN_LIMITER_HASH_SECRET || env.JWT_SECRET;
    if (!secret) {
      throw new Error("Shared request limiting requires a shared hash secret.");
    }
    const digest = createHmac("sha256", secret)
      .update(String(key))
      .digest("hex");
    const result = await publisher.eval(
      "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); end; return {count, redis.call('PTTL', KEYS[1])}",
      {
        keys: [`btms:ratelimit:api:${digest}`],
        arguments: [String(windowMs)],
      },
    );
    return {
      totalHits: Number(result[0]),
      resetTime: Date.now() + Math.max(0, Number(result[1])),
    };
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    state = "closing";
    const clients = [subscriber, publisher].filter(Boolean);
    const results = await Promise.allSettled(
      clients.map(async (client) => {
        if (client.isReady) await client.quit();
        else if (typeof client.disconnect === "function") {
          await client.disconnect();
        }
      }),
    );
    state = "closed";
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length) {
      throw new AggregateError(failures, "Failed to close Redis socket clients.");
    }
  };

  if (config.mode === "single-instance") {
    ready = Promise.resolve();
    return {
      ready,
      getStatus,
      close,
      incrementRateLimit,
      publishSocketEvent,
      getConnectionGeneration: () => connectionGeneration,
    };
  }

  try {
    const { createAdapter, createClient } = loadDependencies
      ? loadDependencies()
      : {
          createAdapter: require("@socket.io/redis-adapter").createAdapter,
          createClient: require("redis").createClient,
        };
    publisher = createClient({ url: config.redisUrl });
    subscriber = publisher.duplicate();
    const redisPublish = publisher.publish.bind(publisher);
    publisher.publish = (...args) => {
      const publishPromise = redisPublish(...args);
      // The adapter does not await publish(), so capture its promise per emit.
      const pendingOperations = publishOperations.getStore();
      if (pendingOperations) {
        pendingOperations.push(Promise.resolve(publishPromise));
      }
      return publishPromise;
    };

    const updateConnectionState = () => {
      if (closed) return;
      if (publisher.isReady && subscriber.isReady) {
        if (!fullyReady) connectionGeneration += 1;
        fullyReady = true;
        if (everReady) state = "ready";
      } else if (everReady) {
        fullyReady = false;
        state = "recovering";
      }
    };
    for (const client of [publisher, subscriber]) {
      client.on("ready", updateConnectionState);
      client.on("reconnecting", () => {
        fullyReady = false;
        if (!closed) state = everReady ? "recovering" : "connecting";
      });
      client.on("end", () => {
        fullyReady = false;
        if (!closed) state = "disconnected";
      });
      client.on("error", (error) => {
        fullyReady = false;
        if (!closed) {
          state = everReady ? "recovering" : "connecting";
          logger("Socket.IO Redis client error", error);
        }
      });
    }

    ready = Promise.allSettled([publisher.connect(), subscriber.connect()])
      .then((results) => {
        const rejected = results.find((result) => result.status === "rejected");
        if (rejected) throw rejected.reason;
        if (!publisher.isReady || !subscriber.isReady) {
          throw new Error("Redis clients did not both reach the ready state.");
        }
        io.adapter(createAdapter(publisher, subscriber));
        everReady = true;
        state = "ready";
      })
      .catch(async (error) => {
        try {
          await close();
        } catch (closeError) {
          logger("Closing failed Socket.IO Redis clients failed", closeError);
        }
        state = "failed";
        throw error;
      });
  } catch (error) {
    state = "failed";
    ready = Promise.reject(error);
  }

  return {
    ready,
    getStatus,
    close,
    incrementRateLimit,
    publishSocketEvent,
    getConnectionGeneration: () => connectionGeneration,
  };
}

function configureSocketCluster(io, options) {
  return createSocketCluster(io, options);
}

async function closeSocketServices(
  io,
  cluster,
  { httpServerCloseStarted = false } = {},
) {
  let closeError;
  try {
    await new Promise((resolve, reject) => {
      io.close((error) => {
        if (
          httpServerCloseStarted &&
          error?.code === "ERR_SERVER_NOT_RUNNING"
        ) {
          resolve();
          return;
        }
        if (error) reject(error);
        else resolve();
      });
    });
  } catch (error) {
    closeError = error;
  }
  try {
    await cluster.close();
  } catch (error) {
    if (closeError) {
      throw new AggregateError(
        [closeError, error],
        "Failed to close Socket.IO and shared services.",
      );
    }
    throw error;
  }
  if (closeError) throw closeError;
}

module.exports = {
  closeSocketServices,
  configureSocketCluster,
  createSocketCluster,
  getSharedServiceConfig,
};
