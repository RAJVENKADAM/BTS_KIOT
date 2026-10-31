const express = require('express');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const { importBusRoutes } = require('../controllers/importBusRoutes.controller');
const {
  parseBusRoutesWorkbookUpload,
  uploadBusRoutesWorkbook,
} = require('../middleware/spreadsheetImport');

const router = express.Router();

router.post(
  '/import-routes',
  authenticateToken,
  authorizeRoles('superadmin'),
  uploadBusRoutesWorkbook,
  parseBusRoutesWorkbookUpload,
  importBusRoutes
);


module.exports = router;
