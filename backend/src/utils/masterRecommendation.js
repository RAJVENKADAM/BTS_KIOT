const EARTH_RADIUS_METERS = 6371000;
const STOP_PASSED_RADIUS_METERS = 75;
const WALKING_SPEED_METERS_PER_SECOND = 1.2;
const WALKING_ROUTE_DETOUR_FACTOR = 1.3;

function isValidPoint(point) {
  return (
    point?.latitude !== undefined &&
    point.latitude !== null &&
    String(point.latitude).trim() !== "" &&
    point?.longitude !== undefined &&
    point.longitude !== null &&
    String(point.longitude).trim() !== "" &&
    Number.isFinite(Number(point?.latitude)) &&
    Number.isFinite(Number(point?.longitude)) &&
    Number(point.latitude) >= -90 &&
    Number(point.latitude) <= 90 &&
    Number(point.longitude) >= -180 &&
    Number(point.longitude) <= 180
  );
}

function distanceMeters(pointA, pointB) {
  const latitudeA = (Number(pointA.latitude) * Math.PI) / 180;
  const latitudeB = (Number(pointB.latitude) * Math.PI) / 180;
  const latitudeDelta = latitudeB - latitudeA;
  const longitudeDelta =
    ((Number(pointB.longitude) - Number(pointA.longitude)) * Math.PI) / 180;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeA) *
      Math.cos(latitudeB) *
      Math.sin(longitudeDelta / 2) ** 2;
  const boundedHaversine = Math.max(0, Math.min(1, haversine));
  return (
    2 *
    EARTH_RADIUS_METERS *
    Math.atan2(Math.sqrt(boundedHaversine), Math.sqrt(1 - boundedHaversine))
  );
}

function projectOntoSegment(point, start, end) {
  const meanLatitude =
    ((Number(point.latitude) + Number(start.latitude) + Number(end.latitude)) /
      3) *
    (Math.PI / 180);
  const longitudeScale = Math.cos(meanLatitude);
  const pointX = Number(point.longitude) * longitudeScale;
  const pointY = Number(point.latitude);
  const startX = Number(start.longitude) * longitudeScale;
  const startY = Number(start.latitude);
  const deltaX = (Number(end.longitude) - Number(start.longitude)) * longitudeScale;
  const deltaY = Number(end.latitude) - Number(start.latitude);
  const segmentLengthSquared = deltaX ** 2 + deltaY ** 2;
  const fraction =
    segmentLengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((pointX - startX) * deltaX + (pointY - startY) * deltaY) /
              segmentLengthSquared,
          ),
        );
  const projected = {
    latitude: Number(start.latitude) + fraction * deltaY,
    longitude:
      Number(start.longitude) +
      (fraction * deltaX) / (longitudeScale || 1),
  };
  return {
    fraction,
    point: projected,
    distance: distanceMeters(point, projected),
  };
}

function getBusRoutePosition(busLocation, routeStops) {
  if (routeStops.length === 1) {
    const stopDistance = distanceMeters(busLocation, routeStops[0]);
    return {
      progress: stopDistance <= STOP_PASSED_RADIUS_METERS ? 0 : -0.01,
      segmentIndex: 0,
      fraction: 0,
      projectedPoint: routeStops[0],
      distanceFromRoute: stopDistance,
    };
  }

  let nearest = null;
  for (let index = 0; index < routeStops.length - 1; index += 1) {
    const projection = projectOntoSegment(
      busLocation,
      routeStops[index],
      routeStops[index + 1],
    );
    if (!nearest || projection.distance < nearest.distanceFromRoute) {
      nearest = {
        progress: index + projection.fraction,
        segmentIndex: index,
        fraction: projection.fraction,
        projectedPoint: projection.point,
        distanceFromRoute: projection.distance,
      };
    }
  }
  return nearest;
}

function getRouteDistanceToStop(routeStops, routePosition, stopIndex) {
  if (routeStops.length === 1) {
    return distanceMeters(routePosition.projectedPoint, routeStops[stopIndex]);
  }
  if (stopIndex <= routePosition.segmentIndex) return 0;

  let distance = distanceMeters(
    routePosition.projectedPoint,
    routeStops[routePosition.segmentIndex + 1],
  );
  for (
    let index = routePosition.segmentIndex + 1;
    index < stopIndex;
    index += 1
  ) {
    distance += distanceMeters(routeStops[index], routeStops[index + 1]);
  }
  return distance;
}

function selectBestMasterRecommendation(evaluatedServices) {
  return (
    evaluatedServices
      .filter((item) => item.status === "RECOMMENDED")
      .sort(
        (first, second) =>
          first.assignmentPriority - second.assignmentPriority ||
          first.recommendation.userDistanceToStop -
            second.recommendation.userDistanceToStop ||
          first.recommendation.busRouteDistanceToStop -
            second.recommendation.busRouteDistanceToStop,
      )[0] || null
  );
}

function getMasterRecommendation({
  userLocation,
  busLocation,
  routeStops,
  busSpeedKmh,
}) {
  if (!isValidPoint(userLocation) || !isValidPoint(busLocation)) {
    return { status: "LOCATION_UNAVAILABLE", recommendation: null };
  }

  const orderedStops = [...routeStops]
    .filter(isValidPoint)
    .sort(
      (first, second) =>
        Number(first.stop_order) - Number(second.stop_order),
    );
  if (!orderedStops.length) {
    return { status: "NO_VERIFIED_STOPS", recommendation: null };
  }

  const routePosition = getBusRoutePosition(busLocation, orderedStops);
  if (
    orderedStops.length > 1 &&
    routePosition.segmentIndex === 0 &&
    routePosition.fraction === 0 &&
    distanceMeters(busLocation, orderedStops[0]) > STOP_PASSED_RADIUS_METERS
  ) {
    routePosition.progress = -0.01;
  }

  const hasReliableSpeed =
    Number.isFinite(Number(busSpeedKmh)) && Number(busSpeedKmh) > 1;
  const candidates = orderedStops
    .map((stop, index) => ({
      stop,
      index,
      userDistanceToStop: Math.round(distanceMeters(userLocation, stop)),
      busDistanceToStop: Math.round(distanceMeters(busLocation, stop)),
      busRouteDistanceToStop: Math.round(
        getRouteDistanceToStop(orderedStops, routePosition, index),
      ),
    }))
    .filter(({ index, busDistanceToStop }) => {
      if (orderedStops.length === 1) {
        return busDistanceToStop > STOP_PASSED_RADIUS_METERS;
      }
      return index > routePosition.progress + 0.001;
    })
    .map((candidate) => {
      const walkingEtaMinutes =
        (candidate.userDistanceToStop * WALKING_ROUTE_DETOUR_FACTOR) /
        (WALKING_SPEED_METERS_PER_SECOND * 60);
      const etaMinutes = hasReliableSpeed
        ? candidate.busRouteDistanceToStop / (Number(busSpeedKmh) * 1000 / 60)
        : null;
      return { ...candidate, walkingEtaMinutes, etaMinutes };
    })
    .sort(
      (first, second) =>
        first.userDistanceToStop - second.userDistanceToStop ||
        first.busRouteDistanceToStop - second.busRouteDistanceToStop ||
        first.index - second.index,
    );

  const selected = candidates[0];
  if (!selected) {
    const hasFutureStop = orderedStops.some((stop, index) =>
      orderedStops.length === 1
        ? distanceMeters(busLocation, stop) > STOP_PASSED_RADIUS_METERS
        : index > routePosition.progress + 0.001,
    );
    return {
      status: hasFutureStop ? "NO_CATCHABLE_STOPS" : "NO_FUTURE_STOPS",
      recommendation: null,
    };
  }

  return {
    status: "RECOMMENDED",
    recommendation: {
      stop: {
        stopId: selected.stop.stopId,
        name: selected.stop.name,
        latitude: Number(selected.stop.latitude),
        longitude: Number(selected.stop.longitude),
        sequence: Number(selected.stop.stop_order),
      },
      userDistanceToStop: selected.userDistanceToStop,
      walkingEtaMinutes: Math.max(1, Math.ceil(selected.walkingEtaMinutes)),
      busDistanceToStop: selected.busDistanceToStop,
      busRouteDistanceToStop: selected.busRouteDistanceToStop,
      etaMinutes:
        selected.etaMinutes == null
          ? null
          : Math.max(1, Math.ceil(selected.etaMinutes)),
      busStatus:
        selected.busDistanceToStop <= 500 ? "APPROACHING" : "EN_ROUTE",
      userLocation: {
        latitude: Number(userLocation.latitude),
        longitude: Number(userLocation.longitude),
      },
      busLocation: {
        latitude: Number(busLocation.latitude),
        longitude: Number(busLocation.longitude),
      },
      routeStops: orderedStops.map((stop) => ({
        stopId: stop.stopId,
        name: stop.name,
        latitude: Number(stop.latitude),
        longitude: Number(stop.longitude),
        sequence: Number(stop.stop_order),
      })),
    },
  };
}

module.exports = {
  distanceMeters,
  getMasterRecommendation,
  selectBestMasterRecommendation,
};
