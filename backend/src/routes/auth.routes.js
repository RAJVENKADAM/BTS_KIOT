const express = require('express');
const { login, getProfile, logout, deleteUserAccount, verifyToken, verifyTokenPublic } = require('../controllers/auth.controller');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Public routes
router.post('/login', login);

// Verify endpoint uses the PUBLIC handler (no authenticateToken middleware).
// It returns 200 { valid: false } for invalid/expired tokens instead of a bare 403,
// so the frontend can detect stale sessions and force logout.
router.get('/verify', verifyTokenPublic);
router.post('/verify', verifyTokenPublic);

// Protected routes
router.get('/profile', authenticateToken, getProfile);
router.post('/logout', authenticateToken, logout);
router.delete('/account', authenticateToken, deleteUserAccount);

module.exports = router;