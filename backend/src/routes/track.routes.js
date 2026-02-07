const express = require('express');
const { updateLocation, getLiveLocation, toggleTracking } = require('../controllers/track.controller');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

const router = express.Router();

// Primary admin only routes for tracking
router.put('/location', authenticateToken, authorizeRoles(['PRIMARY_ADMIN']), updateLocation);
router.get('/location/:busNo', authenticateToken, getLiveLocation);
router.post('/toggle-tracking', authenticateToken, authorizeRoles(['PRIMARY_ADMIN']), toggleTracking);

module.exports = router;