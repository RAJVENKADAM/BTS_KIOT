const assert = require("node:assert/strict");
const test = require("node:test");
const selectAlterationRoutes = require("../src/utils/selectAlterationRoutes");

const sourceRoutes = [
  { plan_name: "PLAN A", stop_name: "Source stop", stop_order: 1 },
];
const targetRoutes = [
  { plan_name: "PLAN A", stop_name: "Target stop", stop_order: 1 },
];
const customRoutes = [
  { plan_name: "PLAN B", stop_name: "Uploaded stop", stop_order: 1 },
];

test("selects the source bus route set", () => {
  assert.equal(
    selectAlterationRoutes("source", sourceRoutes, targetRoutes, customRoutes),
    sourceRoutes,
  );
});

test("selects the replacement bus route set", () => {
  assert.equal(
    selectAlterationRoutes("target", sourceRoutes, targetRoutes, customRoutes),
    targetRoutes,
  );
});

test("selects uploaded routes without exposing their database subdocuments", () => {
  assert.deepEqual(
    selectAlterationRoutes("custom", sourceRoutes, targetRoutes, customRoutes),
    customRoutes,
  );
});

test("returns null when an existing change has no route selection", () => {
  assert.equal(
    selectAlterationRoutes(null, sourceRoutes, targetRoutes, customRoutes),
    null,
  );
});
