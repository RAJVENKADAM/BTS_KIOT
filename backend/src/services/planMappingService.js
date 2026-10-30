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

module.exports = {
  getCoverageErrors,
  getEffectiveBusForPlan,
  loadPlanState,
};
