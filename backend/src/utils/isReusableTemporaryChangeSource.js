function isReusableTemporaryChangeSource(activeChanges, busId) {
  const identifier = String(busId);
  const relatedChanges = activeChanges.filter(
    (change) =>
      String(change.sourceBusId) === identifier ||
      String(change.targetBusId) === identifier,
  );

  return (
    relatedChanges.length > 0 &&
    relatedChanges.every(
      (change) =>
        change.status !== "applying" &&
        String(change.sourceBusId) === identifier &&
        ["alter", "combine"].includes(change.type),
    )
  );
}

module.exports = isReusableTemporaryChangeSource;
