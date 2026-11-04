const Bus = require("../models/Bus");
const BusRoute = require("../models/BusRoute");
const StopMaster = require("../models/StopMaster");
const normalizeStopName = require("./normalizeStopName");
const resolveBusServiceRoutes = require("./resolveBusServiceRoutes");
const selectAlterationRoutes = require("./selectAlterationRoutes");

const BUS_READ_FIELDS =
  "_id bus_no preview_number status altered_to_bus_id altered_to_preview alteration_type alteration_route_source alteration_routes combined_route_source combined_routes";

function getId(value) {
  return String(value?._id ?? value ?? "");
}

function buildBusMap(buses) {
  return new Map(buses.map((bus) => [getId(bus), bus]));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function loadBusReadContext(seedBuses) {
  const busesById = buildBusMap(seedBuses.filter(Boolean));
  let pendingIds = new Set(
    [...busesById.values()]
      .map((bus) => getId(bus.altered_to_bus_id))
      .filter((id) => id && !busesById.has(id)),
  );
  let depth = 0;

  while (pendingIds.size && depth < 20) {
    const referencedBuses = await Bus.find({
      _id: { $in: [...pendingIds] },
    })
      .select(BUS_READ_FIELDS)
      .lean();
    pendingIds = new Set();
    for (const bus of referencedBuses) {
      const id = getId(bus);
      if (busesById.has(id)) continue;
      busesById.set(id, bus);
      const nextId = getId(bus.altered_to_bus_id);
      if (nextId && !busesById.has(nextId)) pendingIds.add(nextId);
    }
    depth += 1;
  }

  const targetIds = [...busesById.keys()];
  const incomingChanges = targetIds.length
    ? await Bus.find({
        altered_to_bus_id: { $in: targetIds },
        alteration_type: { $in: ["alter", "combine"] },
      })
        .select(BUS_READ_FIELDS)
        .sort({ bus_no: 1 })
        .lean()
    : [];
  const incomingChangesByTarget = new Map();
  for (const change of incomingChanges) {
    const targetId = getId(change.altered_to_bus_id);
    const changes = incomingChangesByTarget.get(targetId) || [];
    changes.push(change);
    incomingChangesByTarget.set(targetId, changes);
    busesById.set(getId(change), change);
  }

  const routeBusIds = [...busesById.keys()];
  const routeRows = routeBusIds.length
    ? await BusRoute.find({ bus_id: { $in: routeBusIds } })
        .select("_id bus_id plan_name stop_name stop_order stopId arrival_time")
        .sort({ plan_name: 1, stop_order: 1 })
        .lean()
    : [];
  const routeRowsByBusId = new Map();
  for (const row of routeRows) {
    const busId = getId(row.bus_id);
    const rows = routeRowsByBusId.get(busId) || [];
    rows.push(row);
    routeRowsByBusId.set(busId, rows);
  }

  const stopIds = new Set();
  for (const row of routeRows) {
    if (row.stopId) stopIds.add(String(row.stopId));
  }
  for (const bus of busesById.values()) {
    for (const route of [
      ...(bus.combined_routes || []),
      ...(bus.alteration_routes || []),
    ]) {
      if (route.stopId) stopIds.add(String(route.stopId));
    }
  }
  const stops = stopIds.size
    ? await StopMaster.find({ stopId: { $in: [...stopIds] } })
        .select("stopId name latitude longitude status")
        .lean()
    : [];
  const stopsById = new Map(stops.map((stop) => [stop.stopId, stop]));

  const legacyRows = routeRows.filter((row) => !row.stopId);
  const legacyNames = [
    ...new Set(
      legacyRows.map((row) =>
        String(row.stop_name || "").trim().replace(/\s+/g, " "),
      ),
    ),
  ];
  const legacyPatterns = legacyNames.map(
    (name) => new RegExp(`^${escapeRegExp(name)}$`, "i"),
  );
  const legacyStops = legacyPatterns.length
    ? await StopMaster.find({
        $or: [
          {
            status: "VERIFIED",
            $or: [
              { name: { $in: legacyPatterns } },
              { aliases: { $in: legacyPatterns } },
            ],
          },
          { status: "PENDING", name: { $in: legacyPatterns } },
        ],
      })
        .select("stopId name aliases latitude longitude status")
        .lean()
    : [];
  const verifiedStopsByName = new Map();
  const pendingStopsByName = new Map();
  for (const stop of legacyStops) {
    if (stop.status === "PENDING") {
      const key = normalizeStopName(stop.name);
      if (!pendingStopsByName.has(key)) pendingStopsByName.set(key, stop);
      continue;
    }
    if (stop.status !== "VERIFIED") continue;
    for (const name of [stop.name, ...(stop.aliases || [])]) {
      const key = normalizeStopName(name);
      const matches = verifiedStopsByName.get(key) || [];
      if (!matches.includes(stop)) matches.push(stop);
      verifiedStopsByName.set(key, matches);
    }
  }
  const legacyStopByName = new Map();
  for (const name of legacyNames) {
    const key = normalizeStopName(name);
    const verifiedMatches = verifiedStopsByName.get(key) || [];
    legacyStopByName.set(
      name,
      (verifiedMatches.length === 1 && verifiedMatches[0]) ||
        pendingStopsByName.get(key) ||
        null,
    );
  }

  for (const row of routeRows) {
    if (row.stopId) {
      if (!stopsById.has(row.stopId)) row.invalidStopId = true;
      continue;
    }

    const legacyName = String(row.stop_name || "")
      .trim()
      .replace(/\s+/g, " ");
    const stop = legacyStopByName.get(legacyName);
    if (!stop) {
      row.invalidStopId = true;
      continue;
    }

    row.stopId = stop.stopId;
    stopsById.set(stop.stopId, stop);
  }

  return { busesById, incomingChangesByTarget, routeRowsByBusId, stopsById };
}

function hydrateRouteRows(routes, context) {
  return routes
    .filter((route) => !route.invalidStopId)
    .map((route) => {
      const stop = context.stopsById.get(route.stopId);
      return {
        ...route,
        stop_name: stop?.status === "VERIFIED" ? stop.name : route.stop_name,
        latitude: stop?.latitude ?? null,
        longitude: stop?.longitude ?? null,
        stopStatus: stop?.status || "PENDING",
      };
    });
}

function getBusRouteRows(context, busId) {
  return hydrateRouteRows(
    context.routeRowsByBusId.get(getId(busId)) || [],
    context,
  );
}

function getIncomingBusChanges(context, bus) {
  return context.incomingChangesByTarget.get(getId(bus)) || [];
}

function getRoutesForBus(context, bus) {
  if (bus.combined_route_source && bus.combined_routes?.length) {
    return hydrateRouteRows(bus.combined_routes, context);
  }

  const sourceRoutes = getBusRouteRows(context, bus._id);
  const isCombined = bus.alteration_type === "combine";
  const targetRoutes =
    isCombined && bus.altered_to_bus_id
      ? getBusRouteRows(context, bus.altered_to_bus_id)
      : [];
  const selectedRoutes = selectAlterationRoutes(
    bus.alteration_route_source,
    sourceRoutes,
    targetRoutes,
    bus.alteration_routes,
  );
  if (selectedRoutes) return hydrateRouteRows(selectedRoutes, context);

  const incomingRouteGroups = getIncomingBusChanges(context, bus).map(
    (changedBus) => {
      const changedBusRoutes = getBusRouteRows(context, changedBus._id);
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
    },
  );

  return hydrateRouteRows(
    resolveBusServiceRoutes(sourceRoutes, incomingRouteGroups, targetRoutes),
    context,
  );
}

function resolveEffectiveBus(context, bus) {
  const visited = new Set();
  let effectiveBus = bus;
  let depth = 0;
  while (effectiveBus?.altered_to_bus_id && depth < 20) {
    const currentId = getId(effectiveBus);
    if (visited.has(currentId)) break;
    visited.add(currentId);
    const nextBus = context.busesById.get(getId(effectiveBus.altered_to_bus_id));
    if (!nextBus) break;
    effectiveBus = nextBus;
    depth += 1;
  }
  return effectiveBus;
}

module.exports = {
  BUS_READ_FIELDS,
  getBusRouteRows,
  getIncomingBusChanges,
  getRoutesForBus,
  loadBusReadContext,
  resolveEffectiveBus,
};
