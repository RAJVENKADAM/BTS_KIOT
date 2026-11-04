const assert = require("node:assert/strict");
const test = require("node:test");
const { updateBusStatus } = require("./busLocationState.cjs");

const state = {
  buses: [
    { previewNumber: "4", latitude: 10, longitude: 77 },
    { previewNumber: "5", latitude: 12, longitude: 78 },
  ],
  selectedBus: {
    previewNumber: "4",
    latitude: 10,
    longitude: 77,
    status: "online",
  },
  loading: false,
};

test("unrelated and identical bus updates preserve the existing state reference", () => {
  assert.equal(
    updateBusStatus(state, { previewNumber: "9", latitude: 20 }),
    state,
  );
  assert.equal(
    updateBusStatus(state, {
      previewNumber: "4",
      latitude: 10,
      longitude: 77,
    }),
    state,
  );
});

test("a matching bus update changes only relevant bus records", () => {
  const updated = updateBusStatus(state, {
    previewNumber: "4",
    latitude: 10.1,
  });
  assert.notEqual(updated, state);
  assert.notEqual(updated.buses, state.buses);
  assert.notEqual(updated.buses[0], state.buses[0]);
  assert.equal(updated.buses[1], state.buses[1]);
  assert.equal(updated.buses[0].latitude, 10.1);
  assert.notEqual(updated.selectedBus, state.selectedBus);
  assert.equal(updated.selectedBus.latitude, 10.1);
});
