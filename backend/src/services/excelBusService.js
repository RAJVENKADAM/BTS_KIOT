const xlsx = require('xlsx');
const { pool } = require('../config/db');

class ExcelBusService {
  async processExcelFile(filePath) {
    try {
      const workbook = xlsx.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = xlsx.utils.sheet_to_json(worksheet, { header: 1 }); // Get raw data as arrays

      // Get column headers (first row)
      const headers = jsonData[0];

      // Validate that we have at least one plan column (Plan A, Plan B, etc.)
      const planHeaders = headers.filter(header =>
        typeof header === 'string' && header.trim().startsWith('Plan ')
      );

      if (planHeaders.length === 0) {
        throw new Error('Excel file must contain at least one Plan column (e.g., Plan A, Plan B)');
      }

      // Process rows starting from index 1 (skip headers)
      const stopsData = [];
      for (let i = 1; i < jsonData.length; i++) {
        const row = jsonData[i];
        if (row && row.length > 0) {
          const rowData = {};
          for (let j = 0; j < headers.length; j++) {
            const header = headers[j];
            if (typeof header === 'string') {
              rowData[header] = row[j] ? row[j].toString().trim() : '';
            }
          }
          stopsData.push(rowData);
        }
      }

      // Convert stops data to routes format
      const routes = {};
      planHeaders.forEach(planHeader => {
        routes[planHeader] = stopsData
          .map(stopRow => stopRow[planHeader])
          .filter(stop => stop && stop.trim() !== ''); // Filter out empty stops
      });

      // Return only routes data, bus number is provided separately by the caller
      return {
        routes
      };
    } catch (error) {
      throw new Error(`Error processing Excel file: ${error.message}`);
    }
  }

  async saveBusWithRoutes(busData, uploadedByUserId) {
    try {
      const { busNo, previewNumber, routes, gpsId } = busData;

      // Validate TN bus number format (e.g., TN30AH5907, TN37BY1234)
      const tnRegex = /^TN[A-Z0-9]+$/i;
      if (!tnRegex.test(busNo)) {
        throw new Error('Bus number must start with TN followed by alphanumeric characters (e.g., TN30AH5907, TN37BY1234)');
      }

      // Validation: Check uniqueness of bus number (only if creating new bus)
      let [busResult] = await pool.execute(
        'SELECT id FROM buses WHERE bus_no = ? LIMIT 1',
        [busNo]
      );

      let busExists = busResult.length > 0;
      let busId;

      if (!busExists) {
        // INSERT new bus
        const [insertResult] = await pool.execute(
          `INSERT INTO buses (bus_no, preview_number, gps_device_id, status, current_plan) 
           VALUES (?, ?, ?, 'active', 'PLAN A')`,
          [busNo, previewNumber || null, gpsId || null]
        );
        busId = insertResult.insertId;
        busExists = false; // for return value
      } else {
        // Existing bus - extract ID and UPDATE fields
        busId = busResult[0].id;
        await pool.execute(
          `UPDATE buses SET 
           preview_number = ?, gps_device_id = ?, status = 'active'
           WHERE id = ?`,
          [previewNumber || null, gpsId || null, busId]
        );
      }

      // Get current plan after ensuring bus exists
      const [currentPlanResult] = await pool.execute(
        'SELECT current_plan FROM buses WHERE id = ?',
        [busId]
      );
        const hasPlan = currentPlanResult[0]?.current_plan && currentPlanResult[0].current_plan !== null;

        if (!hasPlan) {
          await pool.execute(
            'UPDATE buses SET current_plan = ? WHERE id = ?',
            ['PLAN A', busId]
          );
        }

      // Delete existing routes for this bus to prepare for update
      await pool.execute(
        'DELETE FROM bus_routes WHERE bus_id = ?',
        [busId]
      );

      // Insert new routes
      for (const [planName, stops] of Object.entries(routes)) {
        for (let orderIndex = 0; orderIndex < stops.length; orderIndex++) {
          const stopName = stops[orderIndex];

          await pool.execute(
            'INSERT INTO bus_routes (bus_id, plan_name, stop_name, stop_order) VALUES (?, ?, ?, ?)',
            [busId, planName, stopName, orderIndex + 1]
          );
        }
      }

      return {
        busId, // added for debugging
        busNo,
        previewNumber: previewNumber || null,
        routesCount: Object.keys(routes).length,
        stopsCount: Object.values(routes).reduce((sum, stops) => sum + stops.length, 0),
        busExists
      };
    } catch (error) {
      // Check if it's a duplicate entry error for bus_no or preview_number
      if (error.message.includes('ER_DUP_ENTRY') || error.message.includes('UNIQUE constraint failed')) {
        if (error.message.includes('preview_number')) {
          throw new Error(`Preview number already exists. Please use a different preview number.`);
        }
        throw new Error(`Bus number ${busData.busNo} already exists. Please use a different bus number.`);
      }
      throw new Error(`Error saving bus routes: ${error.message}`);
    }
  }

  async validatePreviewNumber(previewNumber) {
    try {
      const [existing] = await pool.execute(
        'SELECT bus_no FROM buses WHERE preview_number = ? LIMIT 1',
        [previewNumber]
      );
      return existing.length === 0;
    } catch (error) {
      throw new Error(`Error validating preview number: ${error.message}`);
    }
  }

  async deleteBus(busNo) {
    try {
      // First, find the bus_id from buses table using bus_no
      const [busResult] = await pool.execute(
        'SELECT id FROM buses WHERE bus_no = ? LIMIT 1',
        [busNo]
      );

      if (busResult.length === 0) {
        throw new Error(`Bus ${busNo} not found`);
      }

      const busId = busResult[0].id;

      // Set bus to inactive instead of deleting
      await pool.execute(
        'UPDATE buses SET status = ? WHERE id = ?',
        ['inactive', busId]
      );

      return {
        busNo,
        message: 'Bus set to inactive'
      };
    } catch (error) {
      throw new Error(`Error deactivating bus: ${error.message}`);
    }
  }

  async activateBus(busNo) {
    try {
      // First, find the bus_id from buses table using bus_no
      const [busResult] = await pool.execute(
        'SELECT id FROM buses WHERE bus_no = ? LIMIT 1',
        [busNo]
      );

      if (busResult.length === 0) {
        throw new Error(`Bus ${busNo} not found`);
      }

      const busId = busResult[0].id;

      // Set bus to active
      await pool.execute(
        'UPDATE buses SET status = ? WHERE id = ?',
        ['active', busId]
      );

      return {
        busNo,
        message: 'Bus activated successfully'
      };
    } catch (error) {
      throw new Error(`Error activating bus: ${error.message}`);
    }
  }

  async changeBusPlan(busNo, newPlan, userId) {
    try {
      // First, find the bus_id from buses table using bus_no
      const [busResult] = await pool.execute(
        'SELECT id FROM buses WHERE bus_no = ? LIMIT 1',
        [busNo]
      );

      if (busResult.length === 0) {
        throw new Error(`Bus ${busNo} not found`);
      }

      const busId = busResult[0].id;

      // First, check if the plan exists for this bus
      const [routes] = await pool.execute(
        'SELECT DISTINCT plan_name FROM bus_routes WHERE bus_id = ?',
        [busId]
      );

      const availablePlans = routes.map(route => route.plan_name);
      if (!availablePlans.includes(newPlan)) {
        throw new Error(`Plan '${newPlan}' does not exist for bus ${busNo}. Available plans: ${availablePlans.join(', ')}`);
      }

      // Update the current plan in the buses table
      const [result] = await pool.execute(
        'UPDATE buses SET current_plan = ? WHERE id = ?',
        [newPlan, busId]
      );

      // Create an auto message about the plan change
      const [messageResult] = await pool.execute(
        'INSERT INTO messages (sender_id, recipient_role, bus_no, message, message_type, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
        [userId, 'ALL', busNo, `Bus ${busNo} has changed to plan: ${newPlan}`, 'AUTO_PLAN_CHANGE']
      );

      // Get the created message
      const [createdMessage] = await pool.execute(
        'SELECT * FROM messages WHERE id = ?',
        [messageResult.insertId]
      );

      return {
        busNo,
        newPlan,
        autoMessage: createdMessage[0] || null
      };
    } catch (error) {
      throw new Error(`Error changing bus plan: ${error.message}`);
    }
  }

  async getCurrentPlan(busNo) {
    try {
      // First, find the bus_id from buses table using bus_no
      const [busResult] = await pool.execute(
        'SELECT id, current_plan FROM buses WHERE bus_no = ? LIMIT 1',
        [busNo]
      );

      if (busResult.length === 0) {
        return { busNo, currentPlan: null };
      }

      return {
        busNo,
        currentPlan: busResult[0].current_plan
      };
    } catch (error) {
      throw new Error(`Error getting current plan: ${error.message}`);
    }
  }

  async getBusRoutes(busNo) {
    try {
      // First, find the bus_id from buses table using bus_no
      const [busResult] = await pool.execute(
        'SELECT id FROM buses WHERE bus_no = ? LIMIT 1',
        [busNo]
      );

      if (busResult.length === 0) {
        return {};
      }

      const busId = busResult[0].id;

      const [routes] = await pool.execute(
        'SELECT plan_name, stop_name, stop_order FROM bus_routes WHERE bus_id = ? ORDER BY plan_name, stop_order',
        [busId]
      );

      const groupedRoutes = {};
      routes.forEach(route => {
        if (!groupedRoutes[route.plan_name]) {
          groupedRoutes[route.plan_name] = [];
        }
        groupedRoutes[route.plan_name].push(route.stop_name);
      });

      return groupedRoutes;
    } catch (error) {
      throw new Error(`Error fetching bus routes: ${error.message}`);
    }
  }

  async combineBuses(operatingBus, combinedBuses) {
    try {
      // Validate that operating bus exists
      const [operatingBusResult] = await pool.execute(
        'SELECT id FROM buses WHERE bus_no = ? LIMIT 1',
        [operatingBus]
      );

      if (operatingBusResult.length === 0) {
        throw new Error(`Operating bus ${operatingBus} not found`);
      }

      const operatingBusId = operatingBusResult[0].id;

      // Validate that all combined buses exist
      for (const busNo of combinedBuses) {
        const [busResult] = await pool.execute(
          'SELECT id FROM buses WHERE bus_no = ? LIMIT 1',
          [busNo]
        );

        if (busResult.length === 0) {
          throw new Error(`Bus ${busNo} not found`);
        }
      }

      // Update all combined buses to point to the operating bus
      for (const busNo of combinedBuses) {
        await pool.execute(
          'UPDATE buses SET operating_bus_id = ? WHERE bus_no = ?',
          [operatingBusId, busNo]
        );
      }

      // Store the combined buses as JSON in the operating bus record
      const combinedBusesJSON = JSON.stringify(combinedBuses);
      await pool.execute(
        'UPDATE buses SET combined_buses = ? WHERE id = ?',
        [combinedBusesJSON, operatingBusId]
      );

      // Update the status of combined buses to reflect they are part of a combination
      for (const busNo of combinedBuses) {
        await pool.execute(
          'UPDATE buses SET status = ? WHERE bus_no = ?',
          ['combined', busNo]
        );
      }

      return {
        message: `Successfully combined buses ${combinedBuses.join(', ')} under operating bus ${operatingBus}`,
        operatingBus: operatingBus,
        combinedBuses: combinedBuses
      };
    } catch (error) {
      throw new Error(`Error combining buses: ${error.message}`);
    }
  }

  async uncombineBuses(operatingBus) {
    try {
      // Validate that operating bus exists
      const [operatingBusResult] = await pool.execute(
        'SELECT id, combined_buses FROM buses WHERE bus_no = ? LIMIT 1',
        [operatingBus]
      );

      if (operatingBusResult.length === 0) {
        throw new Error(`Operating bus ${operatingBus} not found`);
      }

      const operatingBusId = operatingBusResult[0].id;

      // Normalize combined_buses value to an array (handles stored JSON string, array/object, or CSV string)
      const rawCombined = operatingBusResult[0].combined_buses;
      const parseCombined = (val) => {
        if (!val) return [];
        if (Array.isArray(val)) return val;
        if (typeof val === 'string') {
          // Try JSON parse first
          try {
            const p = JSON.parse(val);
            if (Array.isArray(p)) return p;
            if (p && typeof p === 'object') return Object.values(p).flat();
          } catch (e) {
            // not JSON, fall back to CSV
            return val.split(',').map(s => s.trim()).filter(Boolean);
          }
        }
        if (val && typeof val === 'object') {
          return Object.values(val).flat();
        }
        return [];
      };

      let combinedBuses = parseCombined(rawCombined || []);

      // Fallback: if operating record did not store combined_buses, derive from child rows
      if (!combinedBuses || combinedBuses.length === 0) {
        const [childRows] = await pool.execute(
          'SELECT bus_no FROM buses WHERE operating_bus_id = ?',
          [operatingBusId]
        );
        const childBusNumbers = childRows.map(r => r.bus_no || r.busNo || r.busNo);
        if (childBusNumbers && childBusNumbers.length > 0) {
          combinedBuses = childBusNumbers;
        }
      }

      if (!combinedBuses || combinedBuses.length === 0) {
        throw new Error(`Bus ${operatingBus} has no combined buses to uncombine`);
      }

      // Reset the operating_bus_id for all combined buses to NULL
      for (const busNo of combinedBuses) {
        await pool.execute(
          'UPDATE buses SET operating_bus_id = NULL, status = ? WHERE bus_no = ?',
          ['active', busNo]
        );
      }

      // Clear the combined_buses JSON in the operating bus record
      await pool.execute(
        'UPDATE buses SET combined_buses = NULL WHERE id = ?',
        [operatingBusId]
      );

      // Reset the operating bus status to active if it was combined
      await pool.execute(
        'UPDATE buses SET status = ? WHERE id = ?',
        ['active', operatingBusId]
      );

      return {
        message: `Successfully uncombined buses from operating bus ${operatingBus}`,
        operatingBus: operatingBus,
        uncombinedBuses: combinedBuses
      };
    } catch (error) {
      throw new Error(`Error uncombining buses: ${error.message}`);
    }
  }
}

module.exports = new ExcelBusService();