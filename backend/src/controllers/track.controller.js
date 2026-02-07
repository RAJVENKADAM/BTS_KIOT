const { pool } = require('../config/db');
const { getIO } = require('../socket'); // Get the shared Socket.IO instance

// Update user's live location
async function updateLocation(req, res) {
  try {
    const userId = req.user.id;
    const { latitude, longitude } = req.body;

    // Get user details to verify bus assignment
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

    // Validate coordinates
    if (typeof latitude !== 'number' || typeof longitude !== 'number' ||
        latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }

    // Update or insert live location
    const [result] = await pool.execute(`
      INSERT INTO bus_live_locations (bus_no, latitude, longitude, user_id, is_online)
      VALUES (?, ?, ?, ?, TRUE)
      ON DUPLICATE KEY UPDATE 
      latitude = VALUES(latitude), 
      longitude = VALUES(longitude), 
      user_id = VALUES(user_id),
      is_online = TRUE,
      updated_at = CURRENT_TIMESTAMP
    `, [user.bus_no, latitude, longitude, userId]);

    // Emit live location update to connected clients
    const io = getIO();
    if (io) {
      io.to(`bus_${user.bus_no}`).emit('liveLocationUpdate', {
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

    res.status(200).json({
      message: 'Location updated successfully',
      busNo: user.bus_no,
      latitude,
      longitude
    });
  } catch (error) {
    console.error('Error updating location:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Get live location for a specific bus
async function getLiveLocation(req, res) {
  try {
    const { busNo } = req.params;
    const userId = req.user.id;

    // Check if user has permission to view this bus location
    const [userResult] = await pool.execute(
      'SELECT id, role, bus_no FROM users WHERE id = ? AND is_active = TRUE',
      [userId]
    );

    if (userResult.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult[0];
    const hasPermission = 
      user.role === 'SUPERADMIN' || 
      user.bus_no === busNo;

    if (!hasPermission) {
      return res.status(403).json({ error: 'Insufficient permissions to view this bus location' });
    }

    // Get live location
    const [locationResult] = await pool.execute(`
      SELECT bl.*, u.name as driver_name 
      FROM bus_live_locations bl
      LEFT JOIN users u ON bl.user_id = u.id
      WHERE bl.bus_no = ?
    `, [busNo]);

    if (locationResult.length === 0) {
      return res.status(404).json({ error: 'No live location found for this bus' });
    }

    const location = locationResult[0];

    res.status(200).json({
      busNo: location.bus_no,
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
    const { action } = req.body; // 'start' or 'stop'

    if (!['start', 'stop'].includes(action)) {
      return res.status(400).json({ error: 'Action must be either "start" or "stop"' });
    }

    // Get user details
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

    // Update online status
    const isOnline = action === 'start';
    await pool.execute(`
      INSERT INTO bus_live_locations (bus_no, latitude, longitude, user_id, is_online)
      VALUES (?, 0, 0, ?, ?)
      ON DUPLICATE KEY UPDATE 
      is_online = ?,
      updated_at = CURRENT_TIMESTAMP
    `, [user.bus_no, userId, isOnline, isOnline]);

    // Emit tracking status update to connected clients
    const io = getIO();
    if (io) {
      io.to(`bus_${user.bus_no}`).emit('trackingStatusUpdate', {
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