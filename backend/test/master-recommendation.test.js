const test = require("node:test");
const assert = require("node:assert/strict");
const {
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

test("uses the nearest future route stop when the active bus is away from its mapped route", () => {
  const result = getMasterRecommendation({
    userLocation: { latitude: 11, longitude: 78.01 },
    busLocation: { latitude: 11.5, longitude: 78.005 },
    routeStops,
  });

  assert.equal(result.status, "RECOMMENDED");
  assert.equal(result.recommendation.stop.stopId, "STOP-2");
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

test("still shows the nearest future stop when it is far from the user", () => {
  const result = getMasterRecommendation({
    userLocation: { latitude: 12, longitude: 79 },
    busLocation: { latitude: 11, longitude: 78.005 },
    busSpeedKmh: 40,
    routeStops: [routeStops[1]],
  });

  assert.equal(result.status, "RECOMMENDED");
  assert.equal(result.recommendation.stop.stopId, "STOP-2");
});
