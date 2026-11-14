const express = require('express');
const {
  getAllExcelUploads,
  getExcelUpload,
  deleteExcelUpload,
  getUsersByExcelUpload
} = require('../controllers/excelManagement.controller');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

const router = express.Router();

// Superadmin only routes
router.get('/', authenticateToken, authorizeRoles('superadmin'), getAllExcelUploads);
router.get('/:id', authenticateToken, authorizeRoles('superadmin'), getExcelUpload);
router.get('/:id/users', authenticateToken, authorizeRoles('superadmin'), getUsersByExcelUpload);
router.put('/:id', authenticateToken, authorizeRoles('superadmin'), (_req, res) =>
  res.status(410).json({
    success: false,
    code: 'EXCEL_UPLOAD_REUPLOAD_RETIRED',
    error: 'This endpoint only changed upload metadata. Use the supported user import workflow to apply a new spreadsheet.',
  }),
);
router.delete('/:id', authenticateToken, authorizeRoles('superadmin'), deleteExcelUpload);

module.exports = router;