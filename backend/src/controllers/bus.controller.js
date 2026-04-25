const ExcelBusService = require('../services/excelBusService');
const NotificationService = require('../services/notificationService');
const trackingService = require('../services/trackingService');
const gpsService = require('../services/gpsService');
const busStateService = require('../services/busStateService');
const { pool } = require('../config/db');

// ================= UPLOAD BUS =================
async function uploadBusRoutes(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { busNo, previewNumber, gpsId } = req.body;

    if (!busNo) {
      return res.status(400).json({ error: 'Bus number is required' });
    }

    const routesData = await ExcelBusService.processExcelFile(req.file.path);

    const busData = {
      busNo,
      previewNumber: previewNumber || null,
      gpsId,
      routes: routesData.routes
    };

    const result = await ExcelBusService.saveBusWithRoutes(
      busData,
      req.user.id
    );

    res.status(200).json({
      message: result.busExists ? 'Bus updated' : 'Bus created',
      busNo: result.busNo,
      previewNumber: result.previewNumber,
      routesCount: result.routesCount,
      stopsCount: result.stopsCount
    });

  } catch (err) {
    console.error('UPLOAD ERROR:', err);
    res.status(500).json({ error: err.message });
  }
}

// ================= UPDATE BUS =================
async function updateBusNumber(req, res) {
  try {
    const { busNo } = req.params;
    const { newBusNo, previewNumber } = req.body;

    let finalBusNo = busNo;

    // UPDATE BUS NUMBER
    if (newBusNo && newBusNo !== busNo) {
      const [exists] = await pool.execute(
        'SELECT id FROM buses WHERE bus_no = ?',
        [newBusNo]
      );

      if (exists.length > 0) {
        return res.status(400).json({ error: 'Bus number already exists' });
      }

      await pool.execute(
        'UPDATE buses SET bus_no = ? WHERE bus_no = ?',
        [newBusNo, busNo]
      );

      await pool.execute(
        'UPDATE users SET bus_no = ? WHERE bus_no = ?',
        [newBusNo, busNo]
      );

      finalBusNo = newBusNo;
    }

    // UPDATE PREVIEW NUMBER
    if (previewNumber !== undefined) {
      const [exists] = await pool.execute(
        'SELECT id FROM buses WHERE preview_number = ? AND bus_no != ?',
        [previewNumber, finalBusNo]
      );

      if (exists.length > 0) {
        return res.status(400).json({ error: 'Preview number already used' });
      }

      await pool.execute(
        'UPDATE buses SET preview_number = ? WHERE bus_no = ?',
        [previewNumber, finalBusNo]
      );
    }

    res.status(200).json({
      message: 'Bus updated successfully',
      busNo: finalBusNo,
      previewNumber
    });

  } catch (err) {
    console.error('UPDATE ERROR:', err);
    res.status(500).json({ error: err.message });
  }
}

// ================= GET ALL BUSES WITH LIVE GPS =================
async function getAllBuses(req, res) {
  try {
    const [dbBuses] = await pool.execute(`
      SELECT bus_no, preview_number, status, gps_device_id, mobile_live, current_plan
      FROM buses WHERE status = 'active'
      ORDER BY CAST(preview_number AS UNSIGNED), bus_no ASC
    `);

    const gpsLocations = gpsService.getAllCachedLocations();
    const gpsMap = new Map(gpsLocations.map(loc => [loc.busNo, loc]));

    // Get live locations from tracking state
    const trackingLive = [];
    for (const [busNo, state] of Object.entries(trackingService.busTrackingState || {})) {
      const now = Date.now();
      let location = null;
      if (state.activeSource === 'mobile' && state.mobile?.timestamp > now - 10000) {
        location = { ...state.mobile, source: 'mobile' };
      } else if (state.activeSource === 'gps' && state.gps?.timestamp > now - 20000) {
        location = { ...state.gps, source: 'gps' };
      } else if (state.external_gps?.timestamp > now - 30000) {
        location = { ...state.external_gps, source: 'external_gps' };
      }
      if (location) {
        trackingLive.push({ busNo, ...location, source: location.source });
      }
    }
    const trackingMap = new Map(trackingLive.map(loc => [loc.busNo.toUpperCase(), loc]));

    // Get bus states
    const busStates = await busStateService.getAllBusStates();
    const stateMap = new Map(busStates.map(state => [state.bus_no, state]));

    // Enrich buses
    const enrichedBuses = dbBuses.map(row => {
      const busNo = row.bus_no;
      const gpsData = gpsMap.get(busNo.toUpperCase()) || trackingMap.get(busNo.toUpperCase());
      const busState = stateMap.get(busNo);
      
      return {
        busNo,
        previewNumber: row.preview_number,
        status: row.status,
        gpsDeviceId: row.gps_device_id,
        mobileLive: row.mobile_live,
        currentPlan: row.current_plan,
        busState: busState?.state || 'moving',
        ...gpsData,
        isOnline: gpsData ? gpsData.isOnline ?? true : false
      };
    });

    res.status(200).json({
      buses: enrichedBuses,
      gpsCount: gpsLocations.length,
      trackingCount: trackingLive.length,
      count: enrichedBuses.length
    });

  } catch (error) {
    console.error('GET ALL BUSES ERROR:', error);
    res.status(500).json({ error: error.message });
  }
}

// ================= DELETE =================
async function deleteBus(req, res) {
  try {
    const { busNo } = req.params;

    // 1. Find bus_id first
    const [busResult] = await pool.execute('SELECT id FROM buses WHERE bus_no = ?', [busNo]);
    if (busResult.length === 0) {
      return res.status(404).json({ error: `Bus ${busNo} not found` });
    }
    const busId = busResult[0].id;

    // 2. Delete related records (cascade)
    await pool.execute('DELETE FROM bus_routes WHERE bus_id = ?', [busId]);
    await pool.execute('DELETE FROM bus_states WHERE bus_no = ?', [busNo]);

    // 3. Reset user assignments (if any)
    await pool.execute('UPDATE users SET bus_no = NULL WHERE bus_no = ?', [busNo]);

    // 4. Hard delete bus
    await pool.execute('DELETE FROM buses WHERE bus_no = ?', [busNo]);

    res.json({ message: 'Bus deleted successfully from database' });

  } catch (err) {
    console.error('Delete bus error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ================= ACTIVATE =================
async function activateBus(req, res) {
  try {
    const { busNo } = req.params;

    await pool.execute(
      'UPDATE buses SET status = "active" WHERE bus_no = ?',
      [busNo]
    );

    res.json({ message: 'Bus activated' });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ================= VALIDATE PREVIEW =================
async function validatePreviewNumber(req, res) {
  try {
    const { previewNumber } = req.params;

    const [rows] = await pool.execute(
      'SELECT id FROM buses WHERE preview_number = ?',
      [previewNumber]
    );

    res.json({ valid: rows.length === 0 });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ================= UPDATE PREVIEW =================
async function updatePreviewNumber(req, res) {
  try {
    const { busNo } = req.params;
    const { previewNumber } = req.body;

    await pool.execute(
      'UPDATE buses SET preview_number = ? WHERE bus_no = ?',
      [previewNumber, busNo]
    );

    res.json({ message: 'Preview updated successfully' });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ================= UPDATE PLAN =================
async function updatePlan(req, res) {
  try {
    const { busNo } = req.params;
    const { plan } = req.body;
    const userId = req.user.id;

    const result = await ExcelBusService.changeBusPlan(busNo, plan, userId);
    
    // Send push notification and socket emit with plan
    await NotificationService.notifyBusUpdate({
      actorId: userId,
      actionType: 'PLAN_CHANGED',
      busNumbers: [busNo],
      title: `Route Plan Updated`,
      body: `Now The bus plan is on ${plan}`,
      currentPlan: plan
    });


    res.json({ 
      success: true, 
      message: 'Plan updated successfully',
      busNo: result.busNo,
      newPlan: result.newPlan 
    });

  } catch (err) {
    console.error('Update plan error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ================= GET PLANS =================
async function getPlans(req, res) {
  try {
    const { busNo } = req.params;

    // First, find the bus_id from buses table using bus_no
    const [busResult] = await pool.execute(
      'SELECT id FROM buses WHERE bus_no = ? LIMIT 1',
      [busNo]
    );

    if (busResult.length === 0) {
      return res.status(404).json({ error: `Bus ${busNo} not found` });
    }

    const busId = busResult[0].id;

    // Get all distinct plan names for this bus
    const [plans] = await pool.execute(
      'SELECT DISTINCT plan_name FROM bus_routes WHERE bus_id = ? ORDER BY plan_name',
      [busId]
    );

    const planNames = plans.map(plan => plan.plan_name);

    res.json({ plans: planNames });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ================= LIVE LOCATION =================
async function getLiveLocation(req, res) {
  try {
    const { busNo } = req.params;

    // First find the bus by any identifier (bus_no, preview_number, reg_no)
    const [busRows] = await pool.execute(
      `SELECT bus_no, preview_number, reg_no FROM buses WHERE bus_no = ? OR preview_number = ? OR reg_no = ?`,
      [busNo, busNo, busNo]
    );

    if (busRows.length === 0) {
      return res.status(404).json({
        success: false,
        busNo,
        latitude: null,
        longitude: null,
        speed: null,
        status: 'offline',
        source: 'none',
        updatedAt: new Date().toISOString(),
        isStale: false
      });
    }

    const bus = busRows[0];
    const actualBusNo = bus.bus_no; // Use actual bus_no for lookups

    // Get bus state
    const busState = await busStateService.getBusState(actualBusNo);

    // First check tracking state using actual bus_no
    const state = trackingService.busTrackingState[actualBusNo];
    const now = Date.now();

    let location = null;
    let source = 'none';
    let isStale = false;

    if (state) {
      if (state.activeSource === 'mobile' && state.mobile && state.mobile.timestamp > now - 10000) {
        location = state.mobile;
        source = 'mobile';
        isStale = false;
      } else if (state.activeSource === 'gps' && state.gps && state.gps.timestamp > now - 20000) {
        location = state.gps;
        source = 'gps';
        isStale = false;
      } else if (state.activeSource === 'external_gps' && state.external_gps && state.external_gps.timestamp > now - 30000) {
        location = state.external_gps;
        source = 'external_gps';
        isStale = false;
      }
    }

    // Fallback to GPS cache using actual bus_no and reg_no
    if (!location) {
      const cachedLocation = await gpsService.getLocationByRegNo(actualBusNo) || await gpsService.getLocationByRegNo(bus.reg_no);
      if (cachedLocation) {
        location = {
          latitude: cachedLocation.latitude,
          longitude: cachedLocation.longitude,
          speed: cachedLocation.speed,
          status: cachedLocation.status
        };
        source = 'cache';
        isStale = cachedLocation.isStale;
      }
    }

    // Fallback to persisted bus state location if no live or cache location is available
    if (!location && busState.last_latitude != null && busState.last_longitude != null) {
      location = {
        latitude: parseFloat(busState.last_latitude),
        longitude: parseFloat(busState.last_longitude),
        speed: 0,
        status: 'stale'
      };
      source = 'db';
      isStale = true;
    }

    if (location) {
      res.json({
        success: true,
        busNo,
        latitude: location.latitude,
        longitude: location.longitude,
        speed: location.speed,
        status: location.status,
        source,
        updatedAt: new Date().toISOString(),
        isStale,
        busState: busState.state,
        lastLatitude: busState.last_latitude,
        lastLongitude: busState.last_longitude,
        lastCoordsTime: busState.last_coords_time
      });
    } else {
      res.status(404).json({
        success: false,
        busNo,
        latitude: null,
        longitude: null,
        speed: null,
        status: 'offline',
        source: 'none',
        updatedAt: new Date().toISOString(),
        isStale: false,
        busState: busState.state,
        lastLatitude: busState.last_latitude,
        lastLongitude: busState.last_longitude,
        lastCoordsTime: busState.last_coords_time
      });
    }
  } catch (error) {
    console.error('getLiveLocation error:', error);
    res.status(500).json({
      success: false,
      busNo: req.params.busNo,
      latitude: null,
      longitude: null,
      speed: null,
      status: 'error',
      source: 'error',
      updatedAt: new Date().toISOString(),
      isStale: false,
      message: error.message
    });
  }
}

// ================= TRACK BY PREVIEW =================
async function trackByPreview(req, res) {
  try {
    const { previewNumber } = req.params;

    // Find bus by preview_number
    const [busResult] = await pool.execute(
      'SELECT bus_no FROM buses WHERE preview_number = ? AND status = "active"',
      [previewNumber]
    );

    if (busResult.length === 0) {
      return res.status(404).json({ error: 'No bus found for preview number' });
    }

    const busNo = busResult[0].bus_no;
    const busState = await busStateService.getBusState(busNo);
    const state = trackingService.busTrackingState[busNo];
    const now = Date.now();

    let location = null;
    if (state) {
      if (state.activeSource === 'mobile' && state.mobile && state.mobile.timestamp > now - 10000) {
        location = { ...state.mobile, source: 'mobile' };
      } else if (state.activeSource === 'gps' && state.gps && state.gps.timestamp > now - 20000) {
        location = { ...state.gps, source: 'gps' };
      } else if (state.activeSource === 'external_gps' && state.external_gps && state.external_gps.timestamp > now - 30000) {
        location = { ...state.external_gps, source: 'external_gps' };
      }
    }

    // Fallback GPS API cache
    if (!location) {
      location = await gpsService.getLocationByRegNo(busNo);
    }

    const gpsData = await gpsService.getLocationByRegNo(busNo);

    if (!location && busState.last_latitude != null && busState.last_longitude != null) {
      location = {
        latitude: parseFloat(busState.last_latitude),
        longitude: parseFloat(busState.last_longitude),
        speed: 0,
        status: 'stale',
        source: 'db'
      };
    }

    res.json({
      previewNumber,
      busNo,
      latitude: location?.latitude || null,
      longitude: location?.longitude || null,
      speed: location?.speed || 0,
      status: location ? (gpsData?.isOnline !== false ? location.status : 'stale') : 'offline',
      source: location?.source || 'none',
      timestamp: new Date().toISOString(),
      busState: busState.state,
      lastLatitude: busState.last_latitude,
      lastLongitude: busState.last_longitude,
      lastCoordsTime: busState.last_coords_time
    });
  } catch (error) {
    console.error('trackByPreview error:', error);
    res.status(500).json({ error: 'Server error' });
  }
}

// ================= GET ALL LIVE BUSES (GPS + DB) =================
async function getAllLiveBuses(req, res) {
  try {
    const gpsLocations = gpsService.getAllCachedLocations();
    const [dbBuses] = await pool.execute(`
      SELECT bus_no, preview_number, status, current_plan, mobile_live
      FROM buses WHERE status = 'active'
    `);

    const dbMap = new Map(dbBuses.map(b => [b.bus_no.toUpperCase(), b]));
    
    const liveBuses = gpsLocations.map(gps => {
      const dbBus = dbMap.get(gps.busNo);
      return {
        ...gps,
        previewNumber: dbBus?.preview_number || null,
        currentPlan: dbBus?.current_plan || null,
        mobileLive: dbBus?.mobile_live || false,
        hasPreview: !!dbBus?.preview_number
      };
    });

    res.json({
      buses: liveBuses,
      count: liveBuses.length,
      withPreview: liveBuses.filter(b => b.previewNumber).length
    });
  } catch (error) {
    console.error('getAllLiveBuses error:', error);
    res.status(500).json({ error: error.message });
  }
}

// ================= EXISTING STUBS =================
const changeBusPlan = async (req, res) => res.json({ message: 'Not implemented' });
const getCurrentPlan = async (req, res) => res.json({});
async function getRouteStops(req, res) {
  try {
    const { busNo, planName } = req.params;

    const routes = await ExcelBusService.getBusRoutes(busNo);
    
    const stops = routes[planName];
    if (!stops || stops.length === 0) {
      return res.status(404).json({ error: `No stops found for plan '${planName}' on bus ${busNo}` });
    }
    
    res.json({ 
      plan: planName, 
      stops,
      totalStops: stops.length 
    });
  } catch (error) {
    console.error('getRouteStops error:', error);
    res.status(500).json({ error: error.message });
  }
}
const getBusStatistics = async (req, res) => res.json({});
const combineBuses = async (req, res) => res.json({});
const uncombineBuses = async (req, res) => res.json({});

// ================= SAVE PUSH TOKEN (new endpoint per task) =================
async function savePushToken(req, res) {
  try {
    const { token, busNo } = req.body;
    const userId = req.user.id;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    // Use provided busNo or fallback to user's current bus_no
    const effectiveBusNo = busNo || req.user.bus_no;
    const result = await NotificationService.registerToken(userId, token, effectiveBusNo);
    console.log(`[API] save-push-token: user=${userId}, bus=${effectiveBusNo}`);
    res.json({ success: true, message: 'Push token saved', result });
  } catch (err) {
    console.error('Save push token error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ================= REGISTER DEVICE TOKEN (legacy, kept for compatibility) =================
async function registerDeviceToken(req, res) {
  try {
    const { token, busNo } = req.body;
    const userId = req.user.id;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const effectiveBusNo = busNo || req.user.bus_no;
    const result = await NotificationService.registerToken(userId, token, effectiveBusNo);
    console.log(`[API] register-device-token: user=${userId}, bus=${effectiveBusNo}`);
    res.json({ success: true, message: 'Device token registered', result });
  } catch (err) {
    console.error('Register device token error:', err);
    res.status(500).json({ error: err.message });
  }
}

// CREATE BUS - Scalable model
async function createBus(req, res) {
  console.log('Raw body length:', req.body ? req.body.length : 0);
  console.log('Raw body preview:', req.body ? req.body.toString().substring(0, 200) : 'no body');

  const rawBody = req.rawBody || req.body;
  const bodyString = Buffer.isBuffer(rawBody) ? rawBody.toString() : rawBody;

  try {
    const bodyObj = JSON.parse(bodyString);

    const { busNo, previewNumber, deviceId } = bodyObj;
    console.log('Parsed params:', { busNo, previewNumber, deviceId });
    console.log('Trimmed:', { busNo: busNo?.trim(), deviceId: deviceId?.trim() });

    if (!busNo?.trim() || !deviceId?.trim()) {
      return res.status(400).json({ error: 'busNo and deviceId required' });
    }


    const cleanBusNo = busNo.trim().toUpperCase();
    const cleanPreviewNumber = previewNumber?.trim();
    const cleanDeviceId = deviceId.trim();

    // Validation: Check uniqueness of bus number
    const [busExists] = await pool.execute('SELECT id FROM buses WHERE bus_no = ?', [cleanBusNo]);
    if (busExists.length > 0) {
      return res.status(400).json({ error: 'Bus number already exists. Please use a different bus number.' });
    }

    // Validation: Check uniqueness of device ID
    const [deviceExists] = await pool.execute('SELECT id FROM buses WHERE gps_device_id = ?', [cleanDeviceId]);
    if (deviceExists.length > 0) {
      return res.status(400).json({ error: 'Device ID already exists. Please use a different device ID.' });
    }

    // Validation: Check uniqueness of preview number (if provided)
    if (cleanPreviewNumber) {
      const [previewExists] = await pool.execute('SELECT id FROM buses WHERE preview_number = ?', [cleanPreviewNumber]);
      if (previewExists.length > 0) {
        return res.status(400).json({ error: 'Preview number already exists. Please use a different preview number.' });
      }
    }

    // Create
    const [result] = await pool.execute(`
      INSERT INTO buses (bus_no, bus_name, gps_device_id, reg_no, preview_number, status, current_plan)
      VALUES (?, ?, ?, ?, ?, 'active', 'Plan A')`, [cleanBusNo, cleanPreviewNumber || `Bus ${cleanBusNo}`, cleanDeviceId, cleanBusNo, cleanPreviewNumber]);

    res.status(201).json({ message: 'Bus created', busNo: cleanBusNo, id: result.insertId });
  } catch (err) {
    console.error('CreateBus error:', err);
    res.status(500).json({ error: err.message });
  }
}

// Normalize device ID - strip non-digits for matching
const normalizeDeviceId = (val) => String(val || '').replace(/[^0-9]/g, '');

// GET BUS LOCATION - Secure GPS proxy (uses cache only)
async function getBusLocation(req, res) {
  try {
    const { busNo } = req.params;
    console.log('🔍 getBusLocation for:', busNo);

    // Multi-field search DB
    const [busRows] = await pool.execute(
      `SELECT bus_no, preview_number, reg_no, bus_name, gps_device_id, status 
       FROM buses WHERE bus_no = ? OR preview_number = ? OR reg_no = ?`,
      [busNo, busNo, busNo]
    );

    if (busRows.length === 0) {
      return res.status(404).json({
        success: false,
        busNo,
        latitude: null,
        longitude: null,
        speed: null,
        status: 'not_found',
        source: 'none',
        updatedAt: new Date().toISOString(),
        isStale: false,
        message: 'Bus not found in database'
      });
    }

    const bus = busRows[0];
    const busState = await busStateService.getBusState(bus.bus_no);

    // 1. PRIORITY 1: Tracking state (fastest, real-time)
    const trackingState = trackingService.busTrackingState[bus.bus_no];
    const now = Date.now();
    let location = null;
    let source = 'none';
    let isStale = false;

    if (trackingState) {
      if (trackingState.activeSource === 'mobile' && trackingState.mobile?.timestamp > now - 10000) {
        location = trackingState.mobile;
        source = 'mobile';
        isStale = false;
      } else if (trackingState.activeSource === 'gps' && trackingState.gps?.timestamp > now - 20000) {
        location = trackingState.gps;
        source = 'gps';
        isStale = false;
      } else if (trackingState.activeSource === 'external_gps' && trackingState.external_gps?.timestamp > now - 30000) {
        location = trackingState.external_gps;
        source = 'external_gps';
        isStale = false;
      }
    }

    // 2. PRIORITY 2: GPS Cache (fallback)
    if (!location) {
      const cachedLocation = await gpsService.getLocationByRegNo(bus.bus_no) || await gpsService.getLocationByRegNo(bus.reg_no);
      if (cachedLocation) {
        location = {
          latitude: cachedLocation.latitude,
          longitude: cachedLocation.longitude,
          speed: cachedLocation.speed,
          status: cachedLocation.status
        };
        source = 'cache';
        isStale = cachedLocation.isStale;
      }
    }

    // 3. PRIORITY 3: Persisted DB state location fallback
    if (!location && busState.last_latitude != null && busState.last_longitude != null) {
      location = {
        latitude: parseFloat(busState.last_latitude),
        longitude: parseFloat(busState.last_longitude),
        speed: 0,
        status: 'stale'
      };
      source = 'db';
      isStale = true;
    }

    // VALIDATE COORDINATES
    if (location && (Math.abs(location.latitude) > 90 || Math.abs(location.longitude) > 180)) {
      console.log('❌ Invalid coordinates for', busNo);
      location = null;
      source = 'invalid_coords';
      isStale = false;
    }

    // Fetch current plan
    const [planRows] = await pool.execute(
      'SELECT current_plan FROM buses WHERE bus_no = ?',
      [bus.bus_no]
    );
    
    const currentPlan = planRows.length > 0 ? planRows[0].current_plan : null;

    const response = {
      success: !!location,
      busNo: bus.bus_no,
      latitude: location?.latitude || null,
      longitude: location?.longitude || null,
      speed: location?.speed || null,
      status: location?.status || 'offline',
      source,
      updatedAt: new Date().toISOString(),
      isStale,
      busState: busState.state,
      lastLatitude: busState.last_latitude,
      lastLongitude: busState.last_longitude,
      lastCoordsTime: busState.last_coords_time,
      currentPlan
    };

    console.log(`📍 ${busNo}: ${response.success ? '✅' : '❌'} ${source} ${isStale ? '(stale)' : ''}`);
    res.json(response);

  } catch (err) {
    console.error('getBusLocation ERROR:', err);
    res.status(500).json({
      success: false,
      busNo: req.params.busNo,
      latitude: null,
      longitude: null,
      speed: null,
      status: 'error',
      source: 'error',
      updatedAt: new Date().toISOString(),
      isStale: false,
      message: err.message
    });
  }
}

// EXPORT
module.exports = {
  uploadBusRoutes,
  updateBusNumber,
  getAllBuses,
  getAllLiveBuses,
  deleteBus,
  activateBus,
  validatePreviewNumber,
  updatePreviewNumber,
  updatePlan,
  getPlans,
  changeBusPlan,
  getCurrentPlan,
  getLiveLocation,
  getRouteStops,
  getBusStatistics,
  combineBuses,
  uncombineBuses,
  savePushToken,
  registerDeviceToken,
  trackByPreview,
  createBus,
  getBusLocation
};

