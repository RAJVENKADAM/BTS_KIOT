const assert = require("node:assert/strict");
const test = require("node:test");
const getRouteUpdateImpactBuses = require("../src/utils/routeUpdateImpact");

test("route edits on a combined source affect its own assigned students", () => {
  const sourceBus = {
    _id: "source",
    altered_to_bus_id: "target",
    alteration_type: "combine",
    alteration_route_source: "source",
  };

  assert.deepEqual(
    getRouteUpdateImpactBuses(sourceBus),
    [sourceBus],
  );
});

test("route edits on a combined source do not notify students when it uses target or custom routes", () => {
  for (const routeSource of ["target", "custom"]) {
    assert.deepEqual(
      getRouteUpdateImpactBuses({
        _id: "source",
        altered_to_bus_id: "target",
        alteration_type: "combine",
        alteration_route_source: routeSource,
      }),
      [],
    );
  }
});

test("target route edits include each combined bus using target stops", () => {
  const targetBus = { _id: "target" };
  const firstCombinedBus = {
    _id: "combined-1",
    alteration_type: "combine",
    alteration_route_source: "target",
  };
  const secondCombinedBus = {
    _id: "combined-2",
    alteration_type: "combine",
  };

  assert.deepEqual(
    getRouteUpdateImpactBuses(targetBus, [
      firstCombinedBus,
      secondCombinedBus,
      {
        _id: "source-routes",
        alteration_type: "combine",
        alteration_route_source: "source",
      },
      {
        _id: "custom-routes",
        alteration_type: "combine",
        alteration_route_source: "custom",
      },
    ]),
    [targetBus, firstCombinedBus, secondCombinedBus],
  );
});

test("target route edits include altered buses only when they explicitly use target stops", () => {
  const targetBus = { _id: "target" };

  assert.deepEqual(
    getRouteUpdateImpactBuses(targetBus, [
      {
        _id: "altered-target",
        alteration_type: "alter",
        alteration_route_source: "target",
      },
      {
        _id: "altered-source",
        alteration_type: "alter",
        alteration_route_source: "source",
      },
      {
        _id: "altered-default",
        alteration_type: "alter",
      },
    ]),
    [targetBus, { _id: "altered-target", alteration_type: "alter", alteration_route_source: "target" }],
  );
});
