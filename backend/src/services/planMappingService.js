const Bus = require("../models/Bus");
const BusRoute = require("../models/BusRoute");
const PlanMapping = require("../models/PlanMapping");
const User = require("../models/User");
const {
  findUncoveredAssignments,
  getEffectiveBusId,
} = require("../utils/planMapping");

function normalizeIdentifier(value) {
  return String(value ?? "").trim().toUpperCase();
}

async function loadPlanState() {
  const [buses, routes, clusters, users] = await Promise.all([
    Bus.find({})
      .select("_id bus_no preview_number status altered_to_bus_id combined_routes")
      .lean(),
    BusRoute.find({}).select("bus_id plan_name arrival_time").lean(),
    PlanMapping.find({}).select("plan_name root_bus_id member_bus_ids").lean(),
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
    const effectiveState = effectiveBusId
      ? state.busesById[effectiveBusId]
      : null;
    const hasEffectiveRoute =
      effectiveState?.status === "active" &&
      effectiveState.plans.includes(normalizedPlan);

    if (hasEffectiveRoute) {
      const displayBus =
        effectiveBus?.preview_number ?? effectiveBus?.bus_no ?? effectiveBusId;
      return [{
        user_id: user._id,
        type: "plan_changed",
        message:
          normalizedPlan === "PLAN A"
            ? "Today's service is back to your normal route. Follow your usual routine and check the Home page for your stops and arrival times."
            : `Your route has changed for today. Use Bus ${displayBus}. ` +
              "In the Home page, view the stops and wait at a nearby stop at the listed time.",
        old_bus_no: assignedBus?.bus_no ?? user.bus_no ?? null,
        new_bus_no: effectiveBus?.bus_no ?? null,
        old_preview: assignedBus?.preview_number ?? null,
        new_preview: effectiveBus?.preview_number ?? null,
        plan_name: normalizedPlan,
        is_bus_active: true,
      }];
    }

    if (hasEffectiveRoute) return [];

    const assignedDisplay =
      assignedBus?.preview_number ?? assignedBus?.bus_no ?? user.bus_no ?? "assigned bus";
    return [{
      user_id: user._id,
      type: "plan_changed",
      message: assignedBus
        ? `Your assigned bus ${assignedDisplay} has no route or mapped replacement today, so it is inactive. Contact the Super Admin for assistance.`
        : `Your assigned bus ${assignedDisplay} is no longer available and has no service today, so it is inactive. Contact the Super Admin for assistance.`,
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
      (!nextBusActive || previousBusId === nextBusId)
    ) {
      return [];
    }

    const previousBus = busById.get(previousBusId);
    const nextBus = busById.get(nextBusId);
    if (nextBusActive) {
      const displayBus = nextBus?.preview_number ?? nextBus?.bus_no ?? nextBusId;
      return [{
        user_id: user._id,
        type: "plan_changed",
        message:
          `Your route plan has changed. Use Bus ${displayBus}. In Home, you can see ` +
          "this bus's location. Tap View stops to find a nearby stop and wait at the listed time.",
        old_bus_no: previousBus?.bus_no ?? user.bus_no ?? null,
        new_bus_no: nextBus?.bus_no ?? null,
        old_preview: previousBus?.preview_number ?? null,
        new_preview: nextBus?.preview_number ?? null,
        plan_name: normalizedPlan,
        is_bus_active: true,
      }];
    }

    const assignedDisplay =
      previousBus?.preview_number ??
      previousBus?.bus_no ??
      user.bus_no ??
      "assigned bus";
    return [{
      user_id: user._id,
      type: "plan_changed",
      message:
        `Your assigned bus ${assignedDisplay} has no ${normalizedPlan} route or mapped ` +
        "replacement, so it is inactive today. Contact the Super Admin for assistance.",
      old_bus_no: previousBus?.bus_no ?? user.bus_no ?? null,
      new_bus_no: null,
      old_preview: previousBus?.preview_number ?? null,
      new_preview: null,
      plan_name: normalizedPlan,
      is_bus_active: false,
    }];
  });
}

module.exports = {
  getCoverageErrors,
  getEffectiveBusForPlan,
  getPlanMappingChangeNotifications,
  getPlanChangeNotifications,
  loadPlanState,
};
