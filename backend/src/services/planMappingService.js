const Bus = require("../models/Bus");
const BusRoute = require("../models/BusRoute");
const PlanMapping = require("../models/PlanMapping");
const User = require("../models/User");
const {
  findUncoveredAssignments,
  getEffectiveBusId,
  getEffectiveLocationBusId,
} = require("../utils/planMapping");

function normalizeIdentifier(value) {
  return String(value ?? "").trim().toUpperCase();
}

function getServiceChangeMessage(busDisplay, routeDisplay) {
  const bus = busDisplay || "your assigned bus";
  const route = routeDisplay || bus;
  return `For today's service, use Bus ${bus}. Follow Bus ${route}'s stops and timings; open Home and tap View Stops to see the route.`;
}

function getAssignedBusDisplay(user, assignedBus) {
  return assignedBus?.preview_number ?? assignedBus?.bus_no ?? user.bus_no ?? "your assigned bus";
}

async function loadPlanState() {
  const [buses, routes, clusters, users] = await Promise.all([
    Bus.find({})
      .select("_id bus_no preview_number status altered_to_bus_id combined_routes")
      .lean(),
    BusRoute.find({}).select("bus_id plan_name arrival_time").lean(),
    PlanMapping.find({})
      .select("plan_name root_bus_id location_bus_id member_bus_ids")
      .lean(),
    User.find({
      role: "student",
      is_active: true,
      bus_no: { $nin: [null, ""] },
    })
      .select("_id bus_no")
      .lean(),
  ]);
  const plansByBusId = new Map();
  const busByIdentifier = new Map();

  for (const bus of buses) {
    const id = String(bus._id);
    plansByBusId.set(id, new Set());
    busByIdentifier.set(normalizeIdentifier(bus.bus_no), id);
    if (bus.preview_number != null) {
      busByIdentifier.set(normalizeIdentifier(bus.preview_number), id);
    }
  }
  for (const route of routes) {
    const id = String(route.bus_id);
    if (!plansByBusId.has(id)) plansByBusId.set(id, new Set());
    plansByBusId.get(id).add(String(route.plan_name).trim().toUpperCase());
  }
  for (const bus of buses) {
    for (const route of bus.combined_routes || []) {
      plansByBusId
        .get(String(bus._id))
        ?.add(String(route.plan_name).trim().toUpperCase());
    }
  }

  const busesById = Object.fromEntries(
    [...plansByBusId].map(([id, plans]) => [
      id,
      {
        plans: [...plans],
        status:
          buses.find((bus) => String(bus._id) === id)?.status === "inactive" &&
          !buses.find((bus) => String(bus._id) === id)?.altered_to_bus_id
            ? "inactive"
            : "active",
      },
    ]),
  );
  const busIdsByUser = users.map((user) =>
    busByIdentifier.get(normalizeIdentifier(user.bus_no)) || null,
  );

  return { buses, busesById, busIdsByUser, clusters, users };
}

function getCoverageErrors(state, planName, clusters = state.clusters) {
  const missingAssignments = state.busIdsByUser
    .map((busId, index) => ({ busId, user: state.users[index] }))
    .filter(({ busId }) => !busId);
  const uncoveredIds = findUncoveredAssignments(
    state.busIdsByUser.filter(Boolean),
    planName,
    clusters,
    state.busesById,
  );
  const uncovered = new Set(uncoveredIds);
  const uncoveredAssignments = state.busIdsByUser
    .map((busId, index) => ({ busId, user: state.users[index] }))
    .filter(({ busId }) => busId && uncovered.has(busId));

  const busById = new Map(state.buses.map((bus) => [String(bus._id), bus]));
  const details = [
    ...missingAssignments.map(({ user }) => ({
      userId: String(user._id),
      busNumber: user.bus_no,
    })),
    ...uncoveredAssignments.map(({ busId, user }) => ({
      userId: String(user._id),
      busNumber:
        busById.get(busId)?.preview_number ??
        busById.get(busId)?.bus_no ??
        user.bus_no,
    })),
  ];

  return details;
}

function getEffectiveBusForPlan(busId, planName, clusters, busesById) {
  const effectiveBusId = getEffectiveBusId(busId, planName, clusters);
  return busesById[effectiveBusId] ? effectiveBusId : null;
}

function getInUseLocationBusIds(busIdsByUser, planName, clusters) {
  const inUseBusIds = new Set();
  for (const busId of busIdsByUser.filter(Boolean)) {
    inUseBusIds.add(String(busId));
    inUseBusIds.add(getEffectiveBusId(busId, planName, clusters));
    inUseBusIds.add(getEffectiveLocationBusId(busId, planName, clusters));
  }
  return inUseBusIds;
}

function getClusterChangeNotifications(
  state,
  cluster,
  planName,
  routesChanged = false,
) {
  const rootBusId = String(cluster.root_bus_id);
  const locationBusId = String(cluster.location_bus_id || rootBusId);
  const serviceBusIds = new Set([
    rootBusId,
    ...(cluster.member_bus_ids || []).map(String),
  ]);
  const busById = new Map(state.buses.map((bus) => [String(bus._id), bus]));
  const rootBus = busById.get(rootBusId);
  const locationBus = busById.get(locationBusId);
  const locationPreview =
    locationBus?.preview_number ?? locationBus?.bus_no ?? locationBusId;
  const routePreview =
    rootBus?.preview_number ?? rootBus?.bus_no ?? rootBusId;

  return state.users.flatMap((user, index) => {
    const assignedBusId = state.busIdsByUser[index];
    if (!serviceBusIds.has(assignedBusId)) return [];
    const assignedBus = busById.get(assignedBusId);
    const busChanged = assignedBusId !== locationBusId;
    const routeChanged = routesChanged || assignedBusId !== rootBusId;
    return [{
          user_id: user._id,
          type: "plan_changed",
          message: getServiceChangeMessage(
            busChanged ? locationPreview : getAssignedBusDisplay(user, assignedBus),
            routeChanged ? routePreview : getAssignedBusDisplay(user, assignedBus),
          ),
          old_bus_no: rootBus?.bus_no ?? user.bus_no ?? null,
          new_bus_no: locationBus?.bus_no ?? null,
          old_preview: rootBus?.preview_number ?? null,
          new_preview: locationBus?.preview_number ?? null,
          plan_name: planName,
          is_bus_active: true,
        }];
  });
}

function getPlanChangeNotifications(state, planName) {
  const normalizedPlan = String(planName || "").trim().toUpperCase();
  const busById = new Map(state.buses.map((bus) => [String(bus._id), bus]));

  return state.users.flatMap((user, index) => {
    const assignedBusId = state.busIdsByUser[index];
    const assignedBus = assignedBusId ? busById.get(assignedBusId) : null;
    const effectiveBusId = assignedBusId
      ? getEffectiveBusId(assignedBusId, normalizedPlan, state.clusters)
      : null;
    const effectiveBus = effectiveBusId ? busById.get(effectiveBusId) : null;
    const effectiveLocationBusId = assignedBusId
      ? getEffectiveLocationBusId(assignedBusId, normalizedPlan, state.clusters)
      : null;
    const effectiveLocationBus = effectiveLocationBusId
      ? busById.get(effectiveLocationBusId)
      : null;
    const effectiveState = effectiveBusId
      ? state.busesById[effectiveBusId]
      : null;
    const hasEffectiveRoute =
      effectiveState?.status === "active" &&
      effectiveState.plans.includes(normalizedPlan);

    if (hasEffectiveRoute) {
      const locationChanged = effectiveLocationBusId !== assignedBusId;
      const locationDisplay =
        effectiveLocationBus?.preview_number ??
        effectiveLocationBus?.bus_no ??
        effectiveLocationBusId;
      const stopsChanged = effectiveBusId !== assignedBusId;
      const routeDisplay =
        effectiveBus?.preview_number ?? effectiveBus?.bus_no ?? effectiveBusId;
      const assignedDisplay = getAssignedBusDisplay(user, assignedBus);
      return [{
        user_id: user._id,
        type: "plan_changed",
        message: getServiceChangeMessage(
          locationChanged ? locationDisplay : assignedDisplay,
          stopsChanged ? routeDisplay : assignedDisplay,
        ),
        old_bus_no: assignedBus?.bus_no ?? user.bus_no ?? null,
        new_bus_no: effectiveLocationBus?.bus_no ?? null,
        old_preview: assignedBus?.preview_number ?? null,
        new_preview: effectiveLocationBus?.preview_number ?? null,
        plan_name: normalizedPlan,
        is_bus_active: true,
      }];
    }

    if (hasEffectiveRoute) return [];

    const assignedDisplay =
      assignedBus?.preview_number ?? assignedBus?.bus_no ?? user.bus_no;
    const isAssignedBusAvailable = Boolean(assignedBusId && assignedBus);
    return [{
      user_id: user._id,
      type: "plan_changed",
      message: isAssignedBusAvailable
        ? `Bus ${assignedDisplay} has no route for today's service, so there is no bus or stop route to follow. Please contact administration for help.`
        : "No bus is assigned to you for today's service, so there are no stops to follow. Please contact administration for help.",
      old_bus_no: assignedBus?.bus_no ?? user.bus_no ?? null,
      new_bus_no: null,
      old_preview: assignedBus?.preview_number ?? null,
      new_preview: null,
      plan_name: normalizedPlan,
      is_bus_active: false,
    }];
  });
}

function getPlanMappingChangeNotifications(
  state,
  planName,
  previousClusters,
) {
  const normalizedPlan = String(planName || "").trim().toUpperCase();
  const busById = new Map(state.buses.map((bus) => [String(bus._id), bus]));

  return state.users.flatMap((user, index) => {
    const assignedBusId = state.busIdsByUser[index];
    if (!assignedBusId) return [];

    const previousBusId = getEffectiveBusId(
      assignedBusId,
      normalizedPlan,
      previousClusters,
    );
    const nextBusId = getEffectiveBusId(
      assignedBusId,
      normalizedPlan,
      state.clusters,
    );
    const previousLocationBusId = getEffectiveLocationBusId(
      assignedBusId,
      normalizedPlan,
      previousClusters,
    );
    const nextLocationBusId = getEffectiveLocationBusId(
      assignedBusId,
      normalizedPlan,
      state.clusters,
    );
    const previousBusState = state.busesById[previousBusId];
    const nextBusState = state.busesById[nextBusId];
    const previousBusActive =
      previousBusState?.status === "active" &&
      previousBusState.plans.includes(normalizedPlan);
    const nextBusActive =
      nextBusState?.status === "active" &&
      nextBusState.plans.includes(normalizedPlan);

    if (
      previousBusActive === nextBusActive &&
      (!nextBusActive ||
        (previousBusId === nextBusId &&
          previousLocationBusId === nextLocationBusId))
    ) {
      return [];
    }

    const previousBus = busById.get(previousBusId);
    const previousLocationBus = busById.get(previousLocationBusId);
    const nextBus = busById.get(nextLocationBusId    );
    if (nextBusActive) {
      const routeBus = busById.get(nextBusId);
      const displayBus =
        nextBus?.preview_number ?? nextBus?.bus_no ?? nextLocationBusId;
      const routeBusDisplay =
        routeBus?.preview_number ?? routeBus?.bus_no ?? nextBusId;
      return [{
        user_id: user._id,
        type: "plan_changed",
        message: getServiceChangeMessage(displayBus, routeBusDisplay),
        old_bus_no: previousLocationBus?.bus_no ?? user.bus_no ?? null,
        new_bus_no: nextBus?.bus_no ?? null,
        old_preview: previousLocationBus?.preview_number ?? null,
        new_preview: nextBus?.preview_number ?? null,
        plan_name: normalizedPlan,
        is_bus_active: true,
      }];
    }

    const assignedDisplay =
      previousLocationBus?.preview_number ??
      previousLocationBus?.bus_no ??
      previousBus?.preview_number ??
      previousBus?.bus_no ??
      user.bus_no ??
      "assigned bus";
    return [{
      user_id: user._id,
      type: "plan_changed",
      message: `Bus ${assignedDisplay} has no route for today's service, so there is no bus or stop route to follow. Please contact administration for help.`,
      old_bus_no: previousLocationBus?.bus_no ?? user.bus_no ?? null,
      new_bus_no: null,
      old_preview: previousLocationBus?.preview_number ?? null,
      new_preview: null,
      plan_name: normalizedPlan,
      is_bus_active: false,
    }];
  });
}

module.exports = {
  getCoverageErrors,
  getClusterChangeNotifications,
  getEffectiveBusForPlan,
  getInUseLocationBusIds,
  getPlanMappingChangeNotifications,
  getPlanChangeNotifications,
  loadPlanState,
};
