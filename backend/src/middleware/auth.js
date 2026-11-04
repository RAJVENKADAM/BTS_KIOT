const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');

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
    const user = await User.findById(payload.id)
      .select('role is_active deleted_by_user')
      .lean();

    if (!user || !user.is_active || user.deleted_by_user) {
      return res.status(401).json({
        error: 'Invalid or expired token',
        code: 'INVALID_TOKEN'
      });
    }

    req.user = {
      ...payload,
      id: String(payload.id),
      role: user.role
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
  extractBearerToken
};
