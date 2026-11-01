function normalizeText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

function getRouteKey(route) {
  const plan = normalizeText(route.plan_name);
  const stop = route.stopId
    ? `STOP:${route.stopId}`
    : `NAME:${normalizeText(route.stop_name)}`;
  return plan && stop !== "NAME:" ? `${plan}:${stop}` : null;
}

function mergeBusRouteRecords(routes, busIds) {
  const busOrder = new Map(busIds.map((id, index) => [String(id), index]));
  const sortedRoutes = [...routes].sort((first, second) => {
    const busOrderDifference =
      (busOrder.get(String(first.bus_id)) ?? Number.MAX_SAFE_INTEGER) -
      (busOrder.get(String(second.bus_id)) ?? Number.MAX_SAFE_INTEGER);
    if (busOrderDifference) return busOrderDifference;

    const stopOrderDifference = Number(first.stop_order) - Number(second.stop_order);
    if (stopOrderDifference) return stopOrderDifference;
    return new Date(first.createdAt || 0) - new Date(second.createdAt || 0);
  });
  const retainedByKey = new Map();
  const mergedRoutes = [];
  const duplicateIds = [];

  for (const route of sortedRoutes) {
    const key = getRouteKey(route);
    if (!key) {
      mergedRoutes.push(route);
      continue;
    }

    const retained = retainedByKey.get(key);
    if (!retained) {
      retainedByKey.set(key, route);
      mergedRoutes.push(route);
      continue;
    }

    duplicateIds.push(route._id);
    if (!retained.arrival_time && route.arrival_time) {
      retained.arrival_time = route.arrival_time;
    }
    if (!retained.stopId && route.stopId) retained.stopId = route.stopId;
  }

  const orderByPlan = new Map();
  return {
    retainedRoutes: mergedRoutes.map((route) => {
      const planKey = normalizeText(route.plan_name);
      const nextOrder = (orderByPlan.get(planKey) || 0) + 1;
      orderByPlan.set(planKey, nextOrder);
      return { route, stopOrder: nextOrder };
    }),
    duplicateIds,
  };
}

module.exports = mergeBusRouteRecords;
