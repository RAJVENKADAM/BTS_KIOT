const express = require('express');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const { importUsers } = require('../controllers/importUsers.controller');
const { getImportOperation } = require('../controllers/importLedger.controller');
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

router.get(
  '/imports/:uploadId',
  authenticateToken,
  authorizeRoles('superadmin'),
  getImportOperation,
);

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
