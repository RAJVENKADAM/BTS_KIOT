const express = require('express');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const { deactivateUser, updateUser } = require('../controllers/superadminUser.controller');

const router = express.Router();

// Superadmin only routes
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
  deactivateUser
);

module.exports = router;

