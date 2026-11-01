const normalizeBusNumber = require("./normalizeBusNumber");

function normalizeReplacementAssignments(assignments, targetUsers, allowedBusNos) {
  if (!Array.isArray(assignments)) {
    throw new Error("Provide an assignment choice for every replacement-bus rider.");
  }

  const expectedUserIds = new Set(targetUsers.map((user) => String(user._id)));
  const normalizedAllowedBusNos = new Set(
    [...allowedBusNos].map((busNo) => normalizeBusNumber(busNo)),
  );
  if (assignments.length !== expectedUserIds.size) {
    throw new Error("Every active replacement-bus rider must have an assignment choice.");
  }

  const normalized = new Map();
  for (const assignment of assignments) {
    const userId = String(assignment?.userId || "");
    if (!expectedUserIds.has(userId) || normalized.has(userId)) {
      throw new Error("The replacement-bus rider list changed. Refresh and try again.");
    }

    const busNo = assignment.busNo == null || assignment.busNo === ""
      ? null
      : normalizeBusNumber(assignment.busNo);
    if (busNo && !normalizedAllowedBusNos.has(busNo)) {
      throw new Error("Choose the original bus, an available bus, or no bus assignment.");
    }
    normalized.set(userId, busNo);
  }

  if (normalized.size !== expectedUserIds.size) {
    throw new Error("Every active replacement-bus rider must have an assignment choice.");
  }
  return normalized;
}

module.exports = normalizeReplacementAssignments;
