const express = require('express');
const multer = require('multer');
const { uploadBusRoutes, deleteBus, activateBus, changeBusPlan, getCurrentPlan, getLiveLocation, getRouteStops, getAllBuses, updateBusNumber, getBusStatistics, combineBuses, uncombineBuses, registerDeviceToken } = require('../controllers/bus.controller');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'bus-routes-' + uniqueSuffix + '.xlsx');
  }
});

const upload = multer({ 
  storage: storage,
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
router.post('/upload-bus-routes', authenticateToken, authorizeRoles('SUPERADMIN'), upload.single('file'), uploadBusRoutes);
router.delete('/delete-bus/:busNo', authenticateToken, authorizeRoles('SUPERADMIN'), deleteBus);
router.put('/activate-bus/:busNo', authenticateToken, authorizeRoles('SUPERADMIN'), activateBus);
router.put('/change-plan/:busNo', authenticateToken, authorizeRoles('SUPERADMIN'), changeBusPlan);
router.put('/update-bus-number/:busNo', authenticateToken, authorizeRoles('SUPERADMIN'), updateBusNumber);
router.post('/combine-buses', authenticateToken, authorizeRoles('SUPERADMIN'), combineBuses);
router.post('/uncombine-buses/:operatingBus', authenticateToken, authorizeRoles('SUPERADMIN'), uncombineBuses);
// Register device token for push notifications (any authenticated user)
router.post('/register-device-token', authenticateToken, registerDeviceToken);
router.get('/current-plan/:busNo', authenticateToken, getCurrentPlan);
router.get('/get-all-buses', authenticateToken, authorizeRoles('SUPERADMIN'), getAllBuses);

// Statistics accessible to all authenticated users
router.get('/statistics', authenticateToken, getBusStatistics);

// Public routes (accessible to all authenticated users with proper permissions)
router.get('/location/:busNo', authenticateToken, getLiveLocation);
router.get('/route/:busNo/:planName', authenticateToken, getRouteStops);

module.exports = router;