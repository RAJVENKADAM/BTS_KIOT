const express = require('express');
const multer = require('multer');

const BusController = require('../controllers/bus.controller');
const {
  uploadBusRoutes,
  deleteBus,
  activateBus,
  changeBusPlan,
  getCurrentPlan,
  getLiveLocation,
  getRouteStops,
  getAllBuses,
  updateBusNumber,
  getBusStatistics,
  combineBuses,
  uncombineBuses,
  savePushToken,
  registerDeviceToken,
  validatePreviewNumber,
  updatePreviewNumber,
  trackByPreview,
  createBus,
  getBusLocation,
  getPlans
} = BusController;

const { authenticateToken, authorizeRoles } = require('../middleware/auth');

const router = express.Router();

// MULTER
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const name = Date.now() + '-' + file.originalname;
    cb(null, name);
  }
});

const upload = multer({ storage });

// ROUTES

// ADMIN
router.post('/upload-bus-routes',
  authenticateToken,
  authorizeRoles('superadmin'),
  upload.single('file'),
  BusController.uploadBusRoutes
);

router.post('/create-bus',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.createBus
);



router.put('/update-bus-number/:busNo',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.updateBusNumber
);

router.put('/update-preview/:busNo',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.updatePreviewNumber
);

router.put('/update-plan/:busNo',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.updatePlan
);

router.get('/plans/:busNo',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.getPlans
);

router.get('/validate-preview/:previewNumber',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.validatePreviewNumber
);

router.delete('/delete-bus/:busNo',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.deleteBus
);

router.put('/activate-bus/:busNo',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.activateBus
);

router.post('/combine-buses',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.combineBuses
);

router.post('/uncombine-buses/:operatingBus',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.uncombineBuses
);

// USER
router.get('/get-all-buses',
  authenticateToken,
  BusController.getAllBuses
);

router.get('/:busNo',
  authenticateToken,
  BusController.getBusLocation
);

router.get('/statistics',
  authenticateToken,
  BusController.getBusStatistics
);

router.get('/location/:busNo',
  authenticateToken,
  BusController.getLiveLocation
);

router.get('/track-by-preview/:previewNumber',
  authenticateToken,
  BusController.trackByPreview
);

router.get('/route/:busNo/:planName',
  authenticateToken,
  BusController.getRouteStops
);

router.get('/current-plan/:busNo',
  authenticateToken,
  BusController.getCurrentPlan
);

router.post('/save-push-token',
  authenticateToken,
  BusController.savePushToken
);

router.post('/register-device-token',
  authenticateToken,
  BusController.registerDeviceToken
);

module.exports = router;

