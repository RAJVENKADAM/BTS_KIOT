const mergeBusRoutes = require("./mergeBusRoutes");
const selectAlterationRoutes = require("./selectAlterationRoutes");

function resolveAssignedBusRoutes(bus, sourceRoutes, targetRoutes = []) {
  const selectedRoutes = selectAlterationRoutes(
    bus?.alteration_route_source,
    sourceRoutes,
    targetRoutes,
    bus?.alteration_routes,
  );
  if (selectedRoutes) return selectedRoutes;

  if (bus?.alteration_type === "combine") {
    return mergeBusRoutes(sourceRoutes, targetRoutes);
  }

  return sourceRoutes;
}

function resolveBusServiceRoutes(
  ownRoutes,
  incomingRouteGroups,
  outgoingCombinedRoutes = [],
) {
  const alteredGroups = incomingRouteGroups.filter(
    (group) => group.alterationType === "alter",
  );
  const combinedRoutes = incomingRouteGroups
    .filter((group) => group.alterationType === "combine")
    .flatMap((group) => group.routes);

  if (alteredGroups.length) {
    return mergeBusRoutes(
      alteredGroups.flatMap((group) => group.routes),
      [],
    );
  }

  const selectedCombinedGroups = incomingRouteGroups.filter(
    (group) =>
      group.alterationType === "combine" && group.hasRouteSelection,
  );
  if (selectedCombinedGroups.length) {
    return mergeBusRoutes(
      selectedCombinedGroups.flatMap((group) => group.routes),
      [],
    );
  }

  let routes = combinedRoutes.length
    ? mergeBusRoutes(ownRoutes, combinedRoutes)
    : ownRoutes;
  if (outgoingCombinedRoutes.length) {
    routes = mergeBusRoutes(routes, outgoingCombinedRoutes);
  }

  return routes;
}

module.exports = resolveBusServiceRoutes;
module.exports.resolveAssignedBusRoutes = resolveAssignedBusRoutes;
