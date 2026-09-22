const Bus = require("../models/Bus");
const BusRoute = require("../models/BusRoute");
const BusLiveLocation = require("../models/BusLiveLocation");
const AppSetting = require("../models/AppSetting");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { getIO } = require("../socket");

const GLOBAL_ACTIVE_PLAN_KEY = "global_active_plan";
const DEFAULT_PLAN_NAMES = ["PLAN A", "PLAN B", "PLAN C", "PLAN D"];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

async function notifyAssignedUsersOfBusStatus(bus, status) {
  const users = await User.find({
    bus_no: new RegExp(`^${escapeRegExp(bus.bus_no)}$`, "i"),
    role: "student",
    is_active: true,
  }).select("_id");

  if (!users.length) return;
  const message =
    status === "active"
      ? `Your bus ${bus.preview_number ?? ""} is active now.`
      : `Your bus ${bus.preview_number ?? ""} is inactive now.`;
  const notifications = users.map((user) => ({
    user_id: user._id,
    type: "bus_status",
    message,
    new_preview: bus.preview_number ?? null,
    is_bus_active: status === "active",
  }));
  await Notification.insertMany(notifications);

  const io = getIO();
  if (io) {
    users.forEach((user) => {
      io.to(`user_${String(user._id)}`).emit("notification", {
        type: "bus_status",
        message,
        previewNumber: bus.preview_number ?? null,
        isBusActive: status === "active",
      });
    });
  }
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

    // Privacy: remove internal identifiers for non-superadmin users
    const isSuperadmin = req.user && String(req.user.role || '').toLowerCase() === 'superadmin';
    const safeBuses = isSuperadmin
      ? enrichedBuses
      : enrichedBuses.map((b) => ({
          previewNumber: b.previewNumber,
          status: b.status,
          mobileLive: b.mobileLive,
          latitude: b.latitude,
          longitude: b.longitude,
          speed: b.speed,
          isOnline: b.isOnline,
          lastUpdated: b.lastUpdated,
          source: b.source,
        }));

    res.status(200).json({
      buses: safeBuses,
      count: safeBuses.length,
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

    // Privacy: hide bus_no and plan details for non-superadmin users
    const isSuperadmin = req.user && String(req.user.role || '').toLowerCase() === 'superadmin';
    const safeResponse = isSuperadmin
      ? response
      : response.map((b) => ({
          previewNumber: b.previewNumber,
          status: b.status,
          latitude: b.latitude,
          longitude: b.longitude,
          speed: b.speed,
          isOnline: b.isOnline,
          lastUpdated: b.lastUpdated,
          source: b.source,
        }));

    res.status(200).json({
      success: true,
      plan: isSuperadmin ? targetPlan : null,
      buses: safeResponse,
      count: safeResponse.length,
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

    const bus = await Bus.findOneAndUpdate(
      { bus_no: busNo.toUpperCase() },
      { status: "active" },
      { new: true },
    );
    if (!bus) return res.status(404).json({ error: "Bus not found" });
    await notifyAssignedUsersOfBusStatus(bus, "active");

    res.json({ message: "Bus activated" });
  } catch (error) {
    console.error("activateBus error:", error);
    res.status(500).json({ error: error.message });
  }
}

// ================= DEACTIVATE BUS =================
async function deactivateBus(req, res) {
  try {
    const { busNo } = req.params;

    const bus = await Bus.findOneAndUpdate(
      { bus_no: busNo.toUpperCase() },
      { status: "inactive" },
      { new: true },
    );
    if (!bus) return res.status(404).json({ error: "Bus not found" });
    await notifyAssignedUsersOfBusStatus(bus, "inactive");

    res.json({ message: "Bus deactivated" });
  } catch (error) {
    console.error("deactivateBus error:", error);
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

    // Only superadmin may see the actual plan name. Regular users receive a
    // response that indicates the plan is intentionally hidden for privacy.
    const isSuperadmin = req.user && String(req.user.role || '').toLowerCase() === 'superadmin';

    res.json({
      success: true,
      activePlan: isSuperadmin ? activePlan : null,
      planNames: isSuperadmin ? DEFAULT_PLAN_NAMES : [],
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

    const students = await User.find({
      role: "student",
      is_active: true,
      bus_no: { $nin: [null, ""] },
    }).select("_id bus_no").lean();
    const buses = await Bus.find({ status: "active" })
      .select("_id bus_no preview_number")
      .lean();
    const busByIdentifier = new Map();
    buses.forEach((bus) => {
      busByIdentifier.set(String(bus.bus_no).trim().toUpperCase(), bus);
      if (bus.preview_number != null) {
        busByIdentifier.set(String(bus.preview_number).trim().toUpperCase(), bus);
      }
    });
    const activeBusIds = new Set(
      (await BusRoute.find({ plan_name: normalized }).distinct("bus_id"))
        .map((id) => String(id)),
    );
    const planNotifications = students.map((student) => {
      const bus = busByIdentifier.get(String(student.bus_no).trim().toUpperCase());
      const isBusActive = !!bus && activeBusIds.has(String(bus._id));
      return {
        user_id: student._id,
        type: "plan_changed",
        message: isBusActive
          ? "Your bus is active after the latest route update."
          : "Your bus is not active after the latest route update.",
        plan_name: normalized,
        is_bus_active: isBusActive,
      };
    });
    if (planNotifications.length) {
      await Notification.insertMany(planNotifications);
    }

    const io = getIO();
    if (io) {
      // Do not broadcast the active plan value to all connected clients (privacy).
      // Send per-user notifications without including the plan name. Admin UIs should fetch
      // the global plan via the protected API (superadmin only).
      io.emit("bus-update", { actionType: "PLAN_CHANGED" });
      planNotifications.forEach((notification) => {
        io.to(`user_${String(notification.user_id)}`).emit("notification", {
          type: notification.type,
          message: notification.message,
          isBusActive: notification.is_bus_active,
        });
      });
    }
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

async function alterBus(req, res) {
  try {
    const sourceBus = await findBusByIdentifier(req.params.busNo);
    const targetBus = await findBusByIdentifier(req.body?.newBusNo);

    if (!sourceBus) {
      return res.status(404).json({ success: false, error: 'Source bus not found.' });
    }
    if (!targetBus) {
      return res.status(404).json({ success: false, error: 'New bus not found.' });
    }
    if (sourceBus._id.equals(targetBus._id)) {
      return res.status(400).json({ success: false, error: 'Choose a different bus.' });
    }
    if (targetBus.status !== 'active') {
      return res.status(400).json({ success: false, error: 'The new bus is not active.' });
    }

    if (sourceBus.altered_to_bus_id) {
      return res.status(409).json({
        success: false,
        error: 'This bus has already been altered.',
        alteredToPreview: sourceBus.altered_to_preview,
      });
    }

    const sourceIdentifiers = [sourceBus.bus_no];
    if (sourceBus.preview_number != null) {
      sourceIdentifiers.push(String(sourceBus.preview_number));
    }
    const users = await User.find({
      bus_no: {
        $in: sourceIdentifiers.map(
          (identifier) => new RegExp(`^${escapeRegExp(identifier)}$`, "i"),
        ),
      },
      role: 'student',
      is_active: true,
    }).select('_id bus_no');

    // Use preview numbers for user-facing messages. Keep internal bus_no stored for audit.
    const previewMessage = `Your bus has been altered to ${targetBus.preview_number ?? 'a different bus'}.`;

    const notifications = users.map((user) => ({
      user_id: user._id,
      type: 'bus_altered',
      message: previewMessage,
      old_bus_no: sourceBus.bus_no,
      new_bus_no: targetBus.bus_no,
      old_preview: sourceBus.preview_number ?? null,
      new_preview: targetBus.preview_number ?? null,
    }));

    if (notifications.length) await Notification.insertMany(notifications);

    if (users.length) {
      // Update the user's assigned bus_no internally (admin-facing). The frontend for students
      // should continue to identify buses by preview numbers; the stored bus_no remains an internal value.
      await User.updateMany(
        { _id: { $in: users.map((user) => user._id) } },
        { $set: { bus_no: targetBus.bus_no } },
      );
    }

    sourceBus.status = "inactive";
    sourceBus.altered_to_bus_id = targetBus._id;
    sourceBus.altered_to_preview = targetBus.preview_number ?? null;
    sourceBus.altered_at = new Date();
    await sourceBus.save();

    const io = getIO();
    if (io) {
      users.forEach((user) => {
        // Emit a privacy-preserving notification: include preview numbers only so the student
        // can be informed without revealing internal bus numbers.
        io.to(`user_${user._id.toString()}`).emit('notification', {
          type: 'bus_altered',
          message: previewMessage,
          oldPreview: sourceBus.preview_number ?? null,
          newPreview: targetBus.preview_number ?? null,
        });
      });
    }

    res.json({
      success: true,
      sourceBusNo: sourceBus.bus_no,
      newBusNo: targetBus.bus_no,
      notifiedStudents: users.length,
    });
  } catch (error) {
    console.error('alterBus error:', error);
    res.status(500).json({ success: false, error: 'Failed to alter the bus.' });
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

    const isSuperadmin = req.user && String(req.user.role || '').toLowerCase() === 'superadmin';
    res.json({
      success: true,
      busNo: isSuperadmin ? bus.bus_no : String(bus.preview_number ?? bus.bus_no),
      previewNumber: bus.preview_number,
      activePlan: isSuperadmin ? activePlan : null,
      isBusActiveInCurrentPlan: !!isBusActiveInCurrentPlan,
      notActiveMessage: isSuperadmin
        ? (isBusActiveInCurrentPlan ? null : buildNotActiveMessage(activePlan))
        : null,
      planNames: isSuperadmin ? Object.keys(plansMap) : [],
      plans: isSuperadmin ? plansMap : {},
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

    const alteration = bus.altered_to_bus_id
      ? {
          isAltered: true,
          message: `This bus has been altered. Please search bus ${bus.altered_to_preview ?? "the new preview number"}.`,
          newPreview: bus.altered_to_preview ?? null,
        }
      : null;

    const location = await BusLiveLocation.findOne({ bus_id: bus._id });
    const activePlan = await getCurrentGlobalPlan();
    const isBusActiveInCurrentPlan = await BusRoute.exists({
      bus_id: bus._id,
      plan_name: activePlan,
    });

    // Privacy: only superadmin may receive internal bus_no in responses.
    const isSuperadmin = req.user && String(req.user.role || '').toLowerCase() === 'superadmin';

    // Choose the bus identifier to return to the client: previewNumber for regular users
    // and bus_no for superadmin.
    const clientBusIdentifier = isSuperadmin
      ? (matchedByIdentifier ? String(bus.preview_number ?? bus.bus_no) : bus.bus_no)
      : String(bus.preview_number ?? bus.bus_no);

    const responseData = {
      success: !!location,
      // For privacy return only the previewNumber to regular users.
      busNo: clientBusIdentifier,
      // Include bus_no only for superadmin
      ...(isSuperadmin ? { bus_no: clientBusIdentifier } : {}),
      currentPlan: null,
      activePlan: isSuperadmin ? activePlan : null,
      isBusActiveInCurrentPlan: !!isBusActiveInCurrentPlan,
      notActiveMessage: isSuperadmin
        ? (isBusActiveInCurrentPlan ? null : buildNotActiveMessage(activePlan))
        : null,
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
      alteration,
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
    // Privacy: return previewNumber to regular users; superadmin may receive bus_no and plan.
    const isSuperadmin = req.user && String(req.user.role || '').toLowerCase() === 'superadmin';
    const alteration = bus.altered_to_bus_id
      ? {
          isAltered: true,
          message: `This bus has been altered. Please search bus ${bus.altered_to_preview ?? "the new preview number"}.`,
          newPreview: bus.altered_to_preview ?? null,
        }
      : null;
    res.status(200).json({
      success: true,
      busNo: isSuperadmin ? bus.bus_no : String(bus.preview_number ?? bus.bus_no),
      ...(isSuperadmin ? { bus_no: bus.bus_no } : {}),
      previewNumber: bus.preview_number,
      currentPlan: null,
      activePlan: isSuperadmin ? activePlan : null,
      isBusActiveInCurrentPlan: !!isBusActiveInCurrentPlan,
      notActiveMessage: isSuperadmin
        ? (isBusActiveInCurrentPlan ? null : buildNotActiveMessage(activePlan))
        : null,
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
      alteration,
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
  alterBus,
};
