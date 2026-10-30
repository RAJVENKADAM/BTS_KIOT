function getRouteUpdateImpactBuses(updatedBus, incomingChanges = []) {
  const buses = [];
  const directlyAffected =
    !updatedBus.altered_to_bus_id ||
    !updatedBus.alteration_route_source ||
    updatedBus.alteration_route_source === "source";

  if (directlyAffected) buses.push(updatedBus);

  incomingChanges.forEach((change) => {
    const usesUpdatedRoutes =
      change.alteration_route_source === "target" ||
      (!change.alteration_route_source &&
        change.alteration_type === "combine");
    if (usesUpdatedRoutes) buses.push(change);
  });

  const seen = new Set();
  return buses.filter((bus) => {
    const id = String(bus._id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

module.exports = getRouteUpdateImpactBuses;
