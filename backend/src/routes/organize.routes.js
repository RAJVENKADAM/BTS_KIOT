const express = require('express');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

const router = express.Router();

router.post(
  '/upload-excel-users',
  authenticateToken,
  authorizeRoles('superadmin'),
  (_req, res) => res.status(410).json({
    success: false,
    code: 'LEGACY_IMPORT_RETIRED',
    error: 'This Excel import endpoint has been retired. Use POST /api/superadmin/import-users-excel.',
  }),
);

module.exports = router;