const express = require('express');
const multer = require('multer');
const {
  getAllExcelUploads,
  getExcelUpload,
  reuploadExcel,
  deleteExcelUpload,
  getUsersByExcelUpload
} = require('../controllers/excelManagement.controller');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

const router = express.Router();

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.originalname.endsWith('.xlsx')) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel files are allowed'));
    }
  }
});

// Superadmin only routes
router.get('/', authenticateToken, authorizeRoles('superadmin'), getAllExcelUploads);
router.get('/:id', authenticateToken, authorizeRoles('superadmin'), getExcelUpload);
router.get('/:id/users', authenticateToken, authorizeRoles('superadmin'), getUsersByExcelUpload);
router.put('/:id', authenticateToken, authorizeRoles('superadmin'), upload.single('file'), reuploadExcel);
router.delete('/:id', authenticateToken, authorizeRoles('superadmin'), deleteExcelUpload);

module.exports = router;