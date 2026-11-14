const express = require('express');
const BusController = require('../controllers/bus.controller');
const PlanMappingController = require('../controllers/planMapping.controller');
const AssignmentPropagationController = require('../controllers/assignmentPropagation.controller');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const {
  parseBusRoutesWorkbookUpload,
  uploadBusRoutesWorkbook,
} = require("../middleware/spreadsheetImport");

const router = express.Router();

router.get(
  '/assignment-propagation-jobs',
  authenticateToken,
  authorizeRoles('primary_admin', 'superadmin'),
  AssignmentPropagationController.listAssignmentPropagationJobs,
);

router.post(
  '/assignment-propagation-jobs/:jobId/replay',
  authenticateToken,
  authorizeRoles('superadmin'),
  AssignmentPropagationController.replayAssignmentPropagationJob,
);

router.get(
  '/plan-mappings',
  authenticateToken,
  authorizeRoles('superadmin'),
  PlanMappingController.getPlanMappingData,
);

router.get(
  '/plan-mapping-audit',
  authenticateToken,
  authorizeRoles('superadmin'),
  PlanMappingController.getPlanMappingAudit,
);

router.post(
  '/plan-mappings',
  authenticateToken,
  authorizeRoles('superadmin'),
  PlanMappingController.savePlanMapping,
);

router.put(
  '/plan-mappings/:clusterId/routes',
  authenticateToken,
  authorizeRoles('superadmin'),
  PlanMappingController.updatePlanMappingRoutes,
);

router.delete(
  '/plan-mappings/:clusterId',
  authenticateToken,
  authorizeRoles('superadmin'),
  PlanMappingController.deletePlanMapping,
);

/**
 * -----------------------
 * ADMIN ROUTES
 * -----------------------
 */

router.post(
  '/upload-bus-routes',
  authenticateToken,
  authorizeRoles('superadmin'),
  (_req, res) => res.status(410).json({
    success: false,
    code: 'LEGACY_IMPORT_RETIRED',
    error: 'This bus import endpoint has been retired. Use POST /api/bus/import-routes.',
  }),
);

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

router.get(
  '/temporary-changes',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.getTemporaryBusChanges,
);

router.post(
  '/temporary-changes/:changeId/rollback',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.rollbackTemporaryBusChange,
);

router.post(
  '/alter-bus/:busNo',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.alterBus
);

router.post(
  '/combine-bus/:busNo',
  authenticateToken,
  authorizeRoles('superadmin'),
  uploadBusRoutesWorkbook,
  parseBusRoutesWorkbookUpload,
  BusController.combineBus
);

router.put(
  '/restore-altered/:busNo',
  authenticateToken,
  authorizeRoles('superadmin'),
  BusController.restoreAlteredBus
);

// Students are constrained to their resolved assignment inside the controller.
router.get(
  '/routes/:busNo',
  authenticateToken,
  authorizeRoles('student', 'primary_admin', 'superadmin'),
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
  authorizeRoles('primary_admin', 'superadmin'),
  BusController.getAllBuses
);

router.get(
  '/plan-buses/:plan',
  authenticateToken,
  authorizeRoles('primary_admin', 'superadmin'),
  BusController.getBusesForPlan
);

router.get(
  '/track-by-preview/:previewNumber',
  authenticateToken,
  authorizeRoles('primary_admin', 'superadmin'),
  BusController.trackByPreview
);

router.get(
  '/my-assignment',
  authenticateToken,
  BusController.getMyAssignment
);

// getRouteStops and getCurrentPlan routes removed - functions not defined

router.get(
  '/location/:busNo',
  authenticateToken,
  authorizeRoles('student', 'primary_admin', 'superadmin'),
  BusController.getLiveLocation
);

/**
 * ⚠️ IMPORTANT: KEEP THIS LAST
 * (prevents route conflict with /statistics etc.)
 */
// getBusLocation route removed - function not defined

module.exports = router;