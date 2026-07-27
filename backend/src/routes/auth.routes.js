const express = require('express');
const { login, getProfile, logout, deleteUserAccount, verifyToken } = require('../controllers/auth.controller');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Public routes
router.post('/login', login);

// Protected routes
router.get('/profile', authenticateToken, getProfile);
router.post('/logout', authenticateToken, logout);
// Support both GET and POST for verify — frontend AuthContext sends GET by default
router.get('/verify', authenticateToken, verifyToken);
router.post('/verify', authenticateToken, verifyToken);
router.delete('/account', authenticateToken, deleteUserAccount);

module.exports = router;