const express = require('express');
const { sendMessage, getMessages, getGeneralMessages, getMyBusMessages, markMessageRead } = require('../controllers/message.controller');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

const router = express.Router();

// Public route to get general messages (plan changes, etc.) - accessible to all authenticated users
router.get('/general', authenticateToken, getGeneralMessages);

// Route to get messages for user's bus - accessible to all authenticated users
router.get('/my-bus', authenticateToken, getMyBusMessages);

// Route to get all messages based on user role - accessible to all authenticated users
router.get('/', authenticateToken, getMessages);

// Route to send messages - restricted based on role
// Superadmins can send to all users
// Primary admins can send to their own bus
router.post('/', authenticateToken, sendMessage);
// Mark a message as read by the authenticated user
router.post('/:id/read', authenticateToken, markMessageRead);

module.exports = router;