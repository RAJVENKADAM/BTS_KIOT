const Bus = require("../models/Bus");
const BusRoute = require("../models/BusRoute");
const StopMaster = require("../models/StopMaster");
const { randomUUID } = require("node:crypto");
const BusLiveLocation = require("../models/BusLiveLocation");
const AppSetting = require("../models/AppSetting");
const User = require("../models/User");
const Notification = require("../models/Notification");
const PlanMapping = require("../models/PlanMapping");
const BusChange = require("../models/BusChange");
const normalizeBusNumber = require("../utils/normalizeBusNumber");
const { getIO } = require("../socket");
const {
  getPlanChangeNotifications,
  loadPlanState,
} = require("../services/planMappingService");
const resolveBusServiceRoutes = require("../utils/resolveBusServiceRoutes");
const {
  resolveAssignedBusRoutes,
} = require("../utils/resolveBusServiceRoutes");
const selectAlterationRoutes = require("../utils/selectAlterationRoutes");
const findVerifiedStop = require("../utils/findVerifiedStop");
const isReusableTemporaryChangeSource = require("../utils/isReusableTemporaryChangeSource");
const normalizeStopName = require("../utils/normalizeStopName");
const {
  getEffectiveBusId,
  normalizeArrivalTime,
} = require("../utils/planMapping");

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

function getInactivePlanMessage(plan) {
  return `Your bus is inactive for ${plan}. It has no route or mapped replacement for today's service. Contact the Super Admin for assistance.`;
}

async function getCurrentGlobalPlan() {
  const setting = await AppSetting.findOne({
    key: GLOBAL_ACTIVE_PLAN_KEY,
  }).lean();
  const activePlan = normalizePlanName(setting?.value || "PLAN A");
  return DEFAULT_PLAN_NAMES.includes(activePlan) ? activePlan : "PLAN A";
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
  const normalizedBusNo = normalizeBusNumber(identifier);
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

async function resolvePlanMappingBus(bus, planName) {
  if (!bus || planName === "PLAN A") return bus;
  const mapping = await PlanMapping.findOne({
    plan_name: planName,
    member_bus_ids: bus._id,
  })
    .select("root_bus_id")
    .lean();
  if (!mapping) return bus;
  return (await Bus.findById(mapping.root_bus_id)) || bus;
}

async function resolvePlanMappingAssignment(bus, planName) {
  if (!bus || planName === "PLAN A") {
    return { routeBus: bus, locationBus: bus, hasTemporaryLocationBus: false };
  }
  const mapping = await PlanMapping.findOne({
    plan_name: planName,
    $or: [{ root_bus_id: bus._id }, { member_bus_ids: bus._id }],
  }).lean();
  if (!mapping) {
    return { routeBus: bus, locationBus: bus, hasTemporaryLocationBus: false };
  }
  const isMember = (mapping.member_bus_ids || []).some(
    (memberBusId) => String(memberBusId) === String(bus._id),
  );
  const routeBus = isMember
    ? (await Bus.findById(mapping.root_bus_id)) || bus
    : bus;
  const hasTemporaryLocationBus = Boolean(mapping.location_bus_id);
  const locationBus = hasTemporaryLocationBus
    ? (await Bus.findById(mapping.location_bus_id)) || routeBus
    : routeBus;
  return { routeBus, locationBus, hasTemporaryLocationBus };
}

async function getEffectiveRoutesForAllPlans(bus) {
  const routeGroups = await Promise.all(
    DEFAULT_PLAN_NAMES.map(async (planName) => {
      const planBus = await resolvePlanMappingBus(bus, planName);
      const routes = await getRoutesForBus(planBus);
      return routes.filter(
        (route) => normalizeRoutePlanName(route?.plan_name) === planName,
      );
    }),
  );
  return routeGroups.flat();
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
    originalPreview: sourceBus.preview_number ?? null,
    message: isCombined
      ? `For today's service, use Bus ${newPreview}. Follow the selected combined route's stops and timings shown under View Stops on Home.`
      : `For today's service, use Bus ${newPreview}. Continue following Bus ${oldPreview}'s original stops and timings; open Home and tap View Stops to see them.`,
    newPreview: effectiveBus.preview_number ?? null,
    effectivePreview: effectiveBus.preview_number ?? null,
  };
}

const normalizeRoutePlanName = (planName) =>
  String(planName ?? "").trim().toUpperCase();

const hasRouteForPlan = (routes, planName) =>
  routes.some(
    (route) =>
      normalizeRoutePlanName(route?.plan_name) ===
      normalizeRoutePlanName(planName),
  );

async function getIncomingBusChanges(bus) {
  return Bus.find({
    altered_to_bus_id: bus._id,
    alteration_type: { $in: ["alter", "combine"] },
  })
    .select(
      "_id bus_no preview_number alteration_type alteration_route_source alteration_routes",
    )
    .sort({ bus_no: 1 })
    .lean();
}

function buildReplacementDetails(bus, incomingChanges) {
  const replacedBus = incomingChanges.find(
    (changedBus) => changedBus.alteration_type === "alter",
  );
  if (!replacedBus) return null;

  const originalPreview =
    replacedBus.preview_number ?? replacedBus.bus_no ?? "the original bus";
  return {
    isReplacement: true,
    alterationType: "alter",
    replacementForPreview: originalPreview,
    message: `For today's service, use Bus ${bus.preview_number ?? bus.bus_no}. Follow Bus ${originalPreview}'s original stops and timings; open Home and tap View Stops to see them.`,
  };
}

async function getRoutesForBus(bus) {
  if (bus.combined_route_source && bus.combined_routes?.length) {
    return hydrateRouteRows(bus.combined_routes);
  }
  const sourceRoutes = await getBusRouteRows(bus._id);
  const isCombined = bus.alteration_type === "combine";
  const targetRoutes =
    isCombined && bus.altered_to_bus_id
      ? await getBusRouteRows(bus.altered_to_bus_id)
      : [];

  const selectedRoutes = selectAlterationRoutes(
    bus.alteration_route_source,
    sourceRoutes,
    targetRoutes,
    bus.alteration_routes,
  );
  if (selectedRoutes) return hydrateRouteRows(selectedRoutes);

  const incomingChanges = await getIncomingBusChanges(bus);
  const incomingRouteGroups = await Promise.all(
    incomingChanges.map(async (changedBus) => {
      const changedBusRoutes = await getBusRouteRows(changedBus._id);
      const selectedChangedRoutes = selectAlterationRoutes(
        changedBus.alteration_route_source,
        changedBusRoutes,
        sourceRoutes,
        changedBus.alteration_routes,
      );
      return {
        alterationType: changedBus.alteration_type,
        hasRouteSelection: !!changedBus.alteration_route_source,
        routes: selectedChangedRoutes || changedBusRoutes,
      };
    }),
  );

  return hydrateRouteRows(
    resolveBusServiceRoutes(sourceRoutes, incomingRouteGroups, targetRoutes),
  );
}

async function getAssignedBusRoutes(bus) {
  const sourceRoutes = await getBusRouteRows(bus._id);
  const targetRoutes = bus.altered_to_bus_id
    ? await getBusRouteRows(bus.altered_to_bus_id)
    : [];
  return hydrateRouteRows(
    resolveAssignedBusRoutes(bus, sourceRoutes, targetRoutes),
  );
}

async function getBusRouteRows(busId) {
  const rows = await BusRoute.find({ bus_id: busId })
    .select("plan_name stop_name stop_order stopId arrival_time")
    .sort({ plan_name: 1, stop_order: 1 })
    .lean();
  const existingIds = rows.map((row) => row.stopId).filter(Boolean);
  const existingStops = existingIds.length
    ? await StopMaster.find({ stopId: { $in: existingIds } })
        .select("stopId")
        .lean()
    : [];
  const existingIdSet = new Set(existingStops.map((stop) => stop.stopId));
  const activeRows = [];

  for (const row of rows) {
    if (row.stopId) {
      if (existingIdSet.has(row.stopId)) activeRows.push(row);
      continue;
    }

    const { stop } = await findVerifiedStop({ name: row.stop_name });
    let stopId = stop?.stopId;
    if (!stopId) {
      const key = String(row.stop_name).trim().replace(/\s+/g, " ").toLowerCase();
      const exact = new RegExp(`^${escapeRegExp(key)}$`, "i");
      const pendingStop = await StopMaster.findOne({
        status: "PENDING",
        name: exact,
      }).select("stopId").lean();
      stopId = pendingStop?.stopId;
    }
    if (!stopId) continue;
    await BusRoute.updateOne({ _id: row._id }, { $set: { stopId } });
    row.stopId = stopId;
    activeRows.push(row);
  }

  return hydrateRouteRows(activeRows);
}

async function hydrateRouteRows(routes) {
  const stopIds = [...new Set(routes.map((route) => route.stopId).filter(Boolean))];
  const stops = stopIds.length
    ? await StopMaster.find({ stopId: { $in: stopIds } })
        .select("stopId name latitude longitude status")
        .lean()
    : [];
  const stopMap = new Map(stops.map((stop) => [stop.stopId, stop]));
  return routes.map((route) => {
    const stop = stopMap.get(route.stopId);
    return {
      ...route,
      stop_name: stop?.status === "VERIFIED" ? stop.name : route.stop_name,
      latitude: stop?.latitude ?? null,
      longitude: stop?.longitude ?? null,
      stopStatus: stop?.status || "PENDING",
    };
  });
}

async function getRouteSelectionLabel(bus, incomingChanges) {
  const selectedChange =
    (bus.alteration_route_source && bus) ||
    incomingChanges.find((change) => change.alteration_route_source);
  if (!selectedChange) return null;

  if (selectedChange.alteration_route_source === "custom") {
    return "Uploaded routes";
  }
  if (selectedChange.alteration_route_source === "source") {
    return `Bus ${selectedChange.preview_number ?? "selected"} routes`;
  }

  if (selectedChange === bus) {
    const targetBus = bus.altered_to_bus_id
      ? await Bus.findById(bus.altered_to_bus_id)
        .select("bus_no preview_number")
        .lean()
      : null;
    return `Bus ${targetBus?.preview_number ?? bus.altered_to_preview ?? "replacement"} routes`;
  }

  return `Bus ${bus.preview_number ?? bus.bus_no} routes`;
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
    const normalizedBusNo = normalizeBusNumber(busNo);
    let bus = await Bus.findOne({ bus_no: normalizedBusNo });

    if (bus) {
      if (await findActiveChangeForBus(bus._id)) {
        return res.status(409).json({
          success: false,
          error: "Roll back the temporary bus change before editing this bus.",
        });
      }
      // Update existing bus
      bus.gps_device_id = deviceId;
      bus.reg_no = regNo;
      if (previewNumber) bus.preview_number = previewNumber;
      await bus.save();
    } else {
      // Create new bus
      bus = await Bus.create({
        bus_no: normalizedBusNo,
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
    const normalizedBusNo = normalizeBusNumber(busNo);
    const normalizedNewBusNo = newBusNo ? normalizeBusNumber(newBusNo) : null;
    const currentBus = await Bus.findOne({ bus_no: normalizedBusNo });
    if (!currentBus) {
      return res.status(404).json({ success: false, error: "Bus not found." });
    }
    if (await findActiveChangeForBus(currentBus._id)) {
      return res.status(409).json({
        success: false,
        error: "Roll back the temporary bus change before editing this bus.",
      });
    }

    let finalBusNo = normalizedBusNo;

    if (normalizedNewBusNo && normalizedNewBusNo !== normalizedBusNo) {
      const exists = await Bus.findOne({ bus_no: normalizedNewBusNo });
      if (exists) {
        return res.status(400).json({ error: "Bus number already exists" });
      }

      await Bus.updateOne(
        { bus_no: normalizedBusNo },
        { bus_no: normalizedNewBusNo },
      );
      finalBusNo = normalizedNewBusNo;
    }

    if (previewNumber !== undefined) {
      const exists = await Bus.findOne({
        preview_number: previewNumber,
        bus_no: { $ne: normalizeBusNumber(finalBusNo) },
      });
      if (exists) {
        return res.status(400).json({ error: "Preview number already used" });
      }

      await Bus.updateOne(
        { bus_no: normalizeBusNumber(finalBusNo) },
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
    const isSuperadmin = req.user && String(req.user.role || '').toLowerCase() === 'superadmin';
    const activeChangeBusIds = new Set();
    let activeChanges = [];
    if (isSuperadmin) {
      activeChanges = await BusChange.find({
        status: { $in: ["applying", "active"] },
      }).select("sourceBusId targetBusId type status").lean();
      activeChanges.forEach((change) => {
        activeChangeBusIds.add(String(change.sourceBusId));
        activeChangeBusIds.add(String(change.targetBusId));
      });
    }

    // Batch fetch all live locations at once (fixes N+1 query)
    const busIds = buses.map((b) => b._id);
    const liveLocations = await BusLiveLocation.find({
      bus_id: { $in: busIds },
    });
    const assignedStudents = await User.find({
      role: "student",
      is_active: true,
      bus_no: { $nin: [null, ""] },
    })
      .select("bus_no")
      .lean();
    const busIdByIdentifier = new Map();
    buses.forEach((bus) => {
      busIdByIdentifier.set(String(bus.bus_no || "").trim().toUpperCase(), String(bus._id));
    });
    buses.forEach((bus) => {
      const preview = String(bus.preview_number ?? "").trim().toUpperCase();
      if (preview && !busIdByIdentifier.has(preview)) {
        busIdByIdentifier.set(preview, String(bus._id));
      }
    });
    const riderCountByBusId = new Map();
    assignedStudents.forEach((student) => {
      const busId = busIdByIdentifier.get(
        String(student.bus_no || "").trim().toUpperCase(),
      );
      if (busId) riderCountByBusId.set(busId, (riderCountByBusId.get(busId) || 0) + 1);
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
        regNo: bus.reg_no,
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
        isTemporaryChange: activeChangeBusIds.has(String(bus._id)),
        riderCount: riderCountByBusId.get(String(bus._id)) || 0,
        canBeTemporaryReplacement:
          isSuperadmin &&
          ((bus.status === "active" &&
            !bus.altered_to_bus_id &&
            !bus.combined_route_source &&
            !activeChangeBusIds.has(String(bus._id))) ||
            (isReusableTemporaryChangeSource(activeChanges, bus._id) &&
              (riderCountByBusId.get(String(bus._id)) || 0) === 0)),
      };
    });

    // Privacy: remove internal identifiers for non-superadmin users
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
    const isSuperadmin =
      req.user && String(req.user.role || "").toLowerCase() === "superadmin";
    const { plan } = req.params || {};
    const targetPlan = isSuperadmin
      ? normalizePlanName(plan || "PLAN A")
      : await getCurrentGlobalPlan();

    const buses = await Bus.find({
      $or: [{ status: "active" }, { altered_to_bus_id: { $ne: null } }],
    }).sort({
      bus_no: 1,
      preview_number: 1,
    });
    const busesWithPlanById = new Map();
    for (const bus of buses) {
      const mappedBus = await resolvePlanMappingBus(bus, targetPlan);
      const routes = await getRoutesForBus(mappedBus);
      if (hasRouteForPlan(routes, targetPlan)) {
        const locationBus = bus.altered_to_bus_id ? bus : mappedBus;
        const effectiveBus = await resolveEffectiveBus(locationBus);
        busesWithPlanById.set(String(effectiveBus._id), effectiveBus);
      }
    }
    const busesWithPlan = [...busesWithPlanById.values()];

    const liveLocations = await BusLiveLocation.find({
      bus_id: { $in: busesWithPlan.map((bus) => bus._id) },
    });
    const locationMap = new Map(
      liveLocations.map((loc) => [loc.bus_id.toString(), loc]),
    );

    const response = busesWithPlan.map((bus) => {
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

    const bus = await Bus.findOne({ bus_no: normalizeBusNumber(busNo) });
    if (!bus) {
      return res.status(404).json({ error: `Bus ${busNo} not found` });
    }
    if (await findActiveChangeForBus(bus._id)) {
      return res.status(409).json({
        success: false,
        error: "Roll back the temporary bus change before deleting this bus.",
      });
    }

    await User.updateMany(
      { bus_no: new RegExp(`^${escapeRegExp(bus.bus_no)}$`, "i") },
      { $set: { bus_no: null } },
    );
    await PlanMapping.updateMany(
      { member_bus_ids: bus._id },
      { $pull: { member_bus_ids: bus._id } },
    );
    await PlanMapping.deleteMany({ root_bus_id: bus._id });
    await Bus.updateMany(
      { altered_to_bus_id: bus._id },
      {
        $set: {
          altered_to_bus_id: null,
          altered_to_preview: null,
          alteration_type: null,
          alteration_route_source: null,
          alteration_routes: [],
          combined_route_source: null,
          combined_routes: [],
          altered_at: null,
        },
      },
    );
    await BusRoute.deleteMany({ bus_id: bus._id });
    await BusLiveLocation.deleteMany({ bus_id: bus._id });
    await Bus.deleteOne({ _id: bus._id });

    res.json({
      success: true,
      message: "Bus and its database records deleted successfully",
    });
  } catch (error) {
    console.error("Delete bus error:", error);
    res.status(500).json({ error: error.message });
  }
}

// ================= ACTIVATE BUS =================
async function activateBus(req, res) {
  try {
    const { busNo } = req.params;
    const bus = await Bus.findOne({ bus_no: normalizeBusNumber(busNo) });
    if (!bus) return res.status(404).json({ error: "Bus not found" });
    if (await findActiveChangeForBus(bus._id)) {
      return res.status(409).json({
        success: false,
        error: "Roll back the temporary bus change before changing this bus status.",
      });
    }

    bus.status = "active";
    await bus.save();
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
    const bus = await Bus.findOne({ bus_no: normalizeBusNumber(busNo) });
    if (!bus) return res.status(404).json({ error: "Bus not found" });
    if (await findActiveChangeForBus(bus._id)) {
      return res.status(409).json({
        success: false,
        error: "Roll back the temporary bus change before changing this bus status.",
      });
    }

    bus.status = "inactive";
    await bus.save();
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
    const bus = await Bus.findOne({ bus_no: normalizeBusNumber(busNo) });
    if (!bus) return res.status(404).json({ success: false, error: "Bus not found." });
    if (await findActiveChangeForBus(bus._id)) {
      return res.status(409).json({
        success: false,
        error: "Roll back the temporary bus change before editing this bus.",
      });
    }

    bus.preview_number = previewNumber;
    await bus.save();

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
      ...(isSuperadmin ? { activePlan, planNames: DEFAULT_PLAN_NAMES } : {}),
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

    const previousPlan = await getCurrentGlobalPlan();
    if (previousPlan === normalized) {
      return res.json({
        success: true,
        message: "Global active route updated successfully.",
        activePlan: normalized,
        planNames: DEFAULT_PLAN_NAMES,
      });
    }

    const mappingState = await loadPlanState();
    const notifications = getPlanChangeNotifications(mappingState, normalized);

    const updated = await AppSetting.findOneAndUpdate(
      { key: GLOBAL_ACTIVE_PLAN_KEY },
      { key: GLOBAL_ACTIVE_PLAN_KEY, value: normalized },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    if (notifications.length) {
      await Notification.insertMany(notifications);
    }

    const io = getIO();
    if (io) {
      // Do not broadcast the active plan value to all connected clients (privacy).
      // Send per-user notifications without including the plan name. Admin UIs should fetch
      // the global plan via the protected API (superadmin only).
      io.emit("bus-update", { actionType: "PLAN_CHANGED" });
      notifications.forEach((notification) => {
        io.to(`user_${String(notification.user_id)}`).emit("notification", {
          type: notification.type,
          message: notification.message,
          newPreview: notification.new_preview,
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

function normalizeAlterationRoutes(routesByPlan) {
  if (
    !routesByPlan ||
    typeof routesByPlan !== "object" ||
    Array.isArray(routesByPlan)
  ) {
    return null;
  }

  const routes = [];
  for (const [rawPlanName, stops] of Object.entries(routesByPlan)) {
    const plan_name = normalizePlanName(rawPlanName);
    if (!DEFAULT_PLAN_NAMES.includes(plan_name) || !Array.isArray(stops)) {
      return null;
    }
    for (const stop of stops) {
      const stop_name =
        typeof stop?.stop_name === "string" ? stop.stop_name.trim() : "";
      const stop_order = Number(stop?.stop_order);
      const stopId = String(stop?.stopId || "").trim();
      const arrival_time = normalizeArrivalTime(stop?.arrival_time);
      if (!stop_name || !Number.isInteger(stop_order) || stop_order < 1) {
        return null;
      }
      routes.push({
        plan_name,
        stop_name,
        stop_order,
        stopId: stopId || null,
        arrival_time,
      });
    }
  }
  return routes.length ? routes : null;
}

function snapshotBus(bus) {
  return {
    busId: bus._id,
    busNo: bus.bus_no,
    status: bus.status,
    alteredToBusId: bus.altered_to_bus_id ?? null,
    alteredToPreview: bus.altered_to_preview ?? null,
    alterationType: bus.alteration_type ?? null,
    alterationRouteSource: bus.alteration_route_source ?? null,
    alterationRoutes: (bus.alteration_routes || []).map((route) =>
      typeof route.toObject === "function" ? route.toObject() : { ...route },
    ),
    alteredAt: bus.altered_at ?? null,
    combinedRouteSource: bus.combined_route_source ?? null,
    combinedRoutes: (bus.combined_routes || []).map((route) =>
      typeof route.toObject === "function" ? route.toObject() : { ...route },
    ),
  };
}

function restoreBusSnapshot(bus, snapshot) {
  bus.status = snapshot.status;
  bus.altered_to_bus_id = snapshot.alteredToBusId;
  bus.altered_to_preview = snapshot.alteredToPreview;
  bus.alteration_type = snapshot.alterationType;
  bus.alteration_route_source = snapshot.alterationRouteSource;
  bus.alteration_routes = snapshot.alterationRoutes;
  bus.altered_at = snapshot.alteredAt;
  bus.combined_route_source = snapshot.combinedRouteSource;
  bus.combined_routes = snapshot.combinedRoutes;
}

async function findActiveChangeForBus(busId) {
  return BusChange.findOne({
    status: { $in: ["applying", "active"] },
    $or: [{ sourceBusId: busId }, { targetBusId: busId }],
  }).select("_id");
}

async function notifyBusChange(user, {
  type,
  message,
  oldBusNo = null,
  newBusNo = null,
  oldPreview = null,
  newPreview = null,
  assignmentBusNo = null,
}) {
  await Notification.create({
    user_id: user._id,
    type,
    message,
    old_bus_no: oldBusNo,
    new_bus_no: newBusNo,
    old_preview: oldPreview,
    new_preview: newPreview,
  });
  const io = getIO();
  if (io) {
    io.to(`user_${String(user._id)}`).emit("notification", {
      type,
      message,
      oldPreview,
      newPreview,
      assignmentBusNo,
    });
  }
}

async function getTemporaryBusChanges(req, res) {
  try {
    const activeChanges = await BusChange.find({
      status: { $in: ["applying", "active"] },
    }).sort({ createdAt: -1 }).lean();
    const recordedSourceIds = new Set(
      activeChanges.map((change) => String(change.sourceBusId)),
    );
    const legacyAlterations = await Bus.find({
      alteration_type: "alter",
      altered_to_bus_id: { $ne: null },
    })
      .select("bus_no preview_number altered_to_bus_id altered_to_preview altered_at")
      .sort({ altered_at: -1 })
      .lean();

    const changes = activeChanges.map((change) => ({
      id: String(change._id),
      type: change.type,
      status: change.status,
      sourceBusNo: change.sourceBusNo,
      sourcePreview: change.sourcePreview,
      targetBusNo: change.targetBusNo,
      targetPreview: change.targetPreview,
      routeSource: change.routeSource,
      affectedUsersCount: change.affectedUsersCount,
      createdAt: change.createdAt,
      legacy: false,
    }));
    for (const bus of legacyAlterations) {
      if (recordedSourceIds.has(String(bus._id))) continue;
      const target = await Bus.findById(bus.altered_to_bus_id)
        .select("bus_no preview_number")
        .lean();
      const riders = await findStudentsAssignedToBus(bus);
      changes.push({
        id: `legacy:${bus.bus_no}`,
        type: "alter",
        status: "active",
        sourceBusNo: bus.bus_no,
        sourcePreview: bus.preview_number,
        targetBusNo: target?.bus_no ?? null,
        targetPreview: target?.preview_number ?? bus.altered_to_preview,
        routeSource: null,
        affectedUsersCount: riders.length,
        createdAt: bus.altered_at,
        legacy: true,
      });
    }

    return res.json({ success: true, changes });
  } catch (error) {
    console.error("getTemporaryBusChanges error:", error);
    return res.status(500).json({
      success: false,
      error: "Could not load temporary bus changes.",
    });
  }
}

async function rollbackTemporaryBusChange(req, res) {
  try {
    const change = await BusChange.findById(req.params.changeId);
    if (!change || !["applying", "active"].includes(change.status)) {
      return res.status(404).json({
        success: false,
        error: "Active temporary bus change not found.",
      });
    }

    const buses = await Bus.find({
      _id: { $in: change.busSnapshots.map((snapshot) => snapshot.busId) },
    });
    const busesById = new Map(buses.map((bus) => [String(bus._id), bus]));
    const users = await User.find({
      _id: { $in: change.assignmentSnapshots.map((snapshot) => snapshot.userId) },
    }).select("_id bus_no role is_active");
    const usersById = new Map(users.map((user) => [String(user._id), user]));
    if (buses.length !== change.busSnapshots.length) {
      return res.status(409).json({
        success: false,
        error: "A bus involved in this temporary change no longer exists; rollback cannot safely restore it.",
      });
    }
    if (change.type === "combine") {
      const sourceBus = busesById.get(String(change.sourceBusId));
      const currentRiders = await findStudentsAssignedToBus(sourceBus);
      if (currentRiders.length) {
        return res.status(409).json({
          success: false,
          error: `Bus ${change.sourcePreview ?? change.sourceBusNo} now has ${currentRiders.length} rider(s). Reassign them so the bus has 0 riders before rolling back this combination.`,
        });
      }
    }

    const assignmentConflicts = change.assignmentSnapshots.filter((snapshot) => {
      const user = usersById.get(String(snapshot.userId));
      if (!user) return false;
      const current = user.bus_no ? String(user.bus_no).toUpperCase() : null;
      const before = snapshot.beforeBusNo
        ? String(snapshot.beforeBusNo).toUpperCase()
        : null;
      const after = snapshot.afterBusNo
        ? String(snapshot.afterBusNo).toUpperCase()
        : null;
      return current !== before && current !== after;
    });
    if (assignmentConflicts.length) {
      return res.status(409).json({
        success: false,
        error: `${assignmentConflicts.length} affected rider(s) have since been reassigned. Resolve those assignments before rolling back.`,
      });
    }

    const newerChanges = await BusChange.find({
      _id: { $ne: change._id },
      status: { $in: ["applying", "active"] },
      $or: [
        { createdAt: { $gt: change.createdAt } },
        { createdAt: change.createdAt, _id: { $gt: change._id } },
      ],
      $and: [
        {
          $or: [
            { sourceBusId: { $in: change.busSnapshots.map((snapshot) => snapshot.busId) } },
            { targetBusId: { $in: change.busSnapshots.map((snapshot) => snapshot.busId) } },
          ],
        },
      ],
    }).select("_id");
    if (newerChanges.length) {
      return res.status(409).json({
        success: false,
        error: "Roll back the newer temporary change using this bus first, then retry.",
      });
    }

    for (const snapshot of change.busSnapshots) {
      const bus = busesById.get(String(snapshot.busId));
      restoreBusSnapshot(bus, snapshot);
      await bus.save();
    }

    const restoredBusByNo = new Map(
      change.busSnapshots.map((snapshot) => [
        String(snapshot.busNo).toUpperCase(),
        snapshot.busNo,
      ]),
    );
    for (const snapshot of change.assignmentSnapshots) {
      const user = usersById.get(String(snapshot.userId));
      if (!user) continue;
      user.bus_no = snapshot.beforeBusNo
        ? restoredBusByNo.get(String(snapshot.beforeBusNo).toUpperCase()) || snapshot.beforeBusNo
        : null;
      await user.save();
    }

    change.status = "rolled_back";
    change.rolledBackAt = new Date();
    await change.save();

    for (const snapshot of change.assignmentSnapshots) {
      const user = usersById.get(String(snapshot.userId));
      if (!user) continue;
      const restoredBus = snapshot.beforeBusNo
        ? buses.find((bus) =>
          [bus.bus_no, bus.preview_number].some(
            (identifier) =>
              String(identifier || "").toUpperCase() ===
              String(snapshot.beforeBusNo).toUpperCase(),
          ),
        )
        : null;
      const message = restoredBus
        ? `The temporary bus change has ended. Your previous assignment to Bus ${restoredBus.preview_number ?? restoredBus.bus_no} is restored.`
        : "The temporary bus change has ended. You do not have a bus assignment; please contact administration.";
      await notifyBusChange(user, {
        type: restoredBus ? "bus_change_rolled_back" : "bus_unassigned",
        message,
        oldBusNo: snapshot.afterBusNo,
        newBusNo: snapshot.beforeBusNo,
        oldPreview: change.targetPreview,
        newPreview: restoredBus?.preview_number ?? null,
        assignmentBusNo: snapshot.beforeBusNo,
      });
    }

    const io = getIO();
    if (io) {
      io.emit("bus-update", {
        actionType: "BUS_RESTORED",
        previewNumber: change.sourcePreview,
      });
    }
    return res.json({
      success: true,
      message: `Bus ${change.sourcePreview ?? change.sourceBusNo} restored to its normal service.`,
      notifiedStudents: change.assignmentSnapshots.length,
    });
  } catch (error) {
    console.error("rollbackTemporaryBusChange error:", error);
    return res.status(500).json({
      success: false,
      error: "Could not roll back this temporary bus change.",
    });
  }
}

async function changeBus(req, res, alterationType) {
  let change;
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
    if (!sourceBus.preview_number || !targetBus.preview_number) {
      return res.status(400).json({
        success: false,
        error: 'Both buses need a preview number before they can be changed.',
      });
    }
    if (sourceBus.combined_route_source || targetBus.combined_route_source) {
      return res.status(409).json({
        success: false,
        error: "Rollback the existing temporary bus change before using either bus again.",
      });
    }
    const activeChanges = await BusChange.find({
      status: { $in: ["applying", "active"] },
    }).select("sourceBusId targetBusId type status").lean();
    const activeChangeBusIds = new Set(
      activeChanges.flatMap((change) => [
        String(change.sourceBusId),
        String(change.targetBusId),
      ]),
    );
    const sourceCanBeReused = isReusableTemporaryChangeSource(
      activeChanges,
      sourceBus._id,
    );
    const targetCanBeReused = isReusableTemporaryChangeSource(
      activeChanges,
      targetBus._id,
    );
    if (
      (targetBus.status !== "active" || targetBus.altered_to_bus_id) &&
      !targetCanBeReused
    ) {
      return res.status(400).json({
        success: false,
        error: "Choose an active bus or an empty source bus from a temporary change.",
      });
    }
    if (
      (activeChangeBusIds.has(String(sourceBus._id)) && !sourceCanBeReused) ||
      (activeChangeBusIds.has(String(targetBus._id)) && !targetCanBeReused)
    ) {
      return res.status(409).json({
        success: false,
        error: "Only an empty source bus from an active temporary change can be reused. Roll back other temporary changes before using these buses.",
      });
    }
    const legacyAlterations = await Bus.find({
      alteration_type: "alter",
      altered_to_bus_id: { $ne: null },
    }).select("_id altered_to_bus_id").lean();
    const recordedSourceIds = new Set(activeChanges.map((change) => String(change.sourceBusId)));
    const legacyTargetIds = new Set(
      legacyAlterations
        .filter((bus) => !recordedSourceIds.has(String(bus._id)))
        .map((bus) => String(bus.altered_to_bus_id)),
    );
    if (
      legacyTargetIds.has(String(sourceBus._id)) ||
      legacyTargetIds.has(String(targetBus._id))
    ) {
      return res.status(409).json({
        success: false,
        error: "This bus is already supporting a legacy alteration. Restore that bus before using it here.",
      });
    }

    const { routeSource, routesByPlan } = req.body || {};
    const activePlan = await getCurrentGlobalPlan();
    const isCombined = alterationType === "combine";
    if (!isCombined && routeSource !== undefined) {
      return res.status(400).json({
        success: false,
        error: "Altering a bus changes its location only; its original stops cannot be changed.",
      });
    }
    if (isCombined && !["source", "target", "custom"].includes(routeSource)) {
      return res.status(400).json({
        success: false,
        error: "Choose the source bus route, target bus route, or upload a custom route before combining.",
      });
    }
    if (
      routeSource !== undefined &&
      !["source", "target", "custom"].includes(routeSource)
    ) {
      return res.status(400).json({
        success: false,
        error: "Choose routes from this bus, the replacement bus, or an upload.",
      });
    }
    let alterationRoutes = [];
    if (routeSource === "custom") {
      try {
        alterationRoutes = normalizeAlterationRoutes(routesByPlan);
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error.message,
        });
      }
    }
    if (routeSource === "custom" && !alterationRoutes) {
      return res.status(400).json({
        success: false,
        error: "Upload a valid route file containing at least one stop.",
      });
    }
    if (
      routeSource === "custom" &&
      !hasRouteForPlan(alterationRoutes, activePlan)
    ) {
      return res.status(409).json({
        success: false,
        error: "The uploaded routes need stops for today's active service.",
      });
    }
    if (routeSource === "custom") {
      const routeStops = await StopMaster.find({})
        .select("stopId name")
        .lean();
      const stopsById = new Map(routeStops.map((stop) => [stop.stopId, stop]));
      const stopsByName = new Map();
      routeStops.forEach((stop) => {
        const key = normalizeStopName(stop.name);
        stopsByName.set(key, [...(stopsByName.get(key) || []), stop]);
      });
      const createdStops = new Map();
      for (const route of alterationRoutes) {
        let stop = route.stopId ? stopsById.get(route.stopId) : null;
        const key = normalizeStopName(route.stop_name);
        if (!stop) {
          const matches = stopsByName.get(key) || [];
          if (matches.length > 1) {
            return res.status(400).json({
              success: false,
              error: `Stop "${route.stop_name}" matches multiple Stop Master names.`,
            });
          }
          stop = matches[0] || createdStops.get(key);
        }
        if (!stop) {
          stop = await StopMaster.create({
            stopId: `STOP-${randomUUID()}`,
            name: route.stop_name.trim().replace(/\s+/g, " "),
            source: "EXISTING_STOP",
            status: "PENDING",
          });
          createdStops.set(key, stop);
        }
        route.stopId = stop.stopId;
        route.stop_name = stop.name;
      }
    }
    let selectedRoutes = [];
    if (routeSource === "source" || routeSource === "target") {
      const selectedRouteBus = routeSource === "source" ? sourceBus : targetBus;
      selectedRoutes = await getEffectiveRoutesForAllPlans(selectedRouteBus);
      if (!selectedRoutes.length) {
        return res.status(400).json({
          success: false,
          error: `Bus ${selectedRouteBus.preview_number ?? selectedRouteBus.bus_no} has no uploaded routes. Choose another route option or upload new routes.`,
        });
      }
    } else if (routeSource === "custom") {
      selectedRoutes = alterationRoutes;
    }

    if (!isCombined) {
      const incomingAlterations = await Bus.countDocuments({
        altered_to_bus_id: targetBus._id,
        alteration_type: "alter",
      });
      if (incomingAlterations) {
        return res.status(400).json({
          success: false,
          error: "This replacement bus is already in use for an altered bus and cannot replace another bus.",
        });
      }
      const sourceRoutes = await getRoutesForBus(sourceBus);
      if (!hasRouteForPlan(sourceRoutes, activePlan)) {
        return res.status(409).json({
          success: false,
          error: "This bus has no active stops for today's service. Map its users to an available bus first.",
        });
      }
    } else if (!hasRouteForPlan(selectedRoutes, activePlan)) {
      return res.status(409).json({
        success: false,
        error: "The selected route has no stops for today's service. Choose another route or map the users to an available bus.",
      });
    }

    const sourceUsers = await findStudentsAssignedToBus(sourceBus);
    const targetUsers = await findStudentsAssignedToBus(targetBus);
    if (!isCombined && sourceUsers.length === 0) {
      return res.status(409).json({
        success: false,
        error: "Choose a source bus with riders to move to the replacement bus.",
      });
    }
    if (!isCombined && targetUsers.length > 0) {
      return res.status(409).json({
        success: false,
        error: `Replacement Bus ${targetBus.preview_number ?? targetBus.bus_no} has ${targetUsers.length} rider(s). Choose a replacement bus with 0 riders.`,
      });
    }
    if (
      (sourceCanBeReused && sourceUsers.length > 0) ||
      (targetCanBeReused && targetUsers.length > 0)
    ) {
      const bus = sourceCanBeReused && sourceUsers.length
        ? sourceBus
        : targetBus;
      const count = bus === sourceBus ? sourceUsers.length : targetUsers.length;
      return res.status(409).json({
        success: false,
        error: `Bus ${bus.preview_number ?? bus.bus_no} has ${count} rider(s) and cannot be reused until it has 0 riders.`,
      });
    }
    const assignmentByUserId = new Map(
      sourceUsers.map((user) => [String(user._id), targetBus.bus_no]),
    );

    const assignmentSnapshots = [
      ...sourceUsers,
      ...targetUsers,
    ].map((user) => ({
      userId: user._id,
      beforeBusNo: user.bus_no ?? null,
      afterBusNo: assignmentByUserId.has(String(user._id))
        ? assignmentByUserId.get(String(user._id))
        : user.bus_no ?? null,
    }));
    const busSnapshots = [snapshotBus(sourceBus), snapshotBus(targetBus)];
    change = await BusChange.create({
      type: alterationType,
      status: "applying",
      sourceBusId: sourceBus._id,
      sourceBusNo: sourceBus.bus_no,
      sourcePreview: sourceBus.preview_number,
      targetBusId: targetBus._id,
      targetBusNo: targetBus.bus_no,
      targetPreview: targetBus.preview_number,
      routeSource: isCombined ? routeSource : null,
      busSnapshots,
      assignmentSnapshots,
      affectedUsersCount: assignmentSnapshots.length,
    });

    if (targetCanBeReused) {
      targetBus.status = "active";
      targetBus.altered_to_bus_id = null;
      targetBus.altered_to_preview = null;
      targetBus.alteration_type = null;
      targetBus.alteration_route_source = null;
      targetBus.alteration_routes = [];
      targetBus.altered_at = null;
      targetBus.combined_route_source = null;
      targetBus.combined_routes = [];
      await targetBus.save();
    }

    if (isCombined) {
      targetBus.combined_route_source = routeSource;
      targetBus.combined_routes = selectedRoutes.map((route) => ({
        plan_name: route.plan_name,
        stop_name: route.stop_name,
        stop_order: route.stop_order,
        stopId: route.stopId || null,
        arrival_time: route.arrival_time || null,
      }));
      await targetBus.save();
      sourceBus.status = "active";
      sourceBus.altered_to_bus_id = null;
      sourceBus.altered_to_preview = null;
      sourceBus.alteration_type = null;
      sourceBus.alteration_route_source = null;
      sourceBus.alteration_routes = [];
      sourceBus.altered_at = null;
      sourceBus.combined_route_source = null;
      sourceBus.combined_routes = [];
      await sourceBus.save();
    } else {
      sourceBus.status = "inactive";
      sourceBus.altered_to_bus_id = targetBus._id;
      sourceBus.altered_to_preview = targetBus.preview_number ?? null;
      sourceBus.alteration_type = "alter";
      sourceBus.alteration_route_source = null;
      sourceBus.alteration_routes = [];
      sourceBus.altered_at = new Date();
      await sourceBus.save();
    }

    for (const [userId, busNo] of assignmentByUserId) {
      await User.updateOne(
        { _id: userId },
        { $set: { bus_no: busNo } },
      );
    }
    if (isCombined) {
      const remainingSourceUsers = await findStudentsAssignedToBus(sourceBus);
      if (remainingSourceUsers.length) {
        change.status = "active";
        await change.save();
        return res.status(409).json({
          success: false,
          error: `Combination is incomplete: ${remainingSourceUsers.length} rider(s) remain on source Bus ${sourceBus.preview_number ?? sourceBus.bus_no}. Reassign them so it has 0 riders, then retry or roll back.`,
        });
      }
    }

    const uniqueUsers = new Map(
      [...sourceUsers, ...targetUsers].map((user) => [String(user._id), user]),
    );
    const previewMessage = isCombined
      ? `For your bus service, use Bus ${targetBus.preview_number}. Follow ${
          routeSource === "source"
            ? `Bus ${sourceBus.preview_number}'s`
            : routeSource === "target"
              ? `Bus ${targetBus.preview_number}'s`
              : "the uploaded combined route's"
        } stops and timings; open Home and tap View Stops to see the route.`
      : `For your bus service, use Bus ${targetBus.preview_number}. Continue following Bus ${sourceBus.preview_number}'s original stops and timings; open Home and tap View Stops to see them.`;
    for (const user of uniqueUsers.values()) {
      const isSourceRider = sourceUsers.some(
        (sourceUser) => String(sourceUser._id) === String(user._id),
      );
      if (isSourceRider) {
        await notifyBusChange(user, {
          type: isCombined ? "bus_combined" : "bus_altered",
          message: isCombined
            ? previewMessage
            : `For your bus service, use Bus ${targetBus.preview_number}. Continue following Bus ${sourceBus.preview_number}'s original stops and timings; open Home and tap View Stops to see them.`,
          oldBusNo: sourceBus.bus_no,
          newBusNo: targetBus.bus_no,
          oldPreview: sourceBus.preview_number,
          newPreview: targetBus.preview_number,
          assignmentBusNo: targetBus.bus_no,
        });
        continue;
      }
      await notifyBusChange(user, {
        type: isCombined ? "bus_combined" : "bus_altered",
        message: previewMessage,
        oldBusNo: sourceBus.bus_no,
        newBusNo: targetBus.bus_no,
        oldPreview: sourceBus.preview_number,
        newPreview: targetBus.preview_number,
        assignmentBusNo:
          assignmentByUserId.get(String(user._id)) ?? user.bus_no,
      });
    }
    change.status = "active";
    await change.save();

    const io = getIO();
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
      notifiedStudents: uniqueUsers.size,
      temporaryChangeId: String(change._id),
    });
  } catch (error) {
    console.error(`${alterationType} bus error:`, error);
    if (change && change.status !== "rolled_back") {
      change.status = "active";
      try {
        await change.save();
      } catch (recordError) {
        console.error("Could not mark partial bus change for rollback:", recordError);
      }
    }
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
    if (await findActiveChangeForBus(bus._id)) {
      return res.status(409).json({
        success: false,
        error: "Use the temporary bus changes page to roll back this operation.",
      });
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
    bus.alteration_route_source = null;
    bus.alteration_routes = [];
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
    const activePlan = await getCurrentGlobalPlan();
    const isSuperadmin =
      req.user && String(req.user.role || "").toLowerCase() === "superadmin";
    const assignment = await resolvePlanMappingAssignment(bus, activePlan);
    const mappedBus = assignment.routeBus;
    const locationBus = assignment.locationBus;
    const routes = isSuperadmin
      ? await getEffectiveRoutesForAllPlans(bus)
      : await getRoutesForBus(mappedBus);
    const incomingChanges = await getIncomingBusChanges(bus);
    const routeSelectionLabel = await getRouteSelectionLabel(
      bus,
      incomingChanges,
    );
    const routeBusPreviewNumber =
      mappedBus._id.equals(bus._id)
        ? (
      incomingChanges.find((changedBus) => changedBus.alteration_type === "alter")
        ?.preview_number ?? bus.preview_number
          )
        : mappedBus.preview_number;
    const isReplacementRoute = incomingChanges.some(
      (changedBus) => changedBus.alteration_type === "alter",
    );

    const plansMap = {};
    for (const r of routes) {
      if (!plansMap[r.plan_name]) plansMap[r.plan_name] = [];
      plansMap[r.plan_name].push({
        stopId: r.stopId,
        stop_name: r.stop_name,
        stop_order: r.stop_order,
        arrival_time: r.arrival_time || null,
        latitude: r.latitude,
        longitude: r.longitude,
        stopStatus: r.stopStatus,
      });
    }

    const activePlanKey = Object.keys(plansMap).find(
      (name) => normalizePlanName(name) === normalizePlanName(activePlan),
    );
    const isBusActiveInCurrentPlan = hasRouteForPlan(routes, activePlan);

    res.json({
      success: true,
      busNo: isSuperadmin ? bus.bus_no : String(bus.preview_number ?? bus.bus_no),
      previewNumber: bus.preview_number,
      effectivePreviewNumber: locationBus.preview_number,
      routeBusPreviewNumber,
      isReplacementRoute,
      routeSelectionLabel,
      isBusActiveInCurrentPlan: !!isBusActiveInCurrentPlan,
      notActiveMessage: isBusActiveInCurrentPlan ? null : getInactivePlanMessage(activePlan),
      ...(isSuperadmin ? { plans: plansMap } : {}),
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

    const bus = await Bus.findOne({ bus_no: normalizeBusNumber(busNo) });
    if (!bus) {
      return res
        .status(404)
        .json({ success: false, error: `Bus ${busNo} not found` });
    }

    if (previewNumber !== undefined) {
      if (previewNumber !== null && previewNumber !== "") {
        const exists = await Bus.findOne({
          preview_number: previewNumber,
          bus_no: { $ne: bus.bus_no },
        });
        if (exists) {
          return res
            .status(400)
            .json({ success: false, error: "Preview number already in use" });
        }
      }
      bus.preview_number = previewNumber || null;
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

    const effectiveRoutes = await getRoutesForBus(bus);
    res.json({
      plans: [...new Set(effectiveRoutes.map((route) => route.plan_name))].sort(),
      stops: effectiveRoutes.length,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ================= GET LIVE LOCATION =================
async function getLiveLocation(req, res) {
  try {
    const { busNo } = req.params;
    const normalizedBusNo = normalizeBusNumber(busNo ?? "");

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

    const activePlan = await getCurrentGlobalPlan();
    const assignment = await resolvePlanMappingAssignment(bus, activePlan);
    const mappedBus = assignment.routeBus;
    const locationBus = assignment.hasTemporaryLocationBus
      ? assignment.locationBus
      : bus.altered_to_bus_id
        ? bus
        : mappedBus;
    const effectiveBus = assignment.hasTemporaryLocationBus
      ? assignment.locationBus
      : await resolveEffectiveBus(locationBus);
    const incomingChanges = await getIncomingBusChanges(bus);
    const alteration = assignment.hasTemporaryLocationBus
      ? {
          isAltered: true,
          alterationType: "plan_mapping",
          message: `For today's service, use Bus ${effectiveBus.preview_number ?? effectiveBus.bus_no}. Follow Bus ${mappedBus.preview_number ?? mappedBus.bus_no}'s stops and timings; open Home and tap View Stops to see the route.`,
          newPreview: effectiveBus.preview_number ?? null,
          effectivePreview: effectiveBus.preview_number ?? null,
        }
      : !mappedBus._id.equals(bus._id)
      ? {
          isAltered: true,
          alterationType: "plan_mapping",
          message: `For today's service, use Bus ${effectiveBus.preview_number ?? mappedBus.preview_number ?? "the assigned bus"}. Follow Bus ${mappedBus.preview_number ?? mappedBus.bus_no}'s stops and timings; open Home and tap View Stops to see the route.`,
          newPreview: effectiveBus.preview_number ?? null,
          effectivePreview: effectiveBus.preview_number ?? null,
        }
      : buildAlterationDetails(bus, effectiveBus) ||
        buildReplacementDetails(bus, incomingChanges);
    const location = await BusLiveLocation.findOne({ bus_id: effectiveBus._id });
    const routes = await getRoutesForBus(mappedBus);
    const routeSelectionLabel = await getRouteSelectionLabel(
      bus,
      incomingChanges,
    );
    const routeBusPreviewNumber = mappedBus._id.equals(bus._id)
      ? incomingChanges.find((changedBus) => changedBus.alteration_type === "alter")
        ?.preview_number ?? bus.preview_number
      : mappedBus.preview_number;
    const isReplacementRoute = incomingChanges.some(
      (changedBus) => changedBus.alteration_type === "alter",
    );
    const activeStops = routes
      .filter(
        (route) =>
          normalizePlanName(route?.plan_name) === normalizePlanName(activePlan),
      )
      .map(
        ({
          stopId,
          stop_name,
          stop_order,
          latitude,
          longitude,
          stopStatus,
          arrival_time,
        }) => ({
          stopId,
          stop_name,
          stop_order,
          latitude,
          longitude,
          stopStatus,
          arrival_time,
        }),
      );
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
      isBusActiveInCurrentPlan: !!isBusActiveInCurrentPlan,
      notActiveMessage: isBusActiveInCurrentPlan
        ? null
        : getInactivePlanMessage(activePlan),
      previewNumber: effectiveBus.preview_number,
      effectivePreviewNumber: effectiveBus.preview_number,
      ...(isSuperadmin ? { effectiveBusNo: effectiveBus.bus_no } : {}),
      routeBusPreviewNumber,
      isReplacementRoute,
      routeSelectionLabel,
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

    const activePlan = await getCurrentGlobalPlan();
    const assignment = await resolvePlanMappingAssignment(bus, activePlan);
    const mappedBus = assignment.routeBus;
    const locationBus = assignment.hasTemporaryLocationBus
      ? assignment.locationBus
      : bus.altered_to_bus_id
        ? bus
        : mappedBus;
    const effectiveBus = assignment.hasTemporaryLocationBus
      ? assignment.locationBus
      : await resolveEffectiveBus(locationBus);
    const incomingChanges = await getIncomingBusChanges(bus);
    const alteration = assignment.hasTemporaryLocationBus
      ? {
          isAltered: true,
          alterationType: "plan_mapping",
          message:
            `Bus: Uses Bus ${effectiveBus.preview_number ?? effectiveBus.bus_no} location\n` +
            `Stops: Uses Bus ${mappedBus.preview_number ?? mappedBus.bus_no} stops; find them on the Home page.\n` +
            "If you have any doubts, ask your administration.",
          newPreview: effectiveBus.preview_number ?? null,
          effectivePreview: effectiveBus.preview_number ?? null,
        }
      : !mappedBus._id.equals(bus._id)
      ? {
          isAltered: true,
          alterationType: "plan_mapping",
          message:
            `Bus: Uses Bus ${effectiveBus.preview_number ?? mappedBus.preview_number ?? "the assigned bus"} location\n` +
            `Stops: Uses Bus ${mappedBus.preview_number ?? mappedBus.bus_no} stops; find them on the Home page.\n` +
            "If you have any doubts, ask your administration.",
          newPreview: effectiveBus.preview_number ?? null,
          effectivePreview: effectiveBus.preview_number ?? null,
        }
      : buildAlterationDetails(bus, effectiveBus) ||
        buildReplacementDetails(bus, incomingChanges);
    const location = await BusLiveLocation.findOne({ bus_id: effectiveBus._id });
    const routes = await getRoutesForBus(mappedBus);
    const routeSelectionLabel = await getRouteSelectionLabel(
      bus,
      incomingChanges,
    );
    const routeBusPreviewNumber = mappedBus._id.equals(bus._id)
      ? incomingChanges.find((changedBus) => changedBus.alteration_type === "alter")
        ?.preview_number ?? bus.preview_number
      : mappedBus.preview_number;
    const isReplacementRoute = incomingChanges.some(
      (changedBus) => changedBus.alteration_type === "alter",
    );
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
      ...(isSuperadmin ? { effectiveBusNo: effectiveBus.bus_no } : {}),
      routeBusPreviewNumber,
      isReplacementRoute,
      routeSelectionLabel,
      isBusActiveInCurrentPlan: !!isBusActiveInCurrentPlan,
      notActiveMessage: isBusActiveInCurrentPlan
        ? null
        : getInactivePlanMessage(activePlan),
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
  findBusByIdentifier,
  resolveEffectiveBus,
  getCurrentGlobalPlan,
  getRoutesForBus,
  getAssignedBusRoutes,
  getIncomingBusChanges,
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
  getTemporaryBusChanges,
  rollbackTemporaryBusChange,
};
