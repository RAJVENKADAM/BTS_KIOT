const express = require('express');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const { importBusRoutes } = require('../controllers/importBusRoutes.controller');

const router = express.Router();

router.post(
  '/import-routes',
  authenticateToken,
  authorizeRoles('superadmin'),
  importBusRoutes
);


module.exports = router;

