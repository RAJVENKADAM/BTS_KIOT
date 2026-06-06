const Bus = require('../models/Bus');
const BusRoute = require('../models/BusRoute');
const BusLiveLocation = require('../models/BusLiveLocation');
const gpsService = require('../services/gpsService');
const trackingService = require('../services/trackingService');
const NotificationService = require('../services/notificationService');

// ================= UPLOAD BUS ROUTES =================
async function uploadBusRoutes(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { busNo, previewNumber, gpsId, deviceId, regNo } = req.body;

    if (!busNo || !deviceId) {
      return res.status(400).json({ error: 'Bus number and device ID are required' });
    }

    // Find or create bus
    let bus = await Bus.findOne({ bus_no: busNo.toUpperCase() });

    if (bus) {
      // Update existing bus
      bus.gps_device_id = deviceId;
      bus.reg_no = regNo;
      if (previewNumber) bus.preview_number = previewNumber;
      await bus.save();
    } else {
      // Create new bus
      bus = await Bus.create({
        bus_no: busNo.toUpperCase(),
        bus_name: busNo,
        gps_device_id: deviceId,
        reg_no: regNo,
        preview_number: previewNumber,
        status: 'active'
      });
    }

    res.status(200).json({
      message: bus ? 'Bus updated' : 'Bus created',
      busNo: bus.bus_no,
      previewNumber: bus.preview_number,
      routesCount: 0
    });

  } catch (error) {
    console.error('UPLOAD ERROR:', error);
    res.status(500).json({ error: error.message });
  }
}

// ================= UPDATE BUS =================
async function updateBusNumber(req, res) {
  try {
    const { busNo } = req.params;
    const { newBusNo, previewNumber } = req.body;

    let finalBusNo = busNo;

    if (newBusNo && newBusNo !== busNo) {
      const exists = await Bus.findOne({ bus_no: newBusNo.toUpperCase() });
      if (exists) {
        return res.status(400).json({ error: 'Bus number already exists' });
      }

      await Bus.updateOne(
        { bus_no: busNo.toUpperCase() },
        { bus_no: newBusNo.toUpperCase() }
      );
      finalBusNo = newBusNo;
    }

    if (previewNumber !== undefined) {
      const exists = await Bus.findOne({ 
        preview_number: previewNumber, 
        bus_no: { $ne: finalBusNo.toUpperCase() } 
      });
      if (exists) {
        return res.status(400).json({ error: 'Preview number already used' });
      }

      await Bus.updateOne(
        { bus_no: finalBusNo.toUpperCase() },
        { preview_number: previewNumber }
      );
    }

    res.status(200).json({
      message: 'Bus updated successfully',
      busNo: finalBusNo,
      previewNumber
    });

  } catch (error) {
    console.error('UPDATE ERROR:', error);
    res.status(500).json({ error: error.message });
  }
}

// ================= GET ALL BUSES WITH LIVE GPS =================
async function getAllBuses(req, res) {
  try {
    const buses = await Bus.find({ status: 'active' })
      .sort({ preview_number: 1, bus_no: 1 });

    const enrichedBuses = [];

    for (const bus of buses) {
      const liveLocation = await BusLiveLocation.findOne({ bus_id: bus._id });
      const gpsLocation = await gpsService.getCachedLocation(bus.bus_no);
      const location = liveLocation || gpsLocation;

      enrichedBuses.push({
        busNo: bus.bus_no,
        previewNumber: bus.preview_number,
        status: bus.status,
        gpsDeviceId: bus.gps_device_id,
        mobileLive: bus.mobile_live,
        currentPlan: bus.current_plan,
        latitude: location?.latitude || null,
        longitude: location?.longitude || null,
        speed: location?.speed || 0,
        isOnline: location ? true : false
      });
    }

    res.status(200).json({
      buses: enrichedBuses,
      count: enrichedBuses.length
    });

  } catch (error) {
    console.error('GET ALL BUSES ERROR:', error);
    res.status(500).json({ error: error.message });
  }
}

// ================= DELETE BUS =================
async function deleteBus(req, res) {
  try {
    const { busNo } = req.params;

    const bus = await Bus.findOne({ bus_no: busNo.toUpperCase() });
    if (!bus) {
      return res.status(404).json({ error: `Bus ${busNo} not found` });
    }

    await BusRoute.deleteMany({ bus_id: bus._id });
    await BusLiveLocation.deleteMany({ bus_id: bus._id });
    await Bus.deleteOne({ _id: bus._id });

    res.json({ message: 'Bus deleted successfully' });

  } catch (error) {
    console.error('Delete bus error:', error);
    res.status(500).json({ error: error.message });
  }
}

// ================= ACTIVATE BUS =================
async function activateBus(req, res) {
  try {
    const { busNo } = req.params;

    await Bus.updateOne(
      { bus_no: busNo.toUpperCase() },
      { status: 'active' }
    );

    res.json({ message: 'Bus activated' });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ================= VALIDATE PREVIEW NUMBER =================
async function validatePreviewNumber(req, res) {
  try {
    const { previewNumber } = req.params;
    const exists = await Bus.findOne({ preview_number: previewNumber });
    res.json({ valid: !exists });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ================= UPDATE PREVIEW NUMBER =================
async function updatePreviewNumber(req, res) {
  try {
    const { busNo } = req.params;
    const { previewNumber } = req.body;

    await Bus.updateOne(
      { bus_no: busNo.toUpperCase() },
      { preview_number: previewNumber }
    );

    res.json({ message: 'Preview updated successfully' });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ================= UPDATE PLAN =================
async function updatePlan(req, res) {
  try {
    const { busNo } = req.params;
    const { plan } = req.body;

    await Bus.updateOne(
      { bus_no: busNo.toUpperCase() },
      { current_plan: plan }
    );

    await NotificationService.notifyBusUpdate({
      actorId: req.user.id,
      actionType: 'PLAN_CHANGED',
      busNumbers: [busNo],
      title: `Route Plan Updated`,
      body: `Bus plan is now ${plan}`,
      currentPlan: plan
    });

    res.json({ 
      success: true, 
      message: 'Plan updated successfully',
      busNo: busNo,
      newPlan: plan 
    });

  } catch (error) {
    console.error('Update plan error:', error);
    res.status(500).json({ error: error.message });
  }
}

// ================= GET PLANS =================
async function getPlans(req, res) {
  try {
    const { busNo } = req.params;

    const bus = await Bus.findOne({ bus_no: busNo.toUpperCase() });
    if (!bus) {
      return res.status(404).json({ error: `Bus ${busNo} not found` });
    }

    const routes = await BusRoute.find({ bus_id: bus._id })
      .distinct('plan_name')
      .sort();

    res.json({ plans: routes });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ================= GET LIVE LOCATION =================
async function getLiveLocation(req, res) {
  try {
    const { busNo } = req.params;

    const bus = await Bus.findOne({
      $or: [
        { bus_no: busNo.toUpperCase() },
        { preview_number: busNo }
      ]
    });

    if (!bus) {
      return res.status(404).json({
        success: false,
        busNo,
        latitude: null,
        longitude: null,
        speed: null,
        status: 'offline'
      });
    }

    const liveLocation = await BusLiveLocation.findOne({ bus_id: bus._id });
    const gpsLocation = await gpsService.getCachedLocation(bus.bus_no);
    const location = liveLocation || gpsLocation;

    res.status(location ? 200 : 404).json({
      success: !!location,
      busNo: bus.bus_no,
      latitude: location?.latitude || null,
      longitude: location?.longitude || null,
      speed: location?.speed || 0,
      status: location ? 'online' : 'offline',
      source: location?.source || 'none',
      updatedAt: location?.updatedAt || new Date()
    });

  } catch (error) {
    console.error('getLiveLocation error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
}

// ================= TRACK BY PREVIEW =================
async function trackByPreview(req, res) {
  try {
    const { previewNumber } = req.params;

    const bus = await Bus.findOne({ 
      preview_number: previewNumber,
      status: 'active' 
    });

    if (!bus) {
      return res.status(404).json({ error: 'No bus found for preview number' });
    }

    const liveLocation = await BusLiveLocation.findOne({ bus_id: bus._id });
    const gpsLocation = await gpsService.getCachedLocation(bus.bus_no);
    const location = liveLocation || gpsLocation;

    res.status(location ? 200 : 404).json({
      success: !!location,
      busNo: bus.bus_no,
      previewNumber: bus.preview_number,
      latitude: location?.latitude || null,
      longitude: location?.longitude || null,
      speed: location?.speed || 0,
      status: location ? 'online' : 'offline'
    });

  } catch (error) {
    console.error('trackByPreview error:', error);
    res.status(500).json({ error: error.message });
  }
}

module.exports = {
  uploadBusRoutes,
  updateBusNumber,
  getAllBuses,
  deleteBus,
  activateBus,
  validatePreviewNumber,
  updatePreviewNumber,
  updatePlan,
  getPlans,
  getLiveLocation,
  trackByPreview
};
