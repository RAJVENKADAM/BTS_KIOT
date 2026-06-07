const express = require('express');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const { importUsers } = require('../controllers/importUsers.controller');

const router = express.Router();

router.post(
  '/import-users',
  authenticateToken,
  authorizeRoles('superadmin'),
  importUsers
);


module.exports = router;

