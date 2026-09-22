const express = require('express');
const multer = require('multer');

const BusController = require('../controllers/bus.controller');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

const router = express.Router();

/**
 * -----------------------
 * MULTER CONFIG
 * -----------------------
 */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const name = Date.now() + '-' + safeName;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024,
    fields: 50,
    parts: 60,
    fieldSize: 256 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.originalname.toLowerCase().endsWith('.xlsx')
    ) {
      return cb(null, true);
    }
    return cb(new Error('Only Excel files are allowed'));
  },
});

/**
 * -----------------------
 * ADMIN ROUTES
 * -----------------------
 */

router.post(
  '/upload-bus-routes',
  authenticateToken,
  authorizeRoles('superadmin'),
  upload.single('file'),
  BusController.uploadBusRoutes
);

// createBus - use uploadBusRoutes instead

router.put(
  '/update-bus-number/:busNo',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.updateBusNumber
);

router.put(
  '/update-preview/:busNo',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.updatePreviewNumber
);

router.put(
  '/update-plan/:busNo',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.updatePlan   // IMPORTANT FIX
);

router.get(
  '/global-plan',
  authenticateToken,
  BusController.getGlobalActivePlan,
);

router.put(
  '/global-plan',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.setGlobalActivePlan,
);

router.put(
  '/update-bus-details/:busNo',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.updateBusDetails
);

router.post(
  '/alter-bus/:busNo',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.alterBus
);

// Any authenticated user can fetch plans + stops for a bus (Home screen)
router.get(
  '/routes/:busNo',
  authenticateToken,
  BusController.getBusRoutes
);

router.get(
  '/plans/:busNo',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.getPlans
);

router.get(
  '/validate-preview/:previewNumber',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.validatePreviewNumber
);

router.delete(
  '/delete-bus/:busNo',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.deleteBus
);

router.put(
  '/activate-bus/:busNo',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.activateBus
);

router.put(
  '/deactivate-bus/:busNo',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.deactivateBus
);

// combineBuses and uncombineBuses routes removed - functions not defined

/**
 * -----------------------
 * USER ROUTES (STATIC FIRST!)
 * -----------------------
 */

// getBusStatistics route removed - function not defined

router.get(
  '/get-all-buses',
  authenticateToken,
  BusController.getAllBuses
);

router.get(
  '/plan-buses/:plan',
  authenticateToken,
  BusController.getBusesForPlan
);

router.get(
  '/track-by-preview/:previewNumber',
  authenticateToken,
  BusController.trackByPreview
);

// getRouteStops and getCurrentPlan routes removed - functions not defined

router.get(
  '/location/:busNo',
  authenticateToken,
  BusController.getLiveLocation
);

/**
 * ⚠️ IMPORTANT: KEEP THIS LAST
 * (prevents route conflict with /statistics etc.)
 */
// getBusLocation route removed - function not defined

module.exports = router;