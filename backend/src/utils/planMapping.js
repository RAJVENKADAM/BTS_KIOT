const DEFAULT_PLAN_NAMES = ["PLAN A", "PLAN B", "PLAN C", "PLAN D"];

function getEffectiveBusId(busId, planName, clusters) {
  const normalizedPlan = String(planName || "PLAN A").trim().toUpperCase();
  if (normalizedPlan === "PLAN A") return String(busId);

  const cluster = (clusters || []).find(
    (item) =>
      String(item.plan_name).toUpperCase() === normalizedPlan &&
      (item.member_bus_ids || []).some(
        (memberId) => String(memberId) === String(busId),
      ),
  );
  return String(cluster?.root_bus_id || busId);
}

function validateCluster(input, busesById, existingClusters) {
  const errors = [];
  const planName = String(input?.planName || "").trim().toUpperCase();
  const rootBusId = String(input?.rootBusId || "");
  const memberBusIds = [...new Set((input?.memberBusIds || []).map(String))];

  if (!["PLAN B", "PLAN C", "PLAN D"].includes(planName)) {
    errors.push("Clusters can only be created for PLAN B, PLAN C, or PLAN D.");
  }
  if (!rootBusId || !busesById[rootBusId]) {
    errors.push("Choose an existing root bus.");
  } else if (
    !busesById[rootBusId].plans.includes(planName)
  ) {
    errors.push(`The root bus must have an uploaded ${planName} route.`);
  } else if (busesById[rootBusId].status === "inactive") {
    errors.push("The root bus must be active.");
  }
  if (memberBusIds.includes(rootBusId)) {
    errors.push("The root bus cannot also be a cluster member.");
  }

  for (const memberBusId of memberBusIds) {
    const member = busesById[memberBusId];
    if (!member) {
      errors.push("Every cluster member must be an existing bus.");
      continue;
    }
    if (!member.plans.includes("PLAN A") || member.plans.includes(planName)) {
      errors.push(
        `Member bus ${memberBusId} must have PLAN A routes and no ${planName} route.`,
      );
    }
  }

  for (const cluster of existingClusters || []) {
    if (
      input?.clusterId &&
      String(cluster._id) === String(input.clusterId)
    ) {
      continue;
    }
    if (String(cluster.plan_name).toUpperCase() !== planName) continue;

    const occupied = new Set([
      String(cluster.root_bus_id),
      ...(cluster.member_bus_ids || []).map(String),
    ]);
    if (occupied.has(rootBusId)) {
      errors.push("This bus is already mapped in another cluster for this plan.");
      break;
    }
    if (memberBusIds.some((memberBusId) => occupied.has(memberBusId))) {
      errors.push("A selected bus is already mapped in another cluster for this plan.");
      break;
    }
  }

  return [...new Set(errors)];
}

function findUncoveredAssignments(busIds, planName, clusters, busesById) {
  const normalizedPlan = String(planName || "PLAN A").trim().toUpperCase();
  return [...new Set((busIds || []).map(String))].filter((busId) => {
    const effectiveBusId = getEffectiveBusId(busId, normalizedPlan, clusters);
    const effectiveBus = busesById[effectiveBusId];
    return (
      !effectiveBus ||
      effectiveBus.status === "inactive" ||
      !effectiveBus.plans.includes(normalizedPlan)
    );
  });
}

function normalizeArrivalTime(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  const match = String(value).trim().match(/^(0?[1-9]|1[0-2]):([0-5]\d)(AM|PM)$/i);
  if (!match) {
    throw new Error("Arrival time must use the format 8:10AM without spaces.");
  }
  return `${Number(match[1])}:${match[2]}${match[3].toUpperCase()}`;
}

module.exports = {
  DEFAULT_PLAN_NAMES,
  findUncoveredAssignments,
  getEffectiveBusId,
  normalizeArrivalTime,
  validateCluster,
};
