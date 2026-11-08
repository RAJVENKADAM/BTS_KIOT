const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const { logSafeError } = require('../utils/safeErrorLog');
const { runAtlasAudit } = require('../controllers/atlasAudit.controller');
const {
  deleteSelectedUsers,
  deleteUser,
  getUsers,
  updateUsersRole,
  updateUser,
} = require('../controllers/superadminUser.controller');

const router = express.Router();

const localAtlasAuditRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${String(req.user.id)}`,
  handler: (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(429).json({
      error: 'Audit rate limit exceeded.',
      code: 'AUDIT_RATE_LIMITED',
    });
  },
});

const atlasAuditRateLimit = (req, res, next) => {
  const incrementSharedRateLimit = req.app.locals.incrementSharedRateLimit;
  if (!incrementSharedRateLimit) {
    return localAtlasAuditRateLimit(req, res, next);
  }
  incrementSharedRateLimit(
    `atlas-audit:user:${String(req.user.id)}`,
    15 * 60 * 1000,
  )
    .then((result) => {
      if (result.totalHits > 1) {
        res.set('Cache-Control', 'no-store');
        return res.status(429).json({
          error: 'Audit rate limit exceeded.',
          code: 'AUDIT_RATE_LIMITED',
        });
      }
      return next();
    })
    .catch((error) => {
      logSafeError('Shared audit rate limiting is unavailable', error, req.requestId);
      return res.status(503).json({
        error: 'Request protection is temporarily unavailable.',
        code: 'RATE_LIMIT_UNAVAILABLE',
      });
    });
};

// Superadmin only routes
router.post(
  '/atlas-readonly-audit',
  authenticateToken,
  authorizeRoles('superadmin'),
  atlasAuditRateLimit,
  runAtlasAudit
);

router.get(
  '/users',
  authenticateToken,
  authorizeRoles('superadmin'),
  getUsers
);

router.post(
  '/users/bulk-role',
  authenticateToken,
  authorizeRoles('superadmin'),
  updateUsersRole
);

router.delete(
  '/users',
  authenticateToken,
  authorizeRoles('superadmin'),
  deleteSelectedUsers
);

router.put(
  '/users/:id',
  authenticateToken,
  authorizeRoles('superadmin'),
  updateUser
);

router.delete(
  '/users/:id',
  authenticateToken,
  authorizeRoles('superadmin'),
  deleteUser
);

module.exports = router;
