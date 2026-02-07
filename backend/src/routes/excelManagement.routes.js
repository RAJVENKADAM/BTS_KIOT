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
router.get('/', authenticateToken, authorizeRoles('SUPERADMIN'), getAllExcelUploads);
router.get('/:id', authenticateToken, authorizeRoles('SUPERADMIN'), getExcelUpload);
router.get('/:id/users', authenticateToken, authorizeRoles('SUPERADMIN'), getUsersByExcelUpload);
router.put('/:id', authenticateToken, authorizeRoles('SUPERADMIN'), upload.single('file'), reuploadExcel);
router.delete('/:id', authenticateToken, authorizeRoles('SUPERADMIN'), deleteExcelUpload);

module.exports = router;