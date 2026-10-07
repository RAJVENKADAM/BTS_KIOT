function buildStopCoordinateOperations(
  importedStops,
  verifiedBy,
  verifiedAt,
) {
  return importedStops.map((stop) => {
    const hasCoordinates = stop.latitude != null && stop.longitude != null;
    return {
      updateOne: {
        filter: { stopId: stop.stopId },
        update: {
          $set: {
            name: stop.name,
            latitude: stop.latitude,
            longitude: stop.longitude,
            source: hasCoordinates ? "ADMIN" : "EXISTING_STOP",
            status: hasCoordinates ? "VERIFIED" : "PENDING",
            verifiedBy: hasCoordinates ? verifiedBy : null,
            verifiedAt: hasCoordinates ? verifiedAt : null,
          },
          $setOnInsert: {
            stopId: stop.stopId,
            aliases: [],
          },
        },
        upsert: true,
      },
    };
  });
}

module.exports = buildStopCoordinateOperations;
