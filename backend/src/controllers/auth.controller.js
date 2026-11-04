const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const Bus = require('../models/Bus');
const { extractBearerToken } = require('../middleware/auth');
const { disconnectUserSockets } = require('../socket');
const {
  reserveLoginAttempt,
  releaseLoginAttempt,
  clearLoginAttempts,
  runLimitedAuthOperation,
  runLimitedPasswordCheck,
} = require('../utils/authProtection');

const getAssignedBusPreview = async (busNo) => {
  if (!busNo) return null;

  let bus = await Bus.findOne({ bus_no: busNo })
    .select('preview_number altered_to_bus_id')
    .lean();
  let depth = 0;
  while (bus?.altered_to_bus_id && depth < 20) {
    const nextBus = await Bus.findById(bus.altered_to_bus_id)
      .select('preview_number altered_to_bus_id')
      .lean();
    if (!nextBus) break;
    bus = nextBus;
    depth += 1;
  }
  return bus?.preview_number ?? null;
};

const login = async (req, res) => {
  let email;
  let reservationId;
  try {
    const { email: submittedEmail, password } = req.body;

    if (
      typeof submittedEmail !== 'string' ||
      typeof password !== 'string' ||
      !submittedEmail.trim() ||
      !password ||
      submittedEmail.trim().length > 254 ||
      password.length > 1024
    ) {
      return res.status(400).json({
        error: 'Email and password are required',
        code: 'INVALID_CREDENTIALS',
      });
    }

    email = submittedEmail.trim().toLowerCase();
    const attempt = reserveLoginAttempt(email);
    if (!attempt.allowed) {
      res.set('Retry-After', String(attempt.retryAfter));
      return res.status(429).json({
        error: 'Too many login attempts. Please wait before trying again.',
        code: 'LOGIN_RATE_LIMITED',
        retryAfter: attempt.retryAfter,
      });
    }
    reservationId = attempt.reservationId;

    const result = await runLimitedAuthOperation(async () => {
      const user = await User.findOne({ email }).select(
        '_id name email role bus_no is_active temp_password deleted_by_user password_hash',
      );

      if (!user) return { type: 'invalid' };

      if (user.deleted_by_user) {
        return { type: 'deleted' };
      }

      if (!user.is_active && user.role !== 'superadmin' && !user.temp_password) {
        return { type: 'inactive' };
      }

      const isValidPassword = await runLimitedPasswordCheck(() =>
        user.comparePassword(password),
      );
      return isValidPassword
        ? { type: 'authenticated', user }
        : { type: 'invalid' };
    });

    if (result.type === 'invalid') {
      return res.status(401).json({
        error: 'Invalid credentials',
        code: 'INVALID_CREDENTIALS',
      });
    }

    if (result.type === 'deleted') {
      releaseLoginAttempt(email, reservationId);
      reservationId = undefined;
      return res.status(401).json({
        error: 'Account has been deleted. Credentials are invalid.',
        code: 'ACCOUNT_DELETED',
      });
    }

    if (result.type === 'inactive') {
      releaseLoginAttempt(email, reservationId);
      reservationId = undefined;
      return res.status(401).json({
        error: 'Account deactivated. Contact admin.',
        code: 'ACCOUNT_DEACTIVATED',
      });
    }

    const user = result.user;
    clearLoginAttempts(email);
    reservationId = undefined;

    // Generate JWT token
    const token = jwt.sign(
      {
        id: user._id,
        email: user.email,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    const assignedBusPreview = await getAssignedBusPreview(user.bus_no);

    // Return user data and token
    res.status(200).json({
      message: 'Login successful',
      token: token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        bus_no: user.bus_no,
        previewNumber: assignedBusPreview,
        is_active: user.is_active,
        temp_password: user.temp_password
      }
    });

  } catch (error) {
    if (email && reservationId !== undefined) {
      releaseLoginAttempt(email, reservationId);
    }
    if (error.status === 503) {
      res.set('Retry-After', String(error.retryAfter || 2));
      return res.status(503).json({
        error: 'Authentication service is busy. Please try again shortly.',
        code: error.code || 'AUTH_BUSY',
        retryAfter: error.retryAfter || 2,
      });
    }
    console.error('Login error:', {
      name: error?.name || 'Error',
      code: error?.code || null
    });
    res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR',
    });
  }
};

const getProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId).select('-password_hash').lean();

    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    const assignedBusPreview = await getAssignedBusPreview(user.bus_no);

    res.status(200).json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        bus_no: user.bus_no,
        previewNumber: assignedBusPreview,
        is_active: user.is_active,
        temp_password: user.temp_password,
        created_at: user.createdAt
      }
    });

  } catch (error) {
    console.error('Get profile error:', {
      name: error?.name || 'Error',
      code: error?.code || null
    });
    res.status(500).json({
      error: 'Internal server error'
    });
  }
};

const logout = async (req, res) => {
  // In a stateless JWT system, logout is handled client-side
  // by removing the token from storage
  res.status(200).json({
    message: 'Logout successful'
  });
};

const deleteUserAccount = async (req, res) => {
  try {
    const userId = req.user.id;

    // Mark user account as deleted by user
    const result = await User.updateOne(
      { _id: userId },
      { 
        is_active: false, 
        deleted_by_user: true 
      }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    disconnectUserSockets(userId);
    res.status(200).json({
      message: 'Account deleted successfully. You will be logged out.'
    });

  } catch (error) {
    console.error('Delete user account error:', {
      name: error?.name || 'Error',
      code: error?.code || null
    });
    res.status(500).json({
      error: 'Internal server error'
    });
  }
};

const verifyToken = async (req, res) => {
  try {
    // If we reach here, token is valid (middleware passed)
    // But we MUST also check if the user account is still active
    // This catches deactivated users who still have valid tokens
    const user = await User.findById(req.user.id)
      .select('is_active deleted_by_user role')
      .lean();

    if (!user || !user.is_active || user.deleted_by_user) {
      return res.status(403).json({
        valid: false,
        message: 'Account has been deactivated. Please contact admin.',
        deactivated: true
      });
    }

    res.status(200).json({
      valid: true,
      user: req.user
    });
  } catch (error) {
    console.error('verifyToken error:', {
      name: error?.name || 'Error',
      code: error?.code || null
    });
    res.status(500).json({
      valid: false,
      error: 'Internal server error'
    });
  }
};

/**
 * Public token verification — never throws a bare 403.
 * Used by the frontend's periodic session check so it can distinguish:
 *   - invalid/expired token  → 200 { valid: false }
 *   - deactivated account    → 200 { valid: false, deactivated: true }
 *   - valid session          → 200 { valid: true }
 * This prevents the "403 loop" where the app can't detect an invalid token
 * because the raw middleware error doesn't include a parseable `valid` field.
 */
const verifyTokenPublic = async (req, res) => {
  try {
    const token = extractBearerToken(req.headers?.authorization);

    if (!token) {
      return res.status(200).json({ valid: false });
    }

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({
        valid: false,
        error: 'Authentication service unavailable'
      });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      // Invalid or expired token — graceful, parseable response
      return res.status(200).json({ valid: false });
    }

    // Normalize IDs from the JWT payload
    const normalized = { ...payload };
    if (normalized && normalized.id != null) {
      normalized.id = String(normalized.id);
    }
    if (!mongoose.isValidObjectId(normalized.id)) {
      return res.status(200).json({ valid: false });
    }

    // Check that the account is still active
    const user = await User.findById(normalized.id)
      .select('is_active deleted_by_user role')
      .lean();

    if (!user || !user.is_active || user.deleted_by_user) {
      return res.status(200).json({
        valid: false,
        message: 'Account has been deactivated. Please contact admin.',
        deactivated: true
      });
    }

    normalized.role = user.role;
    res.status(200).json({
      valid: true,
      user: normalized
    });
  } catch (error) {
    console.error('verifyTokenPublic error:', {
      name: error?.name || 'Error',
      code: error?.code || null
    });
    res.status(500).json({
      valid: false,
      error: 'Internal server error'
    });
  }
};

module.exports = {
  login,
  getProfile,
  logout,
  deleteUserAccount,
  verifyToken,
  verifyTokenPublic
};
