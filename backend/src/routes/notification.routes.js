const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const NotificationController = require('../controllers/notification.controller');

const router = express.Router();

router.get('/', authenticateToken, NotificationController.getNotifications);
router.get('/unread-count', authenticateToken, NotificationController.getUnreadCount);
router.put('/read', authenticateToken, NotificationController.markNotificationsRead);

module.exports = router;
