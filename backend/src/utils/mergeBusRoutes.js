const normalizeText = (value) =>
  String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();

function mergeBusRoutes(sourceRoutes, targetRoutes) {
  const plans = new Map();

  for (const route of [...sourceRoutes, ...targetRoutes]) {
    const planKey = normalizeText(route.plan_name);
    if (!planKey) continue;

    if (!plans.has(planKey)) {
      plans.set(planKey, {
        plan_name: String(route.plan_name).trim(),
        stops: new Map(),
      });
    }

    const plan = plans.get(planKey);
    const stopKey = route.stopId
      ? `STOP:${route.stopId}`
      : `NAME:${normalizeText(route.stop_name)}`;
    if (!stopKey || plan.stops.has(stopKey)) continue;

    const mergedStop = {
      stop_name: String(route.stop_name).trim(),
      stop_order: plan.stops.size + 1,
    };
    if (route.stopId) mergedStop.stopId = route.stopId;
    if (Number.isFinite(route.latitude)) mergedStop.latitude = route.latitude;
    if (Number.isFinite(route.longitude)) mergedStop.longitude = route.longitude;
    if (route.stopStatus) mergedStop.stopStatus = route.stopStatus;
    plan.stops.set(stopKey, mergedStop);
  }

  return [...plans.values()].flatMap((plan) =>
    [...plan.stops.values()].map((stop) => ({
      plan_name: plan.plan_name,
      ...stop,
    })),
  );
}

module.exports = mergeBusRoutes;
