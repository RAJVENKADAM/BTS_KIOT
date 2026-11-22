const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');

const USER_AUTH_CACHE_TTL_MS = 30_000;
const MAX_USER_AUTH_CACHE_ENTRIES = 5_000;
const userAuthCache = new Map();

function getCachedUserSnapshot(userId) {
  if (process.env.NODE_ENV === 'test') return null;
  const key = String(userId);
  const entry = userAuthCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    userAuthCache.delete(key);
    return null;
  }
  userAuthCache.delete(key);
  userAuthCache.set(key, entry);
  return entry.userSnapshot;
}

function cacheUserSnapshot(userId, userSnapshot) {
  if (process.env.NODE_ENV === 'test') return;
  const key = String(userId);
  userAuthCache.delete(key);
  userAuthCache.set(key, {
    userSnapshot,
    expiresAt: Date.now() + USER_AUTH_CACHE_TTL_MS,
  });
  while (userAuthCache.size > MAX_USER_AUTH_CACHE_ENTRIES) {
    userAuthCache.delete(userAuthCache.keys().next().value);
  }
}

function invalidateUserAuthCache(userId) {
  if (userId == null) return false;
  return userAuthCache.delete(String(userId));
}

function clearUserAuthCache() {
  userAuthCache.clear();
}

const extractBearerToken = (authorization) => {
  if (typeof authorization !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match ? match[1] : null;
};

const authenticateToken = async (req, res, next) => {
  const token = extractBearerToken(req.headers?.authorization);
  if (!token) {
    return res.status(401).json({
      error: 'Access token required'
    });
  }

  if (!process.env.JWT_SECRET) {
    return res.status(500).json({
      error: 'Authentication service unavailable',
      code: 'AUTH_CONFIG_ERROR'
    });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({
      error: 'Invalid or expired token',
      code: 'INVALID_TOKEN'
    });
  }

  if (
    !payload ||
    typeof payload !== 'object' ||
    !mongoose.isValidObjectId(payload.id)
  ) {
    return res.status(401).json({
      error: 'Invalid or expired token',
      code: 'INVALID_TOKEN'
    });
  }

  try {
    let userSnapshot = getCachedUserSnapshot(payload.id);
    if (!userSnapshot) {
      userSnapshot = await User.findById(payload.id)
        .select('role is_active deleted_by_user')
        .lean();
      if (userSnapshot) cacheUserSnapshot(payload.id, userSnapshot);
    }

    if (!userSnapshot || !userSnapshot.is_active || userSnapshot.deleted_by_user) {
      return res.status(401).json({
        error: 'Invalid or expired token',
        code: 'INVALID_TOKEN'
      });
    }

    req.user = {
      ...payload,
      id: String(payload.id),
      role: userSnapshot.role
    };
    next();
  } catch {
    return res.status(500).json({
      error: 'Authentication service unavailable',
      code: 'AUTH_UNAVAILABLE'
    });
  }
};

const authorizeRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required'
      });
    }

    const userRole = (req.user.role || '').toUpperCase();
    const allowedRoles = roles.map(r => r.toUpperCase());

    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        error: 'Insufficient permissions'
      });
    }

    next();
  };
};

module.exports = {
  authenticateToken,
  authorizeRoles,
  extractBearerToken,
  invalidateUserAuthCache,
  clearUserAuthCache,
};
