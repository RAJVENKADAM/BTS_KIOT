const axios = require('axios');
const { pool } = require('../config/db');
const { getIO } = require('../socket');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

class NotificationService {
  // ------------------------------------------------------------------
  // Ensure users table has push_token column (MySQL-safe)
  // ------------------------------------------------------------------
  async ensurePushTokenColumn() {
    try {
      const [columns] = await pool.execute(`SHOW COLUMNS FROM users LIKE 'push_token'`);
      if (columns.length === 0) {
        await pool.execute(`ALTER TABLE users ADD COLUMN push_token VARCHAR(255) NULL`);
        console.log('[DB] Added push_token column to users table');

        // Attempt to add indexes (ignore errors on older MySQL)
        try {
          await pool.execute(`CREATE INDEX idx_users_push_token ON users(push_token)`);
          await pool.execute(`CREATE INDEX idx_users_bus_active ON users(bus_no, is_active)`);
        } catch (idxErr) {
          // Index may already exist or MySQL version limitation
        }
      }
    } catch (err) {
      console.error('[DB] Error ensuring push_token column:', err.message);
    }
  }

  // ------------------------------------------------------------------
  // Register / update push token for a user (with bus_no)
  // ------------------------------------------------------------------
  async registerToken(userId, token, busNo = null) {
    try {
      await this.ensurePushTokenColumn();

      // Prevent duplicate tokens across users — if another user has this token, clear it
      if (token) {
        const [dupes] = await pool.execute(
          'SELECT id FROM users WHERE push_token = ? AND id != ? LIMIT 1',
          [token, userId]
        );
        if (dupes.length > 0) {
          await pool.execute(
            'UPDATE users SET push_token = NULL WHERE push_token = ? AND id != ?',
            [token, userId]
          );
          console.log(`[PushNotify] Cleared duplicate token from user ${dupes[0].id}`);
        }
      }

      const updates = ['push_token = ?'];
      const values = [token];

      if (busNo !== null && busNo !== undefined) {
        updates.push('bus_no = ?');
        values.push(busNo);
      }

      values.push(userId);
      await pool.execute(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);

      console.log(`[PushNotify] Token registered for user ${userId}, bus: ${busNo || 'unchanged'}`);
      return { success: true };
    } catch (error) {
      console.error('[PushNotify] Error registering token:', error.message);
      throw new Error(`Error registering push token: ${error.message}`);
    }
  }

  // ------------------------------------------------------------------
  // Bus-based notification sending
  // ------------------------------------------------------------------
  async notifyBusUpdate({ actorId = null, actionType, busNumbers = [], title = null, body = null, currentPlan = null }) {
    if (!actionType || !Array.isArray(busNumbers) || busNumbers.length === 0) {
      throw new Error('actionType and busNumbers are required for notifications');
    }

    const timestamp = new Date().toISOString();
    const busesText = busNumbers.join(', ');
    const messageText = body || `Bus update: ${actionType} for ${busesText} at ${timestamp}`;

    console.log(`[PushNotify] Route update detected: ${actionType} for buses ${busesText}`);

    await this.ensurePushTokenColumn();

    let tokens = [];
    let tokenUserMap = [];

    // 1. Fetch tokens for affected buses
    try {
      const placeholders = busNumbers.map(() => '?').join(',');
      const [rows] = await pool.execute(
        `SELECT id, push_token, bus_no FROM users WHERE bus_no IN (${placeholders}) AND is_active = 1 AND push_token IS NOT NULL AND push_token != ''`,
        busNumbers
      );
      tokenUserMap = rows;
      tokens = rows.map((u) => u.push_token).filter(Boolean);
      console.log(`[PushNotify] Fetched ${tokens.length} tokens for buses ${busesText}`);
    } catch (err) {
      console.error('[PushNotify] Error fetching tokens:', err.message);
      return { success: false, error: err.message };
    }

    // 2. Handle empty token list
    if (tokens.length === 0) {
      console.log(`[PushNotify] No tokens found for buses ${busesText}, skipping push notifications`);
    } else {
      // 3. Validate Expo token format
      const validEntries = tokenUserMap.filter((u) =>
        typeof u.push_token === 'string' &&
        (u.push_token.startsWith('ExponentPushToken[') || u.push_token.startsWith('ExpoPushToken['))
      );
      const validTokens = validEntries.map((u) => u.push_token);

      if (validTokens.length !== tokens.length) {
        console.warn(`[PushNotify] Filtered out ${tokens.length - validTokens.length} invalid tokens`);
      }

      if (validTokens.length === 0) {
        console.log('[PushNotify] No valid Expo tokens after filtering');
      } else {
        // 4. Batch send (Expo limit: 100 per request)
        const batches = [];
        for (let i = 0; i < validTokens.length; i += 100) {
          batches.push(validTokens.slice(i, i + 100));
        }

        for (const batch of batches) {
          const messages = batch.map((token) => ({
            to: token,
            title: title || `Bus Update: ${actionType}`,
            body: messageText,
            data: { actionType, busNumbers, currentPlan, timestamp },
            sound: 'default',
            priority: 'high',
          }));

          try {
            console.log(`[PushNotify] Sending batch of ${messages.length} notifications to Expo...`);
            const response = await axios.post(EXPO_PUSH_URL, messages, {
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'Accept-Encoding': 'gzip, deflate',
              },
              timeout: 15000,
            });

            console.log(`[PushNotify] Expo API response status: ${response.status}`);

            // 5. Parse Expo response for invalid tokens
            if (response.data?.data && Array.isArray(response.data.data)) {
              const invalidTokens = [];
              response.data.data.forEach((result, idx) => {
                if (result.status === 'error') {
                  console.error(`[PushNotify] Push error for token ${batch[idx]}: ${result.message}`);
                  if (result.details?.error === 'DeviceNotRegistered') {
                    invalidTokens.push(batch[idx]);
                  }
                }
              });

              if (invalidTokens.length > 0) {
                console.log(`[PushNotify] Removing ${invalidTokens.length} invalid tokens from database`);
                const placeholders = invalidTokens.map(() => '?').join(',');
                await pool.execute(
                  `UPDATE users SET push_token = NULL WHERE push_token IN (${placeholders})`,
                  invalidTokens
                );
              }
            }
          } catch (err) {
            console.error('[PushNotify] Expo API error:', err.message);
            if (err.response) {
              console.error('[PushNotify] Expo API response data:', JSON.stringify(err.response.data));
            }

            // 6. Retry once for network failures
            const isNetworkError = !err.response || ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'].includes(err.code);
            if (isNetworkError) {
              console.log('[PushNotify] Network failure detected. Retrying batch in 2 seconds...');
              await new Promise((r) => setTimeout(r, 2000));
              try {
                await axios.post(EXPO_PUSH_URL, messages, {
                  headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'Accept-Encoding': 'gzip, deflate',
                  },
                  timeout: 15000,
                });
                console.log('[PushNotify] Retry successful');
              } catch (retryErr) {
                console.error('[PushNotify] Retry failed:', retryErr.message);
              }
            }
          }
        }
      }
    }

    // 7. Emit real-time socket.io events (hybrid: app open → socket, app closed → push)
    try {
      const io = getIO();
      if (io) {
        for (const busNo of busNumbers) {
          const room = `bus-${busNo}`;
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

