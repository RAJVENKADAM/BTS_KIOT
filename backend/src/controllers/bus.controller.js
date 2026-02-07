const ExcelBusService = require('../services/excelBusService');
const NotificationService = require('../services/notificationService');
const { pool } = require('../config/db');
const { getIO } = require('../socket'); // Get the shared Socket.IO instance

async function uploadBusRoutes(req, res) {
  try {
    // Check if file was uploaded
    if (!req.file) {
      return res.status(400).json({
        error: 'No file uploaded'
      });
    }

    const filePath = req.file.path;
    
    // Get bus number from form data (user input from modal)
    const busNo = req.body.busNo;
    
    if (!busNo) {
      return res.status(400).json({
        error: 'Bus number is required'
      });
    }

    // Process the Excel file
    const routesData = await ExcelBusService.processExcelFile(filePath);
    
    // Combine the user-provided bus number with the route data from Excel
    const busData = {
      busNo: busNo,
      routes: routesData.routes  // Use routes from Excel file
    };

    // Save bus with routes
    const result = await ExcelBusService.saveBusWithRoutes(busData, req.user.id);

    // Return success response
    res.status(200).json({
      message: result.busExists ? 'Bus routes updated successfully' : 'Bus created with routes successfully',
      busNo: result.busNo,
      routesCount: result.routesCount,
      stopsCount: result.stopsCount,
      busExists: result.busExists
    });
  } catch (error) {
    console.error('Error in uploadBusRoutes:', error);
    res.status(500).json({
      error: error.message
    });
  }
}

async function deleteBus(req, res) {
  try {
    const { busNo } = req.params;

    if (!busNo) {
      return res.status(400).json({
        error: 'Bus number is required'
      });
    }

    // Deactivate the bus (set status to inactive)
    const result = await ExcelBusService.deleteBus(busNo);

    // Notify users associated with this bus
    try {
      await NotificationService.notifyBusUpdate({
        actorId: req.user?.id || null,
        actionType: 'DEACTIVATE',
        busNumbers: [busNo],
        title: `Bus ${busNo} deactivated`
      });
    } catch (notifyErr) {
      console.error('Notification error (deactivate):', notifyErr.message);
    }

    res.status(200).json({
      message: 'Bus deactivated successfully',
      busNo: result.busNo,
      deactivated: true
    });
  } catch (error) {
    console.error('Error in deleteBus:', error);
    res.status(500).json({
      error: error.message
    });
  }
}

async function activateBus(req, res) {
  try {
    const { busNo } = req.params;

    if (!busNo) {
      return res.status(400).json({
        error: 'Bus number is required'
      });
    }

    // Activate the bus
    const result = await ExcelBusService.activateBus(busNo);

    // Notify users associated with this bus
    try {
      await NotificationService.notifyBusUpdate({
        actorId: req.user?.id || null,
        actionType: 'ACTIVATE',
        busNumbers: [busNo],
        title: `Bus ${busNo} activated`
      });
    } catch (notifyErr) {
      console.error('Notification error (activate):', notifyErr.message);
    }

    res.status(200).json({
      message: 'Bus activated successfully',
      busNo: result.busNo
    });
  } catch (error) {
    console.error('Error in activateBus:', error);
    res.status(500).json({
      error: error.message
    });
  }
}

// Register device token for push notifications for the authenticated user
async function registerDeviceToken(req, res) {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Device token is required' });

    await NotificationService.registerToken(req.user.id, token);

    res.status(200).json({ message: 'Device token registered' });
  } catch (error) {
    console.error('Error registering device token:', error);
    res.status(500).json({ error: error.message });
  }
}

async function changeBusPlan(req, res) {
  try {
    const { busNo } = req.params;
    const { newPlan } = req.body;
    const userId = req.user.id;

    if (!busNo || !newPlan) {
      return res.status(400).json({
        error: 'Bus number and new plan are required'
      });
    }

    // Change the bus plan and create auto message
    const result = await ExcelBusService.changeBusPlan(busNo, newPlan, userId);

    // Notify users of the plan change
    try {
      await NotificationService.notifyBusUpdate({
        actorId: userId,
        actionType: 'PLAN_CHANGE',
        busNumbers: [busNo],
        title: `Bus ${busNo} plan changed to ${newPlan}`,
        body: `Bus ${busNo} is now operating on plan ${newPlan}`
      });
    } catch (notifyErr) {
      console.error('Notification error (plan change):', notifyErr.message);
    }

    res.status(200).json({
      message: 'Bus plan changed successfully',
      busNo: result.busNo,
      newPlan: result.newPlan,
      autoMessage: result.autoMessage
    });
  } catch (error) {
    console.error('Error in changeBusPlan:', error);
    res.status(500).json({
      error: error.message
    });
  }
}

async function getCurrentPlan(req, res) {
  try {
    const { busNo } = req.params;

    if (!busNo) {
      return res.status(400).json({
        error: 'Bus number is required'
      });
    }

    // Check if bus exists and get its status and operating_bus_id
    const [busResult] = await pool.execute(
      'SELECT id, status, operating_bus_id, bus_number FROM buses WHERE bus_number = ? LIMIT 1',
      [busNo]
    );

    if (busResult.length === 0) {
      return res.status(404).json({
        error: 'Bus not found'
      });
    }

    // Check if bus is inactive
    if (busResult[0].status === 'inactive') {
      return res.status(400).json({
        error: 'Bus is inactive'
      });
    }

    let currentPlan = null;
    let isCombined = false;
    let operatingBus = null;

    // If this bus is combined, get the plan from the operating bus
    if (busResult[0].operating_bus_id) {
      const [operatingBusResult] = await pool.execute(
        'SELECT current_plan, bus_number FROM buses WHERE id = ? LIMIT 1',
        [busResult[0].operating_bus_id]
      );
      if (operatingBusResult.length > 0) {
        currentPlan = operatingBusResult[0].current_plan;
        isCombined = true;
        operatingBus = operatingBusResult[0].bus_number;
      }
    } else {
      // Get current plan for the bus
      const result = await ExcelBusService.getCurrentPlan(busNo);
      currentPlan = result.currentPlan;
    }

    res.status(200).json({
      busNo: busNo,
      currentPlan: currentPlan,
      isCombined: isCombined,
      operatingBus: operatingBus
    });
  } catch (error) {
    console.error('Error in getCurrentPlan:', error);
    res.status(500).json({
      error: error.message
    });
  }
}

// Get live location for a specific bus
async function getLiveLocation(req, res) {
  try {
    const { busNo } = req.params;
    const userId = req.user.id;

    // Check if user has permission to view this bus location
    const [userResult] = await pool.execute(
      'SELECT id, role, bus_no FROM users WHERE id = ?',
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

// Get route stops for a specific bus and plan
async function getRouteStops(req, res) {
  try {
    const { busNo, planName } = req.params;
    const userId = req.user.id;

    // Check if user has permission to view this bus route
    const [userResult] = await pool.execute(
      'SELECT id, role, bus_no FROM users WHERE id = ?',
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
      return res.status(403).json({ error: 'Insufficient permissions to view this bus route' });
    }

    // Get route stops for the specified plan
    // First, find the bus_id from buses table using bus_number
    const [busResult] = await pool.execute(
      'SELECT id, status FROM buses WHERE bus_number = ? LIMIT 1',
      [busNo]
    );

    if (busResult.length === 0) {
      return res.status(404).json({ error: 'Bus not found' });
    }

    if (busResult[0].status === 'inactive') {
      return res.status(400).json({ error: 'Bus is inactive' });
    }

    const busId = busResult[0].id;
    
    const [stopsResult] = await pool.execute(`
      SELECT id, bus_id, plan_name, stop_name, stop_order
      FROM bus_routes
      WHERE bus_id = ? AND plan_name = ?
      ORDER BY stop_order ASC
    `, [busId, planName]);

    if (stopsResult.length === 0) {
      return res.status(404).json({ error: 'No route stops found for this bus and plan' });
    }

    res.status(200).json({
      busNo: busNo,
      planName: planName,
      route: stopsResult.map(stop => ({
        id: stop.id,
        stopName: stop.stop_name,
        order: stop.stop_order
      }))
    });
  } catch (error) {
    console.error('Error getting route stops:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function getAllBuses(req, res) {
  try {
    // Get all buses from buses table, including those without routes
    const [busesResult] = await pool.execute(`
      SELECT 
        b.bus_number as bus_no,
        u.name as driver_name,
        b.id as bus_id,
        b.status,
        b.operating_bus_id,
        b.combined_buses,
        b.current_plan,
        ob.bus_number as operating_bus_number
      FROM buses b
      LEFT JOIN buses ob ON b.operating_bus_id = ob.id
      LEFT JOIN users u ON b.bus_number = u.bus_no
      ORDER BY b.bus_number
    `);

    // For each bus, get routes, plans
    const busesWithDetails = await Promise.all(busesResult.map(async (bus) => {
      let routes = {};
      let totalStops = 0;
      let totalPlans = 0;
      let currentPlan = bus.current_plan; // Use the current_plan from the buses table

      // If this bus is combined, get routes from operating bus
      if (bus.operating_bus_id) {
        // Get routes from operating bus
        const [operatingRoutesResult] = await pool.execute(
          'SELECT plan_name, stop_name, stop_order FROM bus_routes WHERE bus_id = ? ORDER BY plan_name, stop_order',
          [bus.operating_bus_id]
        );

        // Group routes by plan
        operatingRoutesResult.forEach(route => {
          if (!routes[route.plan_name]) {
            routes[route.plan_name] = [];
          }
          routes[route.plan_name].push(route.stop_name);
        });

        totalStops = operatingRoutesResult.length;
        totalPlans = Object.keys(routes).length;
      } else {
        // Get routes for this bus
        const [routesResult] = await pool.execute(
          'SELECT plan_name, stop_name, stop_order FROM bus_routes WHERE bus_id = ? ORDER BY plan_name, stop_order',
          [bus.bus_id]
        );

        // Group routes by plan
        routesResult.forEach(route => {
          if (!routes[route.plan_name]) {
            routes[route.plan_name] = [];
          }
          routes[route.plan_name].push(route.stop_name);
        });

        totalStops = routesResult.length;
        totalPlans = Object.keys(routes).length;
      }

      return {
        busNo: bus.bus_no,
        driverName: bus.driver_name,
        routes: routes, // Structure expected by BusCard
        routesCount: totalPlans,
        stopsCount: totalStops,
        currentPlan: currentPlan,
        status: bus.status || 'active',
        isCombined: bus.operating_bus_id ? true : false,
        operatingBus: bus.operating_bus_number || null,
        combinedBuses: (() => {
          try {
            return bus.combined_buses ? JSON.parse(bus.combined_buses) : null;
          } catch (error) {
            console.warn(`Invalid JSON in combined_buses for bus ${bus.bus_no}:`, bus.combined_buses);
            return null;
          }
        })()
      };
    }));

    res.status(200).json({
      buses: busesWithDetails,
      count: busesWithDetails.length
    });
  } catch (error) {
    console.error('Error in getAllBuses:', error);
    res.status(500).json({
      error: error.message
    });
  }
}

async function updateBusNumber(req, res) {
  try {
    const { busNo } = req.params;
    const { newBusNo } = req.body;

    if (!busNo || !newBusNo) {
      return res.status(400).json({
        error: 'Current bus number and new bus number are required'
      });
    }

    // Check if new bus number already exists
    const [existingBus] = await pool.execute(
      'SELECT id FROM buses WHERE bus_number = ? LIMIT 1',
      [newBusNo]
    );

    if (existingBus.length > 0) {
      return res.status(400).json({
        error: 'Bus number already exists'
      });
    }

    // Update bus number in buses table
    const [updateResult] = await pool.execute(
      'UPDATE buses SET bus_number = ? WHERE bus_number = ?',
      [newBusNo, busNo]
    );

    if (updateResult.affectedRows === 0) {
      return res.status(404).json({
        error: 'Bus not found'
      });
    }

    // Update bus number in users table if any user is assigned to this bus
    await pool.execute(
      'UPDATE users SET bus_no = ? WHERE bus_no = ?',
      [newBusNo, busNo]
    );

    res.status(200).json({
      message: 'Bus number updated successfully',
      oldBusNo: busNo,
      newBusNo: newBusNo
    });
  } catch (error) {
    console.error('Error in updateBusNumber:', error);
    res.status(500).json({
      error: error.message
    });
  }
}

async function getBusStatistics(req, res) {
  try {
    // Get total number of buses that have routes defined
    // Join bus_routes with buses table to get bus numbers
    const [totalBusesResult] = await pool.execute(`
      SELECT COUNT(DISTINCT b.bus_number) as total_buses
      FROM bus_routes br
      INNER JOIN buses b ON br.bus_id = b.id
    `);

    // Since bus_live_locations table doesn't exist, we'll calculate active buses differently
    // For now, we'll consider all buses with routes as potentially active
    // In a real implementation, you'd have a live locations table
    const activeBuses = totalBusesResult[0].total_buses || 0;

    // Get offline buses (buses that have routes but are not in the buses table)
    // This is a simplified approach since we don't have live location data
    const offlineBuses = 0; // All buses with routes are considered "online" for now

    // Get buses on route (buses that are currently assigned to a plan)
    // Join with buses table to get current_plan information
    const [onRouteResult] = await pool.execute(`
      SELECT COUNT(DISTINCT b.bus_number) as on_route_buses
      FROM buses b
      INNER JOIN bus_routes br ON b.id = br.bus_id
      WHERE b.current_plan IS NOT NULL
    `);

    res.status(200).json({
      totalBuses: totalBusesResult[0].total_buses || 0,
      activeBuses: activeBuses,
      onRouteBuses: onRouteResult[0].on_route_buses || 0,
      offlineBuses: offlineBuses
    });
  } catch (error) {
    console.error('Error in getBusStatistics:', error);
    res.status(500).json({
      error: error.message
    });
  }
}

async function combineBuses(req, res) {
  try {
    const { operatingBus, combinedBuses } = req.body;

    if (!operatingBus || !combinedBuses || !Array.isArray(combinedBuses) || combinedBuses.length === 0) {
      return res.status(400).json({
        error: 'Operating bus and combined buses array are required'
      });
    }

    // Combine the buses
    const result = await ExcelBusService.combineBuses(operatingBus, combinedBuses);

    // Notify affected users (operating + combined)
    try {
      await NotificationService.notifyBusUpdate({
        actorId: req.user?.id || null,
        actionType: 'COMBINE',
        busNumbers: [operatingBus, ...combinedBuses],
        title: `Buses combined under ${operatingBus}`
      });
    } catch (notifyErr) {
      console.error('Notification error (combine):', notifyErr.message);
    }

    res.status(200).json({
      message: result.message,
      operatingBus: result.operatingBus,
      combinedBuses: result.combinedBuses
    });
  } catch (error) {
    console.error('Error in combineBuses:', error);
    res.status(500).json({
      error: error.message
    });
  }
}

async function uncombineBuses(req, res) {
  try {
    const { operatingBus } = req.params;

    if (!operatingBus) {
      return res.status(400).json({
        error: 'Operating bus is required'
      });
    }

    // Uncombine the buses
    const result = await ExcelBusService.uncombineBuses(operatingBus);

    // Notify affected users (operating + previously combined)
    try {
      await NotificationService.notifyBusUpdate({
        actorId: req.user?.id || null,
        actionType: 'UNCOMBINE',
        busNumbers: [operatingBus, ...(result.uncombinedBuses || [])],
        title: `Buses uncombined from ${operatingBus}`
      });
    } catch (notifyErr) {
      console.error('Notification error (uncombine):', notifyErr.message);
    }

    res.status(200).json({
      message: result.message,
      operatingBus: result.operatingBus,
      uncombinedBuses: result.uncombinedBuses
    });
  } catch (error) {
    console.error('Error in uncombineBuses:', error);
    res.status(500).json({
      error: error.message
    });
  }
}

module.exports = {
  uploadBusRoutes,
  deleteBus,
  activateBus,
  changeBusPlan,
  getCurrentPlan,
  getLiveLocation,
  getRouteStops,
  getAllBuses,
  updateBusNumber,
  getBusStatistics,
  combineBuses,
  uncombineBuses,
  registerDeviceToken
};
