const axios = require('axios');
const { pool } = require('../config/db');
const { getIO } = require('../socket');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

class NotificationService {
  // Ensure users table has device_token column before using it.
  async ensureDeviceTokenColumn() {
    try {
      await pool.execute(`ALTER TABLE users ADD COLUMN IF NOT EXISTS device_token VARCHAR(255) NULL`);
    } catch (err) {
      // Some MySQL versions don't support IF NOT EXISTS for ADD COLUMN; ignore errors here
    }
  }

  // Register a device token for a user
  async registerToken(userId, token) {
    try {
      await this.ensureDeviceTokenColumn();
      await pool.execute('UPDATE users SET device_token = ? WHERE id = ?', [token, userId]);
      return { success: true };
    } catch (error) {
      throw new Error(`Error registering device token: ${error.message}`);
    }
  }

  // Create DB message for each affected bus and send push notifications to users assigned to those buses
  async notifyBusUpdate({ actorId = null, actionType, busNumbers = [], title = null, body = null }) {
    if (!actionType || !Array.isArray(busNumbers) || busNumbers.length === 0) {
      throw new Error('actionType and busNumbers are required for notifications');
    }

    // Build message text if not provided
    const timestamp = new Date().toISOString();
    const busesText = busNumbers.join(', ');
    const messageText = body || `Bus update: ${actionType} for ${busesText} at ${timestamp}`;

    // Insert a message record per bus (message_type BUS_UPDATE)
    try {
      for (const busNo of busNumbers) {
        await pool.execute(
          'INSERT INTO messages (sender_id, recipient_role, bus_number, message, message_type, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
          [actorId || 0, 'BUS_USERS', busNo, messageText, 'BUS_UPDATE']
        );
      }
    } catch (err) {
      // If schema differs, try alternative column names used elsewhere
      try {
        for (const busNo of busNumbers) {
          await pool.execute(
            'INSERT INTO messages (created_by, bus_no, message, message_type, created_at) VALUES (?, ?, ?, ?, NOW())',
            [actorId || 0, busNo, messageText, 'BUS_UPDATE']
          );
        }
      } catch (err2) {
        console.error('Failed to insert messages for bus update:', err2.message);
      }
    }

    // Send push notifications to users assigned to these buses
    try {
      await this.ensureDeviceTokenColumn();

      const placeholders = busNumbers.map(() => '?').join(',');
      const [users] = await pool.execute(
        `SELECT id, device_token, bus_no FROM users WHERE bus_no IN (${placeholders}) AND is_active = 1 AND device_token IS NOT NULL`,
        busNumbers
      );

      const tokens = users.map(u => u.device_token).filter(Boolean);

      if (tokens.length > 0) {
        // Expo allows batch up to 100
        const batches = [];
        for (let i = 0; i < tokens.length; i += 100) {
          batches.push(tokens.slice(i, i + 100));
        }

        for (const batch of batches) {
          const messages = batch.map(token => ({
            to: token,
            title: title || `Bus Update: ${actionType}`,
            body: messageText,
            data: { actionType, busNumbers, timestamp }
          }));

          // Send to Expo Push API
          try {
            await axios.post(EXPO_PUSH_URL, messages, {
              headers: { 'Content-Type': 'application/json' }
            });
          } catch (err) {
            console.error('Error sending push notifications:', err.message);
          }
        }
      }
    } catch (err) {
      console.error('Error during push notification flow:', err.message);
    }

    // Emit real-time socket.io events to affected bus rooms
    try {
      const io = getIO();
      if (io) {
        for (const busNo of busNumbers) {
          const room = `bus-${busNo}`;
          io.to(room).emit('bus-update', { actionType, busNo, message: messageText, timestamp });
        }
      }
    } catch (err) {
      console.error('Error emitting socket.io bus-update:', err.message);
    }

    return { success: true };
  }
}

module.exports = new NotificationService();
