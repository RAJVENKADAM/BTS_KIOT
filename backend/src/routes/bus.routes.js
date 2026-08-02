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
    const name = Date.now() + '-' + file.originalname;
    cb(null, name);
  }
});

const upload = multer({ storage });

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

router.put(
  '/update-bus-details/:busNo',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.updateBusDetails
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