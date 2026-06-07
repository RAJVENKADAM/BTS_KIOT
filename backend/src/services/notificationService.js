const { getIO } = require('../socket');

// NOTE:
// Push notifications have been removed.
// This service now ONLY emits real-time socket.io events for bus updates.
class NotificationService {
  async notifyBusUpdate({ actionType, busNumbers = [], title = null, body = null, currentPlan = null }) {
    if (!actionType || !Array.isArray(busNumbers) || busNumbers.length === 0) {
      throw new Error('actionType and busNumbers are required');
    }

    const timestamp = new Date().toISOString();
    const busesText = busNumbers.join(', ');
    const messageText = body || title || `Bus update: ${actionType} for ${busesText} at ${timestamp}`;

    try {
      const io = getIO();
      if (io) {
        for (const busNo of busNumbers) {
          const room = `bus_${busNo}`;
          io.to(room).emit('bus-update', {
            actionType,
            busNo,
            currentPlan: currentPlan || 'Plan A',
            message: messageText,
            timestamp,
          });
          console.log(`[Socket] Emitted bus-update to room: ${room}`);
        }
      }
    } catch (err) {
      console.error('[Socket] Error emitting bus-update:', err.message);
    }

    return { success: true };
  }
}

module.exports = new NotificationService();


