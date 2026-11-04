const express = require('express');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const { importUsers } = require('../controllers/importUsers.controller');
const { reserveImportCapacity } = require('../middleware/importAdmission');
const {
  parseUserWorkbookUpload,
  uploadUserWorkbook,
} = require('../middleware/spreadsheetImport');

const router = express.Router();
const parseUserImportJson = express.json({
  limit: '25mb',
  strict: false,
});

router.post(
  '/import-users',
  authenticateToken,
  authorizeRoles('superadmin'),
  reserveImportCapacity,
  parseUserImportJson,
  importUsers
);

router.post(
  '/import-users-excel',
  authenticateToken,
  authorizeRoles('superadmin'),
  reserveImportCapacity,
  uploadUserWorkbook,
  parseUserWorkbookUpload,
  importUsers,
);

module.exports = router;
