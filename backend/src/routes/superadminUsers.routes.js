const express = require('express');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const {
  deactivateUser,
  getUsers,
  updateUser,
} = require('../controllers/superadminUser.controller');

const router = express.Router();

// Superadmin only routes
router.get(
  '/users',
  authenticateToken,
  authorizeRoles('superadmin'),
  getUsers
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
  deactivateUser
);

module.exports = router;
