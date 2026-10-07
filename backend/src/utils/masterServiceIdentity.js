function publicBusNumber(bus) {
  return bus?.preview_number ?? bus?.bus_name ?? null;
}

function getOperationType(assignedBus, incomingChanges) {
  if (assignedBus?.alteration_type) {
    return assignedBus.alteration_type.toUpperCase();
  }
  if (incomingChanges.some((change) => change.alteration_type === "combine")) {
    return "COMBINE";
  }
  if (incomingChanges.some((change) => change.alteration_type === "alter")) {
    return "ALTER";
  }
  return "NORMAL";
}

function getMasterServiceIdentity({
  bus,
  operationalBus,
  assignedBus,
  incomingChanges,
  isAssignedOperationalService,
}) {
  const alterationSources = incomingChanges.filter(
    (change) => change.alteration_type === "alter",
  );
  const combinedSources = incomingChanges.filter(
    (change) => change.alteration_type === "combine",
  );
  const operationType = isAssignedOperationalService
    ? getOperationType(assignedBus, [])
    : alterationSources.length
      ? "ALTER"
      : combinedSources.length
        ? "COMBINE"
        : getOperationType(bus, incomingChanges);
  const assignedBusNumber = isAssignedOperationalService
    ? publicBusNumber(assignedBus) || assignedBus?.bus_no
    : publicBusNumber(bus);
  const operatingBusNumber =
    publicBusNumber(operationalBus) || assignedBusNumber;
  const busNumber = isAssignedOperationalService
    ? assignedBusNumber
    : alterationSources[0]
      ? publicBusNumber(alterationSources[0]) || operatingBusNumber
      : operatingBusNumber;
  const serviceBuses =
    operationType === "COMBINE"
      ? [...combinedSources, bus]
      : operationType === "ALTER"
        ? alterationSources
        : [bus];
  const serviceBusNumbers = [
    ...new Set(serviceBuses.map(publicBusNumber).filter(Boolean)),
  ];

  if (isAssignedOperationalService && !serviceBusNumbers.length && busNumber) {
    serviceBusNumbers.push(busNumber);
  }

  return {
    assignedBusNumber,
    busNumber,
    serviceBusNumbers,
    operatingBusNumber,
    operationType,
  };
}

module.exports = getMasterServiceIdentity;
