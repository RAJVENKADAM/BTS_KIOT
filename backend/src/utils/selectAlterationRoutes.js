function selectAlterationRoutes(
  routeSource,
  sourceRoutes,
  targetRoutes,
  customRoutes,
) {
  if (routeSource === "source") return sourceRoutes;
  if (routeSource === "target") return targetRoutes;
  if (routeSource === "custom") {
    return (customRoutes || []).map((route) => {
      const selectedRoute = {
        plan_name: route.plan_name,
        stop_name: route.stop_name,
        stop_order: route.stop_order,
      };
      if (route.stopId) selectedRoute.stopId = route.stopId;
      return selectedRoute;
    });
  }
  return null;
}

module.exports = selectAlterationRoutes;
