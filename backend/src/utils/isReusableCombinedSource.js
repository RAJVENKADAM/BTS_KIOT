function isReusableCombinedSource(activeChanges, busId) {
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
        String(change.sourceBusId) === identifier &&
        change.type === "combine",
    )
  );
}

module.exports = isReusableCombinedSource;
