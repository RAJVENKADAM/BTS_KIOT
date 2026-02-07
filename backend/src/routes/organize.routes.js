const express = require('express');
const multer = require('multer');
const { uploadExcelUsers } = require('../controllers/organize.controller');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

const router = express.Router();

// Configure multer for memory storage (required for Expo Go compatibility)
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
router.post('/upload-excel-users', authenticateToken, authorizeRoles('SUPERADMIN'), upload.single('file'), uploadExcelUsers);

module.exports = router;