const express = require('express');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const { importUsers } = require('../controllers/importUsers.controller');
const {
  parseUserWorkbookUpload,
  uploadUserWorkbook,
} = require('../middleware/spreadsheetImport');

const router = express.Router();

router.post(
  '/import-users',
  authenticateToken,
  authorizeRoles('superadmin'),
  importUsers
);

router.post(
  '/import-users-excel',
  authenticateToken,
  authorizeRoles('superadmin'),
  uploadUserWorkbook,
  parseUserWorkbookUpload,
  importUsers,
);

module.exports = router;
