const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getCollegeArrival,
  getMasterRecommendation,
  selectBestMasterRecommendation,
} = require("../src/utils/masterRecommendation");

const routeStops = [
  {
    stopId: "STOP-1",
    name: "Stop 1",
    stop_order: 1,
    latitude: 11,
    longitude: 78,
    status: "VERIFIED",
  },
  {
    stopId: "STOP-2",
    name: "Stop 2",
    stop_order: 2,
    latitude: 11,
    longitude: 78.01,
    status: "VERIFIED",
  },
  {
    stopId: "STOP-3",
    name: "Stop 3",
    stop_order: 3,
    latitude: 11,
    longitude: 78.02,
    status: "VERIFIED",
  },
];

test("reports campus arrival within 500 metres of KIOT", () => {
  const result = getCollegeArrival({
    latitude: 11.558,
    longitude: 78.019759,
  });

  assert.equal(result.status, "ALREADY_AT_COLLEGE");
  assert.ok(result.recommendation.collegeDistanceMeters <= 500);
});

test("does not report campus arrival outside the 500 metre radius", () => {
  const result = getCollegeArrival({
    latitude: 11.56,
    longitude: 78.019759,
  });

  assert.equal(result, null);
});

test("does not recommend a stop when the user is already at college", () => {
  const result = getMasterRecommendation({
    userLocation: { latitude: 11.554, longitude: 78.019759 },
    busLocation: null,
    routeStops: [],
  });

  assert.equal(result.status, "ALREADY_AT_COLLEGE");
  assert.equal(result.recommendation.stop, undefined);
});

test("treats KIOT as the route destination when checking whether stops were passed", () => {
  const result = getMasterRecommendation({
    userLocation: { latitude: 11.53, longitude: 78.019759 },
    busLocation: { latitude: 11.52, longitude: 78.019759 },
    routeStops: [
      {
        stopId: "LAST-STOP",
        name: "Last stop",
        stop_order: 1,
        latitude: 11.51,
        longitude: 78.019759,
      },
    ],
  });

  assert.equal(result.status, "NO_FUTURE_STOPS");
  assert.equal(result.recommendation, null);
});

test("does not recommend stops behind the bus on its assigned route", () => {
  const result = getMasterRecommendation({
    userLocation: { latitude: 11, longitude: 78.002 },
    busLocation: { latitude: 11, longitude: 78.006 },
    routeStops,
  });

  assert.equal(result.status, "RECOMMENDED");
  assert.equal(result.recommendation.stop.stopId, "STOP-2");
});

test("chooses a closer future stop over the assigned bus stop", () => {
  const directRecommendation = {
    busNumber: "4",
    userDistanceToStop: 80000,
    busRouteDistanceToStop: 1000,
  };
  const alteredRecommendation = {
    busNumber: "2",
    userDistanceToStop: 200,
    busRouteDistanceToStop: 100,
  };
  const selected = selectBestMasterRecommendation([
    {
      status: "RECOMMENDED",
      assignmentPriority: 1,
      recommendation: alteredRecommendation,
    },
    {
      status: "RECOMMENDED",
      assignmentPriority: 0,
      recommendation: directRecommendation,
    },
  ]);

  assert.equal(selected.recommendation.busNumber, "2");
});

test("prefers the assigned bus when future stops are equally close", () => {
  const assignedRecommendation = {
    busNumber: "4",
    userDistanceToStop: 200,
    busRouteDistanceToStop: 1000,
  };
  const otherRecommendation = {
    busNumber: "2",
    userDistanceToStop: 200,
    busRouteDistanceToStop: 100,
  };
  const selected = selectBestMasterRecommendation([
    {
      status: "RECOMMENDED",
      assignmentPriority: 1,
      recommendation: otherRecommendation,
    },
    {
      status: "RECOMMENDED",
      assignmentPriority: 0,
      recommendation: assignedRecommendation,
    },
  ]);

  assert.equal(selected.recommendation.busNumber, "4");
});

test("chooses the most accessible future stop, not an already-passed nearby stop", () => {
  const result = getMasterRecommendation({
    userLocation: { latitude: 11, longitude: 78.009 },
    busLocation: { latitude: 11, longitude: 78.015 },
    routeStops,
  });

  assert.equal(result.recommendation.stop.stopId, "STOP-3");
  assert.ok(result.recommendation.busRouteDistanceToStop > 0);
});

test("does not invent a recommendation when all route stops are behind the bus", () => {
  const result = getMasterRecommendation({
    userLocation: { latitude: 11, longitude: 78.018 },
    busLocation: { latitude: 11, longitude: 78.021 },
    routeStops,
  });

  assert.equal(result.status, "NO_FUTURE_STOPS");
  assert.equal(result.recommendation, null);
});

test("does not recommend a single stop after the bus has passed it toward college", () => {
  const result = getMasterRecommendation({
    userLocation: { latitude: 11, longitude: 78.015 },
    busLocation: { latitude: 11, longitude: 78.015 },
    routeStops: [routeStops[1]],
    collegeLocation: { latitude: 11, longitude: 78.019759 },
  });

  assert.equal(result.status, "NO_FUTURE_STOPS");
  assert.equal(result.recommendation, null);
});

test("does not recommend the final stop after the bus has passed it toward college", () => {
  const result = getMasterRecommendation({
    userLocation: { latitude: 11, longitude: 78.019 },
    busLocation: { latitude: 11, longitude: 78.0205 },
    routeStops,
  });

  assert.equal(result.status, "NO_FUTURE_STOPS");
  assert.equal(result.recommendation, null);
});

test("uses pending stops that have saved coordinates", () => {
  const result = getMasterRecommendation({
    userLocation: { latitude: 11, longitude: 78.002 },
    busLocation: { latitude: 11, longitude: 78.006 },
    routeStops: routeStops.map((stop) => ({
      ...stop,
      status: "PENDING",
    })),
  });

  assert.equal(result.status, "RECOMMENDED");
  assert.equal(result.recommendation.stop.stopId, "STOP-2");
});

test("missing coordinates on other stops do not block a valid recommendation", () => {
  const result = getMasterRecommendation({
    userLocation: { latitude: 11, longitude: 78.002 },
    busLocation: { latitude: 11, longitude: 78.006 },
    routeStops: [
      ...routeStops,
      {
        stopId: "STOP-NO-COORDS",
        name: "Stop with no coordinates",
        stop_order: 4,
        latitude: null,
        longitude: null,
        status: "PENDING",
      },
    ],
  });

  assert.equal(result.status, "RECOMMENDED");
  assert.equal(result.recommendation.stop.stopId, "STOP-2");
});

test("does not accept stops without real coordinates", () => {
  const result = getMasterRecommendation({
    userLocation: { latitude: 11, longitude: 78 },
    busLocation: { latitude: 11, longitude: 78 },
    routeStops: [
      {
        stopId: "STOP-NO-COORDS",
        stop_order: 1,
        latitude: null,
        longitude: null,
        status: "VERIFIED",
      },
    ],
  });

  assert.equal(result.status, "NO_VERIFIED_STOPS");
});

test("excludes an active bus when its GPS location is more than 500 metres from its route", () => {
  const result = getMasterRecommendation({
    userLocation: { latitude: 11, longitude: 78.01 },
    busLocation: { latitude: 11.5, longitude: 78.005 },
    routeStops,
  });

  assert.equal(result.status, "BUS_OFF_ROUTE");
  assert.equal(result.recommendation, null);
});

test("allows GPS locations within 500 metres of manually mapped route stops", () => {
  const result = getMasterRecommendation({
    userLocation: { latitude: 11, longitude: 78.002 },
    busLocation: { latitude: 11.0035, longitude: 78.005 },
    routeStops,
  });

  assert.equal(result.status, "RECOMMENDED");
});

test("includes an active bus again when its GPS location returns to its route", () => {
  const result = getMasterRecommendation({
    userLocation: { latitude: 11, longitude: 78.01 },
    busLocation: { latitude: 11, longitude: 78.005 },
    routeStops,
  });

  assert.equal(result.status, "RECOMMENDED");
  assert.equal(result.recommendation.stop.stopId, "STOP-2");
});

test("recommends the ordered route stops with KIOT College as the destination", () => {
  const result = getMasterRecommendation({
    userLocation: { latitude: 11, longitude: 78.002 },
    busLocation: { latitude: 11, longitude: 78.006 },
    routeStops: [...routeStops].reverse(),
  });

  assert.deepEqual(
    result.recommendation.routeStops.map((stop) => stop.sequence),
    [1, 2, 3],
  );
  assert.deepEqual(result.recommendation.collegeLocation, {
    latitude: 11.554528,
    longitude: 78.019759,
  });
});

test("recommends walking directly to college when it is closer than the best stop", () => {
  const result = getMasterRecommendation({
    userLocation: { latitude: 11.554528, longitude: 78.012 },
    busLocation: { latitude: 11.554528, longitude: 77.996 },
    routeStops: [
      {
        stopId: "FAR-STOP",
        name: "Far stop",
        stop_order: 1,
        latitude: 11.554528,
        longitude: 78,
      },
    ],
  });

  assert.equal(result.status, "RECOMMENDED");
  assert.equal(result.recommendation.isCollegeDestination, true);
  assert.equal(result.recommendation.stop.name, "KIOT College");
  assert.equal(result.recommendation.etaMinutes, null);
});

test("recommends the nearest future stop even when the bus will arrive before the user", () => {
  const result = getMasterRecommendation({
    userLocation: { latitude: 11, longitude: 78.019 },
    busLocation: { latitude: 11, longitude: 78.005 },
    busSpeedKmh: 40,
    routeStops,
  });

  assert.equal(result.status, "RECOMMENDED");
  assert.equal(result.recommendation.stop.stopId, "STOP-3");
  assert.ok(result.recommendation.etaMinutes > 0);
});

test("recommends college when it is closer than a distant future stop", () => {
  const result = getMasterRecommendation({
    userLocation: { latitude: 12, longitude: 79 },
    busLocation: { latitude: 11, longitude: 78.006 },
    busSpeedKmh: 40,
    routeStops: [routeStops[1]],
  });

  assert.equal(result.status, "RECOMMENDED");
  assert.equal(result.recommendation.isCollegeDestination, true);
  assert.equal(result.recommendation.stop.stopId, "KIOT-COLLEGE");
});
