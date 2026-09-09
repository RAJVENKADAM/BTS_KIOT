const Bus = require("../models/Bus");
const BusRoute = require("../models/BusRoute");
const BusLiveLocation = require("../models/BusLiveLocation");
const AppSetting = require("../models/AppSetting");
const { getIO } = require("../socket");

const GLOBAL_ACTIVE_PLAN_KEY = "global_active_plan";
const DEFAULT_PLAN_NAMES = ["PLAN A", "PLAN B", "PLAN C", "PLAN D"];

function normalizePlanName(plan) {
  const value = String(plan ?? "")
    .trim()
    .toUpperCase();
  return value || "PLAN A";
}

async function getCurrentGlobalPlan() {
  const setting = await AppSetting.findOne({
    key: GLOBAL_ACTIVE_PLAN_KEY,
  }).lean();
  const activePlan = normalizePlanName(setting?.value || "PLAN A");
  return DEFAULT_PLAN_NAMES.includes(activePlan) ? activePlan : "PLAN A";
}

function buildNotActiveMessage(activePlan) {
  return `This bus is not in the active global plan (${activePlan}).`;
}

// ================= SHARED HELPERS =================
/**
 * Find a bus by EITHER its bus_no OR its preview_number.
 * bus_no is preferred when both match to avoid ambiguity.
 * Works for numeric (e.g. 4) and string ("4") preview numbers.
 */
async function findBusByIdentifier(identifier) {
  const normalizedBusNo = String(identifier).trim().toUpperCase();
  const raw = identifier;

  // 1) Exact bus_no match (most specific)
  let bus = await Bus.findOne({ bus_no: normalizedBusNo });
  if (bus) return bus;

  // 2) preview_number match — accept numeric and string forms
  bus = await Bus.findOne({
    preview_number: { $in: [raw, String(raw)] },
  });
  return bus;
}

// ================= UPLOAD BUS ROUTES =================
async function uploadBusRoutes(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { busNo, previewNumber, gpsId, deviceId, regNo } = req.body;

    if (!busNo || !deviceId) {
      return res
        .status(400)
        .json({ error: "Bus number and device ID are required" });
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
        status: "active",
      });
    }

    res.status(200).json({
      message: bus ? "Bus updated" : "Bus created",
      busNo: bus.bus_no,
      previewNumber: bus.preview_number,
      routesCount: 0,
    });
  } catch (error) {
    console.error("UPLOAD ERROR:", error);
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
        return res.status(400).json({ error: "Bus number already exists" });
      }

      await Bus.updateOne(
        { bus_no: busNo.toUpperCase() },
        { bus_no: newBusNo.toUpperCase() },
      );
      finalBusNo = newBusNo;
    }

    if (previewNumber !== undefined) {
      const exists = await Bus.findOne({
        preview_number: previewNumber,
        bus_no: { $ne: finalBusNo.toUpperCase() },
      });
      if (exists) {
        return res.status(400).json({ error: "Preview number already used" });
      }

      await Bus.updateOne(
        { bus_no: finalBusNo.toUpperCase() },
        { preview_number: previewNumber },
      );
    }

    res.status(200).json({
      message: "Bus updated successfully",
      busNo: finalBusNo,
      previewNumber,
    });
  } catch (error) {
    console.error("UPDATE ERROR:", error);
    res.status(500).json({ error: error.message });
  }
}

// ================= GET ALL BUSES WITH LIVE GPS =================
async function getAllBuses(req, res) {
  try {
    const buses = await Bus.find({ status: "active" }).sort({
      preview_number: 1,
      bus_no: 1,
    });

    // Batch fetch all live locations at once (fixes N+1 query)
    const busIds = buses.map((b) => b._id);
    const liveLocations = await BusLiveLocation.find({
      bus_id: { $in: busIds },
    });
    const locationMap = new Map(
      liveLocations.map((loc) => [loc.bus_id.toString(), loc]),
    );

    const enrichedBuses = buses.map((bus) => {
      const liveLocation = locationMap.get(bus._id.toString());
      const location = liveLocation;

      return {
        busNo: bus.bus_no,
        previewNumber: bus.preview_number,
        status: bus.status,
        gpsDeviceId: bus.gps_device_id,
        mobileLive: bus.mobile_live,
        latitude: location?.latitude ?? null,
        longitude: location?.longitude ?? null,
        speed: location?.speed ?? 0,
        isOnline: !!location,
        lastUpdated:
          location?.lastSuccessfulGpsUpdate ?? location?.updatedAt ?? null,
        source: location?.source ?? "offline",
      };
    });

    res.status(200).json({
      buses: enrichedBuses,
      count: enrichedBuses.length,
    });
  } catch (error) {
    console.error("GET ALL BUSES ERROR:", error);
    res.status(500).json({ error: error.message });
  }
}

async function getBusesForPlan(req, res) {
  try {
    const { plan } = req.params || {};
    const targetPlan = normalizePlanName(plan || "PLAN A");

    const busIds = await BusRoute.find({ plan_name: targetPlan })
      .distinct("bus_id")
      .catch(() => []);

    const buses = await Bus.find({
      _id: { $in: busIds },
      status: "active",
    }).sort({ bus_no: 1, preview_number: 1 });

    const liveLocations = await BusLiveLocation.find({
      bus_id: { $in: buses.map((bus) => bus._id) },
    });
    const locationMap = new Map(
      liveLocations.map((loc) => [loc.bus_id.toString(), loc]),
    );

    const response = buses.map((bus) => {
      const liveLocation = locationMap.get(bus._id.toString());
      return {
        busNo: bus.bus_no,
        previewNumber: bus.preview_number,
        status: bus.status,
        latitude: liveLocation?.latitude ?? null,
        longitude: liveLocation?.longitude ?? null,
        speed: liveLocation?.speed ?? 0,
        isOnline: !!liveLocation,
        lastUpdated:
          liveLocation?.lastSuccessfulGpsUpdate ?? liveLocation?.updatedAt ?? null,
        source: liveLocation?.source ?? "offline",
      };
    });

    res.status(200).json({
      success: true,
      plan: targetPlan,
      buses: response,
      count: response.length,
    });
  } catch (error) {
    console.error("GET BUSES FOR PLAN ERROR:", error);
    res.status(500).json({ success: false, error: error.message });
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

    res.json({ message: "Bus deleted successfully" });
  } catch (error) {
    console.error("Delete bus error:", error);
    res.status(500).json({ error: error.message });
  }
}

// ================= ACTIVATE BUS =================
async function activateBus(req, res) {
  try {
    const { busNo } = req.params;

    await Bus.updateOne({ bus_no: busNo.toUpperCase() }, { status: "active" });

    res.json({ message: "Bus activated" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ================= DEACTIVATE BUS =================
async function deactivateBus(req, res) {
  try {
    const { busNo } = req.params;

    await Bus.updateOne(
      { bus_no: busNo.toUpperCase() },
      { status: "inactive" },
    );

    res.json({ message: "Bus deactivated" });
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
      { preview_number: previewNumber },
    );

    res.json({ message: "Preview updated successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ================= UPDATE PLAN =================
async function updatePlan(req, res) {
  try {
    return res.status(400).json({
      success: false,
      error:
        "Individual bus plans are no longer supported. Use the global active plan instead.",
    });
  } catch (error) {
    console.error("Update plan error:", error);
    res.status(500).json({ error: error.message });
  }
}

// ================= GLOBAL ACTIVE PLAN =================
async function getGlobalActivePlan(req, res) {
  try {
    const activePlan = await getCurrentGlobalPlan();
    res.json({
      success: true,
      activePlan,
      planNames: DEFAULT_PLAN_NAMES,
    });
  } catch (error) {
    console.error("getGlobalActivePlan error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
}

async function setGlobalActivePlan(req, res) {
  try {
    const { plan } = req.body;
    const normalized = normalizePlanName(plan);

    if (!DEFAULT_PLAN_NAMES.includes(normalized)) {
      return res.status(400).json({
        success: false,
        error: "Invalid plan. Choose PLAN A, PLAN B, PLAN C, or PLAN D.",
      });
    }

    const updated = await AppSetting.findOneAndUpdate(
      { key: GLOBAL_ACTIVE_PLAN_KEY },
      { key: GLOBAL_ACTIVE_PLAN_KEY, value: normalized },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    res.json({
      success: true,
      message: "Global active plan updated successfully",
      activePlan: updated.value,
      planNames: DEFAULT_PLAN_NAMES,
    });
  } catch (error) {
    console.error("setGlobalActivePlan error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// ================= GET BUS ROUTES (PLANS + STOPS) =================
async function getBusRoutes(req, res) {
  try {
    const { busNo } = req.params;

    const bus = await findBusByIdentifier(busNo);
    if (!bus) {
      return res
        .status(404)
        .json({ success: false, error: `Bus ${busNo} not found` });
    }

    const routes = await BusRoute.find({ bus_id: bus._id })
      .sort({ plan_name: 1, stop_order: 1 })
      .lean();

    const plansMap = {};
    for (const r of routes) {
      if (!plansMap[r.plan_name]) plansMap[r.plan_name] = [];
      plansMap[r.plan_name].push({
        stop_name: r.stop_name,
        stop_order: r.stop_order,
      });
    }

    const activePlan = await getCurrentGlobalPlan();
    const isBusActiveInCurrentPlan = await BusRoute.exists({
      bus_id: bus._id,
      plan_name: activePlan,
    });

    res.json({
      success: true,
      busNo: bus.bus_no,
      previewNumber: bus.preview_number,
      activePlan,
      isBusActiveInCurrentPlan: !!isBusActiveInCurrentPlan,
      notActiveMessage: isBusActiveInCurrentPlan
        ? null
        : buildNotActiveMessage(activePlan),
      planNames: Object.keys(plansMap),
      plans: plansMap,
    });
  } catch (error) {
    console.error("getBusRoutes error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// ================= UPDATE BUS DETAILS =================
async function updateBusDetails(req, res) {
  try {
    const { busNo } = req.params;
    const { previewNumber, gpsDeviceId, regNo } = req.body;

    const bus = await Bus.findOne({ bus_no: busNo.toUpperCase() });
    if (!bus) {
      return res
        .status(404)
        .json({ success: false, error: `Bus ${busNo} not found` });
    }

    if (previewNumber !== undefined && previewNumber !== null) {
      const exists = await Bus.findOne({
        preview_number: previewNumber,
        bus_no: { $ne: bus.bus_no },
      });
      if (exists) {
        return res
          .status(400)
          .json({ success: false, error: "Preview number already in use" });
      }
      bus.preview_number = previewNumber;
    }

    if (
      gpsDeviceId !== undefined &&
      gpsDeviceId !== null &&
      gpsDeviceId !== ""
    ) {
      const exists = await Bus.findOne({
        gps_device_id: gpsDeviceId,
        bus_no: { $ne: bus.bus_no },
      });
      if (exists) {
        return res
          .status(400)
          .json({ success: false, error: "GPS device ID already in use" });
      }
      bus.gps_device_id = gpsDeviceId;
    }

    if (regNo !== undefined) bus.reg_no = regNo || null;

    await bus.save();

    res.json({
      success: true,
      message: "Bus details updated successfully",
      bus: {
        busNo: bus.bus_no,
        previewNumber: bus.preview_number,
        gpsDeviceId: bus.gps_device_id,
        regNo: bus.reg_no,
      },
    });
  } catch (error) {
    console.error("updateBusDetails error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// ================= GET PLANS =================
async function getPlans(req, res) {
  try {
    const { busNo } = req.params;

    const bus = await findBusByIdentifier(busNo);
    if (!bus) {
      return res.status(404).json({ error: `Bus ${busNo} not found` });
    }

    const routes = await BusRoute.find({ bus_id: bus._id })
      .distinct("plan_name")
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
    const normalizedBusNo = busNo.toUpperCase();

    // Search by bus_no first, then fall back to preview_number.
    // This lets users track a bus via its short preview number (e.g. "4")
    // while still preferring exact bus_no matches to avoid ambiguity.
    let bus = await Bus.findOne({ bus_no: normalizedBusNo });
    let matchedByIdentifier = false;

    if (!bus) {
      bus = await Bus.findOne({
        preview_number: { $in: [busNo, String(busNo)] },
      });
      matchedByIdentifier = true;
    }

    if (!bus) {
      return res.status(404).json({
        success: false,
        busNo: normalizedBusNo,
        error: "Bus not found",
        latitude: null,
        longitude: null,
        speed: null,
        status: "offline",
      });
    }

    const location = await BusLiveLocation.findOne({ bus_id: bus._id });
    const activePlan = await getCurrentGlobalPlan();
    const isBusActiveInCurrentPlan = await BusRoute.exists({
      bus_id: bus._id,
      plan_name: activePlan,
    });

    // ⚠️ Frontend validation: busApi.getBusLocation() rejects responses whose
    // busNo doesn't match the requested value. When the user searched by a
    // preview number, return the preview number as busNo so the validation
    // passes, while the rest of the payload carries the real bus's data.
    const responseBusNo = matchedByIdentifier
      ? String(bus.preview_number ?? bus.bus_no)
      : bus.bus_no;

    // Always return the bus_no that was requested for frontend validation
    const responseData = {
      success: !!location,
      busNo: responseBusNo,
      bus_no: responseBusNo,
      currentPlan: null,
      activePlan,
      isBusActiveInCurrentPlan: !!isBusActiveInCurrentPlan,
      notActiveMessage: isBusActiveInCurrentPlan
        ? null
        : buildNotActiveMessage(activePlan),
      previewNumber: bus.preview_number,
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null,
      speed: location?.speed ?? 0,
      status: location
        ? location.is_online
          ? "online"
          : "offline"
        : "offline",
      source: location?.source || "offline",
      lastSuccessfulGpsUpdate: location?.lastSuccessfulGpsUpdate ?? null,
      lastUpdated:
        location?.lastSuccessfulGpsUpdate ?? location?.updatedAt ?? null,
    };

    if (location) {
      res.status(200).json(responseData);
    } else {
      // Bus exists in DB but has no live location document yet → treat as offline
      res.status(200).json({
        ...responseData,
        success: true,
        status: "offline",
        source: "offline",
      });
    }
  } catch (error) {
    console.error("getLiveLocation error:", error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
}

// ================= TRACK BY PREVIEW =================
async function trackByPreview(req, res) {
  try {
    const { previewNumber } = req.params;

    // Accept string or numeric preview numbers (e.g. "4" or 4).
    const bus = await Bus.findOne({
      preview_number: { $in: [previewNumber, String(previewNumber)] },
      status: "active",
    });

    if (!bus) {
      return res.status(404).json({ error: "No bus found for preview number" });
    }

    const location = await BusLiveLocation.findOne({ bus_id: bus._id });
    const activePlan = await getCurrentGlobalPlan();
    const isBusActiveInCurrentPlan = await BusRoute.exists({
      bus_id: bus._id,
      plan_name: activePlan,
    });

    // Bus found → always return 200 with offline status if no location doc,
    // so the frontend can show the bus's plan even when GPS is offline.
    res.status(200).json({
      success: true,
      busNo: bus.bus_no,
      previewNumber: bus.preview_number,
      currentPlan: null,
      activePlan,
      isBusActiveInCurrentPlan: !!isBusActiveInCurrentPlan,
      notActiveMessage: isBusActiveInCurrentPlan
        ? null
        : buildNotActiveMessage(activePlan),
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null,
      speed: location?.speed ?? 0,
      status: location
        ? location.is_online
          ? "online"
          : "offline"
        : "offline",
      lastSuccessfulGpsUpdate: location?.lastSuccessfulGpsUpdate ?? null,
      lastUpdated:
        location?.lastSuccessfulGpsUpdate ?? location?.updatedAt ?? null,
    });
  } catch (error) {
    console.error("trackByPreview error:", error);
    res.status(500).json({ error: error.message });
  }
}

module.exports = {
  uploadBusRoutes,
  updateBusNumber,
  getAllBuses,
  getBusesForPlan,
  deleteBus,
  activateBus,
  deactivateBus,
  validatePreviewNumber,
  updatePreviewNumber,
  updatePlan,
  setGlobalActivePlan,
  getGlobalActivePlan,
  updateBusDetails,
  getBusRoutes,
  getPlans,
  getLiveLocation,
  trackByPreview,
};
