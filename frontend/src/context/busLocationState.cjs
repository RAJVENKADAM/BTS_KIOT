function updateBusStatus(state, payload) {
  const previewNumber = payload?.previewNumber;
  if (previewNumber == null) return state;

  let busesChanged = false;
  const buses = state.buses.map((bus) => {
    if (
      bus.previewNumber == null ||
      String(bus.previewNumber) !== String(previewNumber)
    ) {
      return bus;
    }

    const changed = Object.entries(payload).some(
      ([key, value]) => !Object.is(bus[key], value),
    );
    if (!changed) return bus;
    busesChanged = true;
    return { ...bus, ...payload };
  });

  let selectedBus = state.selectedBus;
  if (
    selectedBus?.previewNumber != null &&
    String(selectedBus.previewNumber) === String(previewNumber) &&
    Object.entries(payload).some(
      ([key, value]) => !Object.is(selectedBus[key], value),
    )
  ) {
    selectedBus = { ...selectedBus, ...payload };
  }

  if (!busesChanged && selectedBus === state.selectedBus) return state;
  return {
    ...state,
    buses: busesChanged ? buses : state.buses,
    selectedBus,
  };
}

module.exports = { updateBusStatus };
