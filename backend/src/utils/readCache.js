"use strict";

function createBoundedCache({ ttlMs, maxEntries }) {
  const entries = new Map();

  function get(key) {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      entries.delete(key);
      return undefined;
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  }

  function set(key, value, entryTtlMs = ttlMs) {
    entries.delete(key);
    entries.set(key, { value, expiresAt: Date.now() + entryTtlMs });
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
    }
    return value;
  }

  return {
    get,
    set,
    delete: (key) => entries.delete(key),
    clear: () => entries.clear(),
    get size() {
      return entries.size;
    },
  };
}

const busReadCache = createBoundedCache({
  ttlMs: 60_000,
  maxEntries: 2_000,
});
const gpsLocationCache = createBoundedCache({
  ttlMs: 3_000,
  maxEntries: 2_000,
});
const notificationUnreadCountCache = createBoundedCache({
  ttlMs: 15_000,
  maxEntries: 5_000,
});

function gpsLocationCacheKey(busId, view = "full") {
  return `${String(busId)}:${view}`;
}

function isCacheEnabled() {
  return process.env.NODE_ENV !== "test";
}

async function getOrLoad(cache, key, loader, ttlMs) {
  if (!isCacheEnabled()) return loader();
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const pending = Promise.resolve().then(loader);
  cache.set(key, pending, ttlMs);
  try {
    const value = await pending;
    if (cache.get(key) === pending) cache.set(key, value, ttlMs);
    return value;
  } catch (error) {
    if (cache.get(key) === pending) cache.delete(key);
    throw error;
  }
}

function cacheResponse(cache, keyForRequest) {
  return (req, res, next) => {
    if (!isCacheEnabled()) return next();
    const key = keyForRequest(req);
    const cached = cache.get(key);
    if (cached) {
      return res.status(cached.statusCode).json(cached.body);
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 400) {
        cache.set(key, { statusCode: res.statusCode, body });
      }
      return originalJson(body);
    };
    return next();
  };
}

function invalidateBusReadCache() {
  busReadCache.clear();
}

function invalidateNotificationUnreadCount(userId) {
  if (userId == null) {
    notificationUnreadCountCache.clear();
    return;
  }
  notificationUnreadCountCache.delete(String(userId));
}

function invalidateBusReadCacheOnMutation(req, res, next) {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    res.once("finish", () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        invalidateBusReadCache();
        require("../services/studentBusAssignment").invalidateStudentAssignmentCache();
      }
    });
  }
  next();
}

module.exports = {
  busReadCache,
  cacheResponse,
  createBoundedCache,
  getOrLoad,
  gpsLocationCacheKey,
  gpsLocationCache,
  invalidateBusReadCache,
  invalidateBusReadCacheOnMutation,
  invalidateNotificationUnreadCount,
  isCacheEnabled,
  notificationUnreadCountCache,
};
