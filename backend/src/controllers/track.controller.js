const User = require('../models/User');
const Bus = require('../models/Bus');
const BusLiveLocation = require('../models/BusLiveLocation');
const { getIO } = require('../socket');

// ================= UPDATE LOCATION =================
async function updateLocation(req, res) {
  try {
    const userId = req.user.id;
    const { latitude, longitude } = req.body;

    // Find user
    const user = await User.findById(userId);
    if (!user || !user.is_active) {
      return res.status(404).json({ error: 'User not found or inactive' });
    }

    if (!user.bus_no) {
      return res.status(400).json({ error: 'User is not assigned to a bus' });
    }

    // Validate coordinates
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

    // Find bus
    const bus = await Bus.findOne({ bus_no: user.bus_no });
    if (!bus) {
      return res.status(404).json({ error: 'Bus not found' });
    }

    // Update or create live location
    await BusLiveLocation.updateOne(
      { bus_id: bus._id },
      {
        bus_id: bus._id,
        user_id: userId,
        latitude,
        longitude,
        is_online: true,
        source: 'mobile',
        updatedAt: new Date()
      },
      { upsert: true }
    );

    // Emit via Socket.io
    const io = getIO();
    if (io) {
      io.of('/bus-location').to(`bus_${bus._id}`).emit('liveLocationUpdate', {
        busId: bus._id,
        busNo: bus.bus_no,
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
      busNo: bus.bus_no,
      latitude,
      longitude
    });
  } catch (error) {
    console.error('Error updating location:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ================= GET LIVE LOCATION =================
async function getLiveLocation(req, res) {
  try {
    const { busNo } = req.params;

    // Find bus
    const bus = await Bus.findOne({
      $or: [{ bus_no: busNo }, { preview_number: busNo }]
    });

    if (!bus) {
      return res.status(404).json({ error: 'Bus not found' });
    }

    // Get live location
    const location = await BusLiveLocation.findOne({ bus_id: bus._id })
      .populate('user_id', 'name email role');

    res.status(location ? 200 : 404).json({
      busId: bus._id,
      busNo: bus.bus_no,
      latitude: location?.latitude || null,
      longitude: location?.longitude || null,
      isOnline: location?.is_online || false,
      lastUpdated: location?.updatedAt || null,
      driverName: location?.user_id?.name || null,
      source: location?.source || 'offline'
    });
  } catch (error) {
    console.error('Error getting live location:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ================= TOGGLE TRACKING =================
async function toggleTracking(req, res) {
  try {
    const userId = req.user.id;
    const { action } = req.body;

    if (!['start', 'stop'].includes(action)) {
      return res.status(400).json({ error: 'Action must be either "start" or "stop"' });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user || !user.is_active) {
      return res.status(404).json({ error: 'User not found or inactive' });
    }

    if (!user.bus_no) {
      return res.status(400).json({ error: 'User is not assigned to a bus' });
    }

    // Find bus
    const bus = await Bus.findOne({ bus_no: user.bus_no });
    if (!bus) {
      return res.status(404).json({ error: 'Bus not found' });
    }

    const isOnline = action === 'start';

    // Update location record
    await BusLiveLocation.updateOne(
      { bus_id: bus._id },
      {
        bus_id: bus._id,
        user_id: userId,
        is_online: isOnline,
        updatedAt: new Date()
      },
      { upsert: true }
    );

    // Emit via Socket.io
    const io = getIO();
    if (io) {
      io.of('/bus-location').to(`bus_${bus._id}`).emit('trackingStatusUpdate', {
        busId: bus._id,
        busNo: bus.bus_no,
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
      busNo: bus.bus_no,
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
