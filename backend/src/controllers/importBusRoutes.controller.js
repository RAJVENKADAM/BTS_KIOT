const Bus = require('../models/Bus');
const BusRoute = require('../models/BusRoute');

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function normalizeBusNo(busNo) {
  return (busNo || '').toString().trim().toUpperCase();
}

function normalizePlanName(planName) {
  return (planName || '').toString().trim();
}

function normalizeStopName(stopName) {
  return (stopName || '').toString().trim();
}

function normalizeStopOrder(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildRouteKey(busId, plan_name, stop_order) {
  return `${busId}__${plan_name}__${stop_order}`;
}

async function importBusRoutes(req, res) {
  try {
    const payload = req.body || {};

    const {
      busNo,
      previewNumber = null,
      gpsId = null,
      deviceId = null,
      regNo = null,
      routesByPlan = null,
      // optional: allow flat routes too
      routes = null,
      replaceRoutes = false,
    } = payload;

    if (!isNonEmptyString(busNo)) {
      return res.status(400).json({ success: false, error: 'busNo is required' });
    }

    const normalizedBusNoValue = normalizeBusNo(busNo);

    // Normalize routes into routesByPlan map
    let normalizedRoutesByPlan = {};
    if (routesByPlan && typeof routesByPlan === 'object') {
      normalizedRoutesByPlan = routesByPlan;
    } else if (Array.isArray(routes)) {
      // Expect each route has plan_name
      for (const r of routes) {
        const plan = normalizePlanName(r?.plan_name);
        if (!plan) continue;
        normalizedRoutesByPlan[plan] = normalizedRoutesByPlan[plan] || [];
        normalizedRoutesByPlan[plan].push(r);
      }
    }

    const planNames = Object.keys(normalizedRoutesByPlan);
    const allStops = [];
    for (const plan of planNames) {
      const list = Array.isArray(normalizedRoutesByPlan[plan]) ? normalizedRoutesByPlan[plan] : [];
      for (const stop of list) {
        allStops.push({ plan_name: plan, ...stop });
      }
    }

    const summary = {
      totalRows: allStops.length,
      insertedRows: 0,
      updatedRows: 0,
      unchangedRows: 0,
      failedRows: 0,
      rowResults: [],
    };

    // Validate bus
    if (!isNonEmptyString(deviceId) && !isNonEmptyString(gpsId)) {
      // Your existing Bus schema uses gps_device_id as required.
      // We'll treat deviceId as gps_device_id (matches your AddBusesScreen).
      return res.status(400).json({ success: false, error: 'deviceId (gps_device_id) is required' });
    }

    const gps_device_id = isNonEmptyString(gpsId) ? gpsId : deviceId;

    // Upsert bus first
    const busFilter = { bus_no: normalizedBusNoValue };
    const busUpdate = {
      $set: {
        bus_name: busNo,
        gps_device_id,
        reg_no: regNo || null,
        preview_number: previewNumber || null,
        status: 'active',
      },
    };

    await Bus.findOneAndUpdate(busFilter, busUpdate, { upsert: true, new: true });
    const bus = await Bus.findOne({ bus_no: normalizedBusNoValue });
    if (!bus) throw new Error('Bus upsert failed');

    // Validate and normalize route rows
    const normalizedStops = allStops.map((row, idx) => {
      try {
        const plan_name = normalizePlanName(row.plan_name);
        const stop_name = normalizeStopName(row.stop_name);
        const stop_order = normalizeStopOrder(row.stop_order);

        if (!plan_name) throw new Error('Invalid plan_name');
        if (!stop_name) throw new Error('Invalid stop_name');
        if (stop_order === null) throw new Error('Invalid stop_order');

        return { ok: true, idx, value: { bus_id: bus._id, plan_name, stop_name, stop_order } };
      } catch (e) {
        return { ok: false, idx, error: e.message || 'Validation error' };
      }
    });

    for (const r of normalizedStops) {
      if (!r.ok) {
        summary.failedRows += 1;
        summary.rowResults.push({ index: r.idx, status: 'failed', reason: r.error });
      }
    }

    const good = normalizedStops.filter((r) => r.ok).map((r) => r.value);

    // Allow creating a bus with zero routes (no Excel uploaded yet).
    // Only reject if routes were provided but ALL rows failed validation.
    if (allStops.length > 0 && good.length === 0) {
      return res.status(400).json({ success: false, summary, error: 'All route rows failed validation' });
    }

    // If replaceRoutes is set, remove existing routes so edits fully replace old data.
    if (replaceRoutes) {
      await BusRoute.deleteMany({ bus_id: bus._id });
    }

    // Bus created/updated with no routes → success (routes can be added later).
    if (!good.length) {
      return res.status(200).json({
        success: true,
        busNo: normalizedBusNoValue,
        previewNumber: bus.preview_number,
        summary,
      });
    }

    // Existing routes for upsert comparison
    const existing = await BusRoute.find({ bus_id: bus._id, plan_name: { $in: Array.from(new Set(good.map((g) => g.plan_name))) } }).lean();
    const existingKeyToRow = new Map(
      existing.map((r) => [buildRouteKey(bus._id.toString(), r.plan_name, r.stop_order), r])
    );

    const ops = [];

    for (const row of good) {
      const key = buildRouteKey(bus._id.toString(), row.plan_name, row.stop_order);
      const cur = existingKeyToRow.get(key);
      if (!cur) {
        ops.push({
          updateOne: {
            filter: { bus_id: bus._id, plan_name: row.plan_name, stop_order: row.stop_order },
            update: { $set: { bus_id: bus._id, plan_name: row.plan_name, stop_name: row.stop_name, stop_order: row.stop_order } },
            upsert: true,
          },
        });
        continue;
      }

      const unchanged = cur.stop_name === row.stop_name && cur.stop_order === row.stop_order && cur.plan_name === row.plan_name;
      if (unchanged) {
        summary.unchangedRows += 1;
        continue;
      }

      ops.push({
        updateOne: {
          filter: { bus_id: bus._id, plan_name: row.plan_name, stop_order: row.stop_order },
          update: { $set: { stop_name: row.stop_name } },
          upsert: false,
        },
      });
    }

    if (ops.length) {
      const result = await BusRoute.bulkWrite(ops, { ordered: false });
      summary.insertedRows = (result.upsertedCount || 0);
      summary.updatedRows = (result.modifiedCount || 0);
    }

    return res.status(200).json({ success: true, summary });
  } catch (error) {
    console.error('importBusRoutes error:', error);
    return res.status(500).json({
      success: false,
      summary: { totalRows: 0, insertedRows: 0, updatedRows: 0, unchangedRows: 0, failedRows: 1 },
      error: error.message,
    });
  }
}

module.exports = { importBusRoutes };

