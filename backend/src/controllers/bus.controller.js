const Bus = require("../models/Bus");
const BusRoute = require("../models/BusRoute");
const BusLiveLocation = require("../models/BusLiveLocation");
const AppSetting = require("../models/AppSetting");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { getIO } = require("../socket");
const mergeBusRoutes = require("../utils/mergeBusRoutes");

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
      ? `Bus ${bus.preview_number ?? ""} is active now.`
      : `Bus ${bus.preview_number ?? ""} is inactive now.`;
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

async function resolveEffectiveBus(bus) {
  const visited = new Set();
  let effectiveBus = bus;
  let depth = 0;

  while (effectiveBus?.altered_to_bus_id && depth < 20) {
    const currentId = String(effectiveBus._id);
    if (visited.has(currentId)) break;
    visited.add(currentId);

    const nextBus = await Bus.findById(effectiveBus.altered_to_bus_id);
    if (!nextBus) break;
    effectiveBus = nextBus;
    depth += 1;
  }

  return effectiveBus;
}

function buildAlterationDetails(sourceBus, effectiveBus) {
  if (!sourceBus || String(sourceBus._id) === String(effectiveBus?._id)) {
    return null;
  }

  const oldPreview = sourceBus.preview_number ?? "your current bus";
  const newPreview = effectiveBus.preview_number ?? "the replacement bus";
  const isCombined = sourceBus.alteration_type === "combine";
  return {
    isAltered: true,
    alterationType: sourceBus.alteration_type || "alter",
    message: isCombined
      ? `Bus ${oldPreview} is combined with bus ${newPreview}. The service includes their merged stops, plans, and routes and uses bus ${newPreview}'s location.`
      : `Bus ${oldPreview} is altered to use bus ${newPreview}'s location. Your original stops and plans are unchanged.`,
    newPreview: effectiveBus.preview_number ?? null,
    effectivePreview: effectiveBus.preview_number ?? null,
  };
}

const hasRouteForPlan = (routes, planName) =>
  routes.some(
    (route) => route.plan_name.toUpperCase() === planName.toUpperCase(),
  );

async function getRoutesForBus(bus) {
  const sourceRoutes = await BusRoute.find({ bus_id: bus._id })
    .select("plan_name stop_name stop_order")
    .sort({ plan_name: 1, stop_order: 1 })
    .lean();
  if (!bus.altered_to_bus_id || bus.alteration_type !== "combine") {
    return sourceRoutes;
  }

  const targetRoutes = await BusRoute.find({
    bus_id: bus.altered_to_bus_id,
  })
    .select("plan_name stop_name stop_order")
    .sort({ plan_name: 1, stop_order: 1 })
    .lean();
  return mergeBusRoutes(sourceRoutes, targetRoutes);
}

async function findStudentsAssignedToBus(bus) {
  const identifiers = [bus.bus_no];
  if (bus.preview_number != null) identifiers.push(String(bus.preview_number));
  return User.find({
    bus_no: {
      $in: identifiers.map(
        (identifier) => new RegExp(`^${escapeRegExp(identifier)}$`, "i"),
      ),
    },
    role: "student",
    is_active: true,
  }).select("_id bus_no");
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
    const buses = await Bus.find({}).sort({
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
        alteredToPreview: bus.altered_to_preview ?? null,
        alteredAt: bus.altered_at ?? null,
        isAltered: !!bus.altered_to_bus_id,
        alterationType: bus.altered_to_bus_id
          ? bus.alteration_type || "alter"
          : null,
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

    const alteredBuses = safeBuses.filter((bus) => bus.isAltered);
    const normalBuses = safeBuses.filter((bus) => !bus.isAltered);
    res.status(200).json({
      // Keep `buses` for existing clients while exposing an explicit altered section.
      buses: normalBuses,
      alteredBuses,
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

    const isSuperadmin = req.user && String(req.user.role || '').toLowerCase() === 'superadmin';
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
      (await BusRoute.find({ plan_name: new RegExp(`^${escapeRegExp(normalized)}$`, "i") }).distinct("bus_id"))
        .map((id) => String(id)),
    );
    const planNotifications = students.map((student) => {
      const bus = busByIdentifier.get(String(student.bus_no).trim().toUpperCase());
      const isBusActive = !!bus && activeBusIds.has(String(bus._id));
      return {
        user_id: student._id,
        type: "plan_changed",
        message: isBusActive
          ? `Bus ${bus?.preview_number ?? ""} is active now.`
          : `Bus ${bus?.preview_number ?? ""} is inactive now.`,
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

async function changeBus(req, res, alterationType) {
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
    if (sourceBus.altered_to_bus_id) {
      return res.status(400).json({
        success: false,
        error: 'Restore this bus before choosing another replacement.',
      });
    }
    if (sourceBus.status !== 'active') {
      return res.status(400).json({
        success: false,
        error: 'Only an active bus can be changed.',
      });
    }
    if (targetBus.status !== 'active' || targetBus.altered_to_bus_id) {
      return res.status(400).json({
        success: false,
        error: 'Choose an active bus that is not already altered or combined.',
      });
    }
    if (!sourceBus.preview_number || !targetBus.preview_number) {
      return res.status(400).json({
        success: false,
        error: 'Both buses need a preview number before they can be changed.',
      });
    }

    const users = await findStudentsAssignedToBus(sourceBus);

    const isCombined = alterationType === "combine";
    const notificationType = isCombined ? "bus_combined" : "bus_altered";
    const previewMessage = isCombined
      ? `Bus ${sourceBus.preview_number} is combined with bus ${targetBus.preview_number}. The service includes their merged stops, plans, and routes and uses bus ${targetBus.preview_number}'s location.`
      : `Bus ${sourceBus.preview_number} is altered to use bus ${targetBus.preview_number}'s location. Your stops and plans remain unchanged.`;

    const notifications = users.map((user) => ({
      user_id: user._id,
      type: notificationType,
      message: previewMessage,
      old_bus_no: sourceBus.bus_no,
      new_bus_no: targetBus.bus_no,
      old_preview: sourceBus.preview_number ?? null,
      new_preview: targetBus.preview_number ?? null,
    }));

    if (notifications.length) await Notification.insertMany(notifications);

    sourceBus.status = "inactive";
    sourceBus.altered_to_bus_id = targetBus._id;
    sourceBus.altered_to_preview = targetBus.preview_number ?? null;
    sourceBus.alteration_type = alterationType;
    sourceBus.altered_at = new Date();
    await sourceBus.save();

    const io = getIO();
    if (io) {
      users.forEach((user) => {
        // Emit a privacy-preserving notification: include preview numbers only so the student
        // can be informed without revealing internal bus numbers.
        io.to(`user_${user._id.toString()}`).emit('notification', {
          type: notificationType,
          message: previewMessage,
          oldPreview: sourceBus.preview_number ?? null,
          newPreview: targetBus.preview_number ?? null,
        });
      });
    }
    if (io) {
      io.emit("bus-update", {
        actionType: isCombined ? "BUS_COMBINED" : "BUS_ALTERED",
        oldPreview: sourceBus.preview_number,
        newPreview: targetBus.preview_number,
      });
    }

    res.json({
      success: true,
      message: previewMessage,
      sourceBusNo: sourceBus.bus_no,
      newBusNo: targetBus.bus_no,
      sourcePreview: sourceBus.preview_number,
      newPreview: targetBus.preview_number,
      notifiedStudents: users.length,
    });
  } catch (error) {
    console.error(`${alterationType} bus error:`, error);
    res.status(500).json({
      success: false,
      error: `Failed to ${alterationType} the bus.`,
    });
  }
}

async function alterBus(req, res) {
  return changeBus(req, res, "alter");
}

async function combineBus(req, res) {
  return changeBus(req, res, "combine");
}

async function restoreAlteredBus(req, res) {
  try {
    const bus = await findBusByIdentifier(req.params.busNo);
    if (!bus) {
      return res.status(404).json({ success: false, error: "Bus not found." });
    }
    if (!bus.altered_to_bus_id) {
      return res.status(400).json({ success: false, error: "This bus is not combined." });
    }

    const replacementBus = await Bus.findById(bus.altered_to_bus_id);
    const previousPreview =
      replacementBus?.preview_number ?? bus.altered_to_preview ?? null;
    const alterationType = bus.alteration_type || "alter";
    const notificationType =
      alterationType === "combine" ? "bus_combined" : "bus_altered";
    const users = await findStudentsAssignedToBus(bus);
    bus.status = "active";
    bus.altered_to_bus_id = null;
    bus.altered_to_preview = null;
    bus.alteration_type = null;
    bus.altered_at = null;
    await bus.save();

    const message =
      alterationType === "combine"
        ? `The combined service with bus ${previousPreview ?? "replacement"} has ended. Your original bus plans and stops are restored.`
        : `The bus alteration with bus ${previousPreview ?? "replacement"} has ended. Your original bus is restored.`;
    const notifications = users.map((user) => ({
      user_id: user._id,
      type: notificationType,
      message,
      old_bus_no: replacementBus?.bus_no ?? null,
      new_bus_no: bus.bus_no,
      old_preview: previousPreview,
      new_preview: bus.preview_number ?? null,
    }));
    if (notifications.length) await Notification.insertMany(notifications);

    const io = getIO();
    if (io) {
      users.forEach((user) => {
        io.to(`user_${user._id.toString()}`).emit("notification", {
          type: notificationType,
          message,
          oldPreview: previousPreview,
          newPreview: bus.preview_number ?? null,
        });
      });
      io.emit("bus-update", {
        actionType: "BUS_RESTORED",
        previewNumber: bus.preview_number,
      });
    }
    return res.json({
      success: true,
      message,
      previewNumber: bus.preview_number,
      notifiedStudents: users.length,
    });
  } catch (error) {
    console.error("restoreAlteredBus error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Failed to restore combined bus." });
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

    const routes = await getRoutesForBus(bus);

    const plansMap = {};
    for (const r of routes) {
      if (!plansMap[r.plan_name]) plansMap[r.plan_name] = [];
      plansMap[r.plan_name].push({
        stop_name: r.stop_name,
        stop_order: r.stop_order,
      });
    }

    const activePlan = await getCurrentGlobalPlan();
    const activePlanKey = Object.keys(plansMap).find(
      (name) => name.toUpperCase() === activePlan.toUpperCase(),
    );
    const isBusActiveInCurrentPlan = hasRouteForPlan(routes, activePlan);

    const isSuperadmin = req.user && String(req.user.role || '').toLowerCase() === 'superadmin';
    res.json({
      success: true,
      busNo: isSuperadmin ? bus.bus_no : String(bus.preview_number ?? bus.bus_no),
      previewNumber: bus.preview_number,
      activePlan,
      isBusActiveInCurrentPlan: !!isBusActiveInCurrentPlan,
      notActiveMessage: isBusActiveInCurrentPlan ? null : buildNotActiveMessage(activePlan),
      planNames: Object.keys(plansMap),
      plans: plansMap,
      stops: plansMap[activePlanKey] || [],
      hasStops: (plansMap[activePlanKey] || []).length > 0,
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

    const effectiveBus = await resolveEffectiveBus(bus);
    const alteration = buildAlterationDetails(bus, effectiveBus);
    const location = await BusLiveLocation.findOne({ bus_id: effectiveBus._id });
    const activePlan = await getCurrentGlobalPlan();
    const routes = await getRoutesForBus(bus);
    const activeStops = routes
      .filter(
        (route) =>
          route.plan_name.toUpperCase() === activePlan.toUpperCase(),
      )
      .map(({ stop_name, stop_order }) => ({ stop_name, stop_order }));
    const isBusActiveInCurrentPlan = activeStops.length > 0;

    // Privacy: only superadmin may receive internal bus_no in responses.
    const isSuperadmin = req.user && String(req.user.role || '').toLowerCase() === 'superadmin';

    // Choose the bus identifier to return to the client: previewNumber for regular users
    // and bus_no for superadmin.
    const clientBusIdentifier = isSuperadmin
      ? (matchedByIdentifier ? String(bus.preview_number ?? bus.bus_no) : bus.bus_no)
      : String(bus.preview_number ?? bus.bus_no);

    const responseData = {
      // A database bus is a successful lookup even when GPS has no record yet.
      // The client must be able to show its inactive plan and available-bus options.
      success: true,
      // For privacy return only the previewNumber to regular users.
      busNo: clientBusIdentifier,
      // Include bus_no only for superadmin
      ...(isSuperadmin ? { bus_no: clientBusIdentifier } : {}),
      currentPlan: activePlan,
      activePlan,
      isBusActiveInCurrentPlan: !!isBusActiveInCurrentPlan,
      notActiveMessage: isBusActiveInCurrentPlan ? null : buildNotActiveMessage(activePlan),
      previewNumber: effectiveBus.preview_number,
      effectivePreviewNumber: effectiveBus.preview_number,
      effectiveBusNo: effectiveBus.bus_no,
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
      stops: activeStops,
      hasStops: activeStops.length > 0,
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

    const effectiveBus = await resolveEffectiveBus(bus);
    const alteration = buildAlterationDetails(bus, effectiveBus);
    const location = await BusLiveLocation.findOne({ bus_id: effectiveBus._id });
    const activePlan = await getCurrentGlobalPlan();
    const routes = await getRoutesForBus(bus);
    const isBusActiveInCurrentPlan = hasRouteForPlan(routes, activePlan);

    // Bus found → always return 200 with offline status if no location doc,
    // so the frontend can show the bus's plan even when GPS is offline.
    // Privacy: return previewNumber to regular users; superadmin may receive bus_no and plan.
    const isSuperadmin = req.user && String(req.user.role || '').toLowerCase() === 'superadmin';
    res.status(200).json({
      success: true,
      busNo: isSuperadmin ? bus.bus_no : String(bus.preview_number ?? bus.bus_no),
      ...(isSuperadmin ? { bus_no: bus.bus_no } : {}),
      previewNumber: effectiveBus.preview_number,
      effectivePreviewNumber: effectiveBus.preview_number,
      effectiveBusNo: effectiveBus.bus_no,
      currentPlan: activePlan,
      activePlan,
      isBusActiveInCurrentPlan: !!isBusActiveInCurrentPlan,
      notActiveMessage: isBusActiveInCurrentPlan ? null : buildNotActiveMessage(activePlan),
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
  combineBus,
  restoreAlteredBus,
};
