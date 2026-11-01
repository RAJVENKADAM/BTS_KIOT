const express = require('express');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const {
  deleteSelectedUsers,
  deleteUser,
  getUsers,
  updateUsersRole,
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
