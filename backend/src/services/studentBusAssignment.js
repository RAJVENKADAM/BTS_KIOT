"use strict";

const AppSetting = require("../models/AppSetting");
const Bus = require("../models/Bus");
const BusLiveLocation = require("../models/BusLiveLocation");
const GpsWorkerOwnership = require("../models/GpsWorkerOwnership");
const PlanMapping = require("../models/PlanMapping");
const User = require("../models/User");
const {
  getRoutesForBus,
  loadBusReadContext,
} = require("../utils/busReadContext");
const normalizeBusNumber = require("../utils/normalizeBusNumber");

const GLOBAL_ACTIVE_PLAN_KEY = "global_active_plan";
const DEFAULT_PLAN_NAMES = new Set(["PLAN A", "PLAN B", "PLAN C", "PLAN D"]);
const GPS_OFFLINE_THRESHOLD_MS =
  Number(process.env.GPS_OFFLINE_THRESHOLD_MS) || 3 * 60 * 1000;
const MAX_REPLACEMENT_DEPTH = 20;

function normalizePlanName(value) {
  const plan = String(value || "PLAN A").trim().toUpperCase();
  return DEFAULT_PLAN_NAMES.has(plan) ? plan : "PLAN A";
}

function isValidCoordinate(value, minimum, maximum) {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

function getLocationStatus(location, now = Date.now()) {
  if (
    !location ||
    !isValidCoordinate(location.latitude, -90, 90) ||
    !isValidCoordinate(location.longitude, -180, 180)
  ) {
    return "unavailable";
  }
  const providerTime = Date.parse(location.providerTimestamp);
  if (!Number.isFinite(providerTime)) return "stale";
  const age = now - providerTime;
  return location.is_online === true &&
    age <= GPS_OFFLINE_THRESHOLD_MS &&
    age >= -5 * 60 * 1000
    ? "fresh"
    : "stale";
}

async function findBusByAssignment(busNumber) {
  if (!busNumber) return null;
  const normalizedBusNo = normalizeBusNumber(busNumber);
  let bus = await Bus.findOne({ bus_no: normalizedBusNo })
    .select(
      "_id bus_no preview_number status altered_to_bus_id alteration_type",
    )
    .lean();
  if (!bus) {
    bus = await Bus.findOne({
      preview_number: { $in: [busNumber, String(busNumber)] },
    })
      .select(
        "_id bus_no preview_number status altered_to_bus_id alteration_type",
      )
      .lean();
  }
  return bus;
}

async function loadAssignmentConfig() {
  const [setting, ownership] = await Promise.all([
    AppSetting.findOne({ key: GLOBAL_ACTIVE_PLAN_KEY }).lean(),
    GpsWorkerOwnership.findById("gps-worker")
      .select("configVersion")
      .lean(),
  ]);
  return {
    activePlan: normalizePlanName(setting?.value),
    assignmentVersion:
      ownership?.configVersion == null
        ? "0"
        : String(ownership.configVersion),
  };
}

async function resolveBusAssignment(sourceBus, activePlan) {
  if (activePlan === "PLAN A") {
    return {
      routeBus: sourceBus,
      locationBus: sourceBus.altered_to_bus_id ? sourceBus : sourceBus,
    };
  }

  const mapping = await PlanMapping.findOne({
    plan_name: activePlan,
    $or: [{ root_bus_id: sourceBus._id }, { member_bus_ids: sourceBus._id }],
  })
    .select("root_bus_id location_bus_id member_bus_ids")
    .lean();
  if (!mapping) {
    return {
      routeBus: sourceBus,
      locationBus: sourceBus,
    };
  }

  const isMember = (mapping.member_bus_ids || []).some(
    (memberBusId) => String(memberBusId) === String(sourceBus._id),
  );
  const relatedIds = new Set();
  if (isMember) relatedIds.add(String(mapping.root_bus_id));
  if (mapping.location_bus_id) {
    relatedIds.add(String(mapping.location_bus_id));
  }
  const relatedBuses = relatedIds.size
    ? await Bus.find({ _id: { $in: [...relatedIds] } })
        .select(
          "_id bus_no preview_number status altered_to_bus_id alteration_type",
        )
        .lean()
    : [];
  const busesById = new Map(
    relatedBuses.map((bus) => [String(bus._id), bus]),
  );
  const routeBus = isMember
    ? busesById.get(String(mapping.root_bus_id))
    : sourceBus;
  if (!routeBus) {
    return { unavailableReason: "mapped_route_bus_missing" };
  }

  const locationBus = mapping.location_bus_id
    ? busesById.get(String(mapping.location_bus_id))
    : sourceBus.altered_to_bus_id
      ? sourceBus
      : routeBus;
  if (!locationBus) {
    return { unavailableReason: "mapped_location_bus_missing" };
  }
  return { routeBus, locationBus };
}

async function resolveReplacementBus(locationBus) {
  const visited = new Set();
  let current = locationBus;
  let depth = 0;
  while (current?.altered_to_bus_id) {
    const currentId = String(current._id);
    if (visited.has(currentId) || depth >= MAX_REPLACEMENT_DEPTH) {
      return { unavailableReason: "invalid_replacement_chain" };
    }
    visited.add(currentId);
    const replacement = await Bus.findById(current.altered_to_bus_id)
      .select(
        "_id bus_no preview_number status altered_to_bus_id alteration_type",
      )
      .lean();
    if (!replacement) {
      return { unavailableReason: "replacement_bus_missing" };
    }
    current = replacement;
    depth += 1;
  }
  if (current && visited.has(String(current._id))) {
    return { unavailableReason: "invalid_replacement_chain" };
  }
  return { effectiveBus: current };
}

function getPublicAssignmentSnapshot(assignment) {
  const { effectiveBus, routeBus, location, locationStatus } = assignment;
  const displayNumber = effectiveBus
    ? String(effectiveBus.preview_number ?? effectiveBus.bus_no)
    : null;
  const activeStops = assignment.stops || [];
  const busAvailable =
    Boolean(effectiveBus) && effectiveBus.status !== "inactive";
  const serviceAvailable = busAvailable && assignment.hasActiveRoute;

  return {
    success: true,
    assignmentStatus: assignment.assignmentStatus,
    assignmentVersion: assignment.assignmentVersion,
    assignmentRevision: assignment.assignmentRevision ?? 0,
    busNo: displayNumber,
    previewNumber: effectiveBus?.preview_number ?? null,
    effectivePreviewNumber: effectiveBus?.preview_number ?? null,
    routeBusPreviewNumber: routeBus?.preview_number ?? null,
    isReplacementRoute: Boolean(
      assignment.locationBus &&
        String(assignment.locationBus._id) !== String(effectiveBus?._id),
    ),
    isBusActiveInCurrentPlan: serviceAvailable,
    notActiveMessage: serviceAvailable
      ? null
      : assignment.assignmentStatus === "unassigned"
        ? "No bus is assigned to you for today's service."
        : "Your assigned bus or route is unavailable for today's service.",
    latitude: locationStatus === "fresh" ? location?.latitude ?? null : null,
    longitude: locationStatus === "fresh" ? location?.longitude ?? null : null,
    speed: locationStatus === "fresh" ? location?.speed ?? 0 : 0,
    status: locationStatus === "fresh" ? "online" : "offline",
    gpsStatus: locationStatus,
    source: locationStatus === "unavailable" ? "offline" : location?.source || "offline",
    lastSuccessfulGpsUpdate: location?.lastSuccessfulGpsUpdate ?? null,
    providerTimestamp: location?.providerTimestamp ?? null,
    locationVersion:
      location?.locationVersion == null
        ? null
        : String(location.locationVersion),
    lastUpdated: location?.lastSuccessfulGpsUpdate ?? null,
    gpsOfflineThresholdMs: GPS_OFFLINE_THRESHOLD_MS,
    stops: activeStops,
    hasStops: activeStops.length > 0,
  };
}

async function resolveStudentAssignmentForUser(
  user,
  { includeStops = false, config = null, coreCache = null } = {},
) {
  if (!user || user.role !== "student" || !user.is_active || user.deleted_by_user) {
    const error = new Error("Student assignment is unavailable.");
    error.code = "STUDENT_ASSIGNMENT_UNAVAILABLE";
    throw error;
  }

  const { activePlan, assignmentVersion } = config || await loadAssignmentConfig();
  const assignmentRevision = user.assignmentRevision ?? 0;
  if (!user.bus_no) {
    return {
      assignmentStatus: "unassigned",
      assignmentVersion,
      assignmentRevision,
      activePlan,
      stops: [],
      hasActiveRoute: false,
      locationStatus: "unavailable",
      publicSnapshot: null,
    };
  }

  const cacheKey = normalizeBusNumber(user.bus_no);
  let core = coreCache?.get(cacheKey);
  if (!core) {
    core = resolveBusAssignmentCore(user.bus_no, {
      activePlan,
      assignmentVersion,
      includeStops,
    });
    coreCache?.set(cacheKey, core);
  }
  const assignment = await core;
  return {
    ...assignment,
    assignmentVersion,
    assignmentRevision,
    activePlan,
    publicSnapshot: assignment.effectiveBus
      ? getPublicAssignmentSnapshot({
          ...assignment,
          assignmentVersion,
          assignmentRevision,
          activePlan,
        })
      : null,
  };
}

async function resolveBusAssignmentCore(
  busNumber,
  { activePlan, includeStops = false },
) {
  const sourceBus = await findBusByAssignment(busNumber);
  if (!sourceBus) {
    return {
      assignmentStatus: "unavailable",
      stops: [],
      hasActiveRoute: false,
      locationStatus: "unavailable",
      publicSnapshot: null,
    };
  }

  const mapping = await resolveBusAssignment(sourceBus, activePlan);
  if (mapping.unavailableReason) {
    return {
      assignmentStatus: "unavailable",
      sourceBus,
      unavailableReason: mapping.unavailableReason,
      stops: [],
      hasActiveRoute: false,
      locationStatus: "unavailable",
      publicSnapshot: null,
    };
  }

  const { effectiveBus, unavailableReason } = await resolveReplacementBus(
    mapping.locationBus,
  );
  if (unavailableReason || !effectiveBus) {
    return {
      assignmentStatus: "unavailable",
      sourceBus,
      routeBus: mapping.routeBus,
      locationBus: mapping.locationBus,
      unavailableReason: unavailableReason || "effective_bus_missing",
      stops: [],
      hasActiveRoute: false,
      locationStatus: "unavailable",
      publicSnapshot: null,
    };
  }

  const [location, context] = await Promise.all([
    BusLiveLocation.findOne({ bus_id: effectiveBus._id })
      .select(
        "latitude longitude speed is_online source providerTimestamp lastSuccessfulGpsUpdate locationVersion updatedAt",
      )
      .lean(),
    includeStops
      ? loadBusReadContext([
          sourceBus,
          mapping.routeBus,
          mapping.locationBus,
          effectiveBus,
        ])
      : Promise.resolve(null),
  ]);
  const routes = context ? getRoutesForBus(context, mapping.routeBus) : [];
  const stops = routes
    .filter(
      (route) =>
        String(route.plan_name || "").trim().toUpperCase() === activePlan,
    )
    .map((route) => ({
      stopId: route.stopId ?? null,
      stop_name: route.stop_name,
      stop_order: route.stop_order,
      arrival_time: route.arrival_time ?? null,
      latitude: route.latitude ?? null,
      longitude: route.longitude ?? null,
      stopStatus: route.stopStatus ?? null,
    }));
  const assignment = {
    assignmentStatus: effectiveBus.status === "active" ? "assigned" : "unavailable",
    sourceBus,
    routeBus: mapping.routeBus,
    locationBus: mapping.locationBus,
    effectiveBus,
    location,
    locationStatus:
      effectiveBus.status === "active"
        ? getLocationStatus(location)
        : "unavailable",
    stops,
    hasActiveRoute: stops.length > 0,
  };
  return assignment;
}

async function resolveStudentAssignment(userId, options = {}) {
  const user = await User.findById(userId)
    .select("_id role is_active deleted_by_user bus_no assignmentRevision")
    .lean();
  return resolveStudentAssignmentForUser(user, options);
}

async function resolveStudentAssignments(userIds, options = {}) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const users = await User.find({ _id: { $in: ids } })
    .select("_id role is_active deleted_by_user bus_no assignmentRevision")
    .lean();
  const config = await loadAssignmentConfig();
  const coreCache = new Map();
  const assignments = await Promise.all(
    users
      .filter(
        (user) =>
          user.role === "student" && user.is_active && !user.deleted_by_user,
      )
      .map(async (user) => [
        String(user._id),
        await resolveStudentAssignmentForUser(user, {
          ...options,
          config,
          coreCache,
        }),
      ]),
  );
  return new Map(assignments);
}

async function reconcileStudentSockets(userIds) {
  const ids = [...new Set(
    (Array.isArray(userIds) ? userIds : [userIds])
      .filter(Boolean)
      .map(String),
  )];
  if (!ids.length) return 0;

  const { getIO } = require("../socket");
  const io = getIO();
  if (!io) return 0;

  let operator = io;
  for (const id of ids) operator = operator.to(`user_${id}`);
  const sockets = await operator.fetchSockets();
  if (!sockets.length) return 0;

  const studentIds = [...new Set(
    sockets
      .filter((socket) => String(socket.user?.role || "").toLowerCase() === "student")
      .map((socket) => String(socket.user?.id || ""))
      .filter(Boolean),
  )];
  const byUserId = await resolveStudentAssignments(studentIds, {
    includeStops: true,
  });

  for (const socket of sockets) {
    const id = String(socket.user?.id || "");
    const assignment = byUserId.get(id);
    if (!assignment) {
      socket.disconnect(true);
      continue;
    }
    const oldRooms = [...(socket.rooms || [])].filter(
      (room) => room.startsWith("assigned_bus_") || room.startsWith("preview_"),
    );
    await Promise.all(oldRooms.map((room) => socket.leave(room)));
    if (
      assignment.assignmentStatus === "assigned" &&
      assignment.effectiveBus
    ) {
      await socket.join(`assigned_bus_${String(assignment.effectiveBus._id)}`);
    }
    socket.emit(
      "assigned-bus-update",
      assignment.publicSnapshot || getPublicAssignmentSnapshot(assignment),
    );
  }

  return sockets.length;
}

module.exports = {
  GPS_OFFLINE_THRESHOLD_MS,
  getLocationStatus,
  getPublicAssignmentSnapshot,
  reconcileStudentSockets,
  resolveStudentAssignment,
  resolveStudentAssignments,
};
