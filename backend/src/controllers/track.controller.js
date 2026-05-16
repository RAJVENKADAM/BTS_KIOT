const { pool } = require('../config/db');
const { getIO } = require('../socket');
const trackingService = require('../services/trackingService');
const { getBusIdByBusNo } = require('../services/busIdHelper');

// Update user's live location (mobile push)
async function updateLocation(req, res) {
  try {
    const userId = req.user.id;
    const { latitude, longitude } = req.body;

    const [userResult] = await pool.execute(
      'SELECT id, name, email, role, bus_no FROM users WHERE id = ? AND is_active = TRUE',
      [userId]
    );

    if (userResult.length === 0) {
      return res.status(404).json({ error: 'User not found or inactive' });
    }

    const user = userResult[0];

    if (!user.bus_no) {
      return res.status(400).json({ error: 'User is not assigned to a bus' });
    }

    if (
      typeof latitude !== 'number' ||
      typeof longitude !== 'number' ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }

    const busId = await getBusIdByBusNo(user.bus_no);
    if (!busId) {
      return res.status(404).json({ error: 'Bus not found for user assignment' });
    }

    await pool.execute(`
      INSERT INTO bus_live_locations (bus_id, latitude, longitude, user_id, is_online)
      VALUES (?, ?, ?, ?, TRUE)
      ON DUPLICATE KEY UPDATE
        latitude = VALUES(latitude),
        longitude = VALUES(longitude),
        user_id = VALUES(user_id),
        is_online = TRUE,
        updated_at = CURRENT_TIMESTAMP
    `, [busId, latitude, longitude, userId]);

    const io = getIO();
    if (io) {
      io.to(`bus_${busId}`).emit('liveLocationUpdate', {
        busId,
        busNo: user.bus_no,
        latitude,
        longitude,
        timestamp: new Date(),
        user: {
          id: userId,
          name: user.name
        }
      });
    }

    // Keep response compatible with existing frontend (busNo)
    res.status(200).json({
      message: 'Location updated successfully',
      busNo: user.bus_no,
      busId,
      latitude,
      longitude
    });
  } catch (error) {
    console.error('Error updating location:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Get live location for a specific bus (API param is busNo)
async function getLiveLocation(req, res) {
  try {
    const { busNo } = req.params;

    const busId = await getBusIdByBusNo(busNo);
    if (!busId) {
      return res.status(404).json({ error: 'Bus not found' });
    }

    // Memory state is keyed by busId
    const memState = trackingService.busTrackingState[busId];
    if (memState && memState.activeSource !== 'none') {
      const data = memState.activeSource === 'mobile' ? memState.mobile : memState.gps;
      return res.status(200).json({
        busId,
        busNo,
        latitude: data.latitude,
        longitude: data.longitude,
        isOnline: true,
        status: memState.activeSource,
        lastUpdated: new Date(data.timestamp)
      });
    }

    const [locationResult] = await pool.execute(`
      SELECT bl.*, u.name as driver_name
      FROM bus_live_locations bl
      LEFT JOIN users u ON bl.user_id = u.id AND u.role = 'primary_admin'
      WHERE bl.bus_id = ?
    `, [busId]);

    if (locationResult.length === 0) {
      return res.status(404).json({ error: 'No live location found for this bus' });
    }

    const location = locationResult[0];

    res.status(200).json({
      busId: location.bus_id,
      busNo,
      latitude: location.latitude,
      longitude: location.longitude,
      isOnline: location.is_online,
      lastUpdated: location.updated_at,
      driverName: location.driver_name
    });
  } catch (error) {
    console.error('Error getting live location:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Toggle tracking status (start/stop)
async function toggleTracking(req, res) {
  try {
    const userId = req.user.id;
    const { action } = req.body;

    if (!['start', 'stop'].includes(action)) {
      return res.status(400).json({ error: 'Action must be either "start" or "stop"' });
    }

    const [userResult] = await pool.execute(
      'SELECT id, name, email, role, bus_no FROM users WHERE id = ? AND is_active = TRUE',
      [userId]
    );

    if (userResult.length === 0) {
      return res.status(404).json({ error: 'User not found or inactive' });
    }

    const user = userResult[0];

    if (!user.bus_no) {
      return res.status(400).json({ error: 'User is not assigned to a bus' });
    }

    const busId = await getBusIdByBusNo(user.bus_no);
    if (!busId) {
      return res.status(404).json({ error: 'Bus not found for user assignment' });
    }

    const isOnline = action === 'start';

    await pool.execute(`
      INSERT INTO bus_live_locations (bus_id, latitude, longitude, user_id, is_online)
      VALUES (?, 0, 0, ?, ?)
      ON DUPLICATE KEY UPDATE
        is_online = ?,
        updated_at = CURRENT_TIMESTAMP
    `, [busId, userId, isOnline, isOnline]);

    const io = getIO();
    if (io) {
      io.to(`bus_${busId}`).emit('trackingStatusUpdate', {
        busId,
        busNo: user.bus_no,
        isOnline,
        action,
        timestamp: new Date(),
        user: {
          id: userId,
          name: user.name
        }
      });
    }

    res.status(200).json({
      message: `Tracking ${action === 'start' ? 'started' : 'stopped'} successfully`,
      busNo: user.bus_no,
      busId,
      isOnline
    });
  } catch (error) {
    console.error('Error toggling tracking:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  updateLocation,
  getLiveLocation,
  toggleTracking
};

