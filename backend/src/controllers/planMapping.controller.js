const mongoose = require("mongoose");
const AppSetting = require("../models/AppSetting");
const Bus = require("../models/Bus");
const BusRoute = require("../models/BusRoute");
const PlanMapping = require("../models/PlanMapping");
const AdministrativeChangeAudit = require("../models/AdministrativeChangeAudit");
const User = require("../models/User");
const StopMaster = require("../models/StopMaster");
const { getIO } = require("../socket");
const { parsePagination } = require("../utils/pagination");
const {
  getClusterChangeNotifications,
  getInUseLocationBusIds,
  getPlanMappingChangeNotifications,
  loadPlanState,
} = require("../services/planMappingService");
const {
  getPlanMappingVersions,
  runPlanMappingMutation,
} = require("../services/planMappingPersistence");
const {
  normalizeArrivalTime,
  validateCluster,
} = require("../utils/planMapping");
const resolvePlanMappingStops = require("../utils/resolvePlanMappingStops");
const { logSafeError } = require("../utils/safeErrorLog");

const GLOBAL_ACTIVE_PLAN_KEY = "global_active_plan";

function getExpectedVersion(req) {
  const raw = req.body?.expectedVersion ?? req.get?.("If-Match") ?? req.headers?.["if-match"];
  const value = typeof raw === "string" && /^"?\d+"?$/.test(raw)
    ? Number(raw.replaceAll('"', ""))
    : raw;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function getExpectedBusVersion(req) {
  const raw = req.body?.expectedBusVersion;
  const value = typeof raw === "string" && /^\d+$/.test(raw)
    ? Number(raw)
    : raw;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function getIdempotencyKey(req) {
  const value = req.get?.("Idempotency-Key") || req.headers?.["idempotency-key"];
  return typeof value === "string" ? value : null;
}

function respondMutationError(res, error, fallbackMessage) {
  if (String(error?.code || "").startsWith("PLAN_MAPPING_")) {
    return res.status(error.statusCode || 409).json({
      success: false,
      error: error.message,
      code: error.code,
    });
  }
  if (String(error?.code || "").startsWith("BUS_REVISION_")) {
    return res.status(error.statusCode || 409).json({
      success: false,
      error: error.message,
      code: error.code,
    });
  }
  logSafeError(fallbackMessage, error);
  return res.status(500).json({
    success: false,
    error: fallbackMessage,
  });
}

function normalizePlanName(value) {
  return String(value || "").trim().toUpperCase();
}

async function getCurrentPlan() {
  const setting = await AppSetting.findOne({
    key: GLOBAL_ACTIVE_PLAN_KEY,
  }).lean();
  return normalizePlanName(setting?.value || "PLAN A");
}

async function getPlanMappingData(req, res) {
  try {
    const [buses, routes, clusters, users, activePlan] = await Promise.all([
      Bus.find({})
        .select("_id bus_no revision preview_number status alteration_type combined_route_source combined_routes alteration_route_source alteration_routes")
        .sort({ preview_number: 1, bus_no: 1 })
        .lean(),
      BusRoute.find({}).select("bus_id plan_name stopId stop_name stop_order arrival_time").lean(),
      PlanMapping.find({})
        .select("plan_name cluster_name root_bus_id location_bus_id member_bus_ids")
        .sort({ plan_name: 1, cluster_name: 1 })
        .lean(),
      User.aggregate([
        { $match: { role: "student", is_active: true } },
        { $group: { _id: "$bus_no", count: { $sum: 1 } } },
      ]),
      getCurrentPlan(),
    ]);

    const planNamesByBus = new Map();
    const routesByBusAndPlan = new Map();
    const explicitRoutePlanKeys = new Set();
    for (const route of routes) {
      const busId = String(route.bus_id);
      const plan = normalizePlanName(route.plan_name);
      if (!planNamesByBus.has(busId)) planNamesByBus.set(busId, new Set());
      planNamesByBus.get(busId).add(plan);
      const key = `${busId}:${plan}`;
      const planRoutes = routesByBusAndPlan.get(key) || [];
      planRoutes.push({
        stopName: route.stop_name,
        stopId: route.stopId || null,
        stopOrder: route.stop_order,
        arrivalTime: route.arrival_time || null,
      });
      routesByBusAndPlan.set(key, planRoutes);
    }
    for (const bus of buses) {
      const locationRoutes =
        bus.combined_route_source && bus.combined_routes?.length
          ? bus.combined_routes
          : bus.alteration_route_source === "custom"
            ? bus.alteration_routes || []
            : [];
      for (const route of locationRoutes) {
        const id = String(bus._id);
        const plan = normalizePlanName(route.plan_name);
        if (!planNamesByBus.has(id)) planNamesByBus.set(id, new Set());
        planNamesByBus.get(id).add(plan);
        const key = `${id}:${plan}`;
        const hasExplicitRouteSource =
          bus.combined_route_source ||
          bus.alteration_route_source === "custom";
        if (hasExplicitRouteSource && !explicitRoutePlanKeys.has(key)) {
          routesByBusAndPlan.set(key, []);
          explicitRoutePlanKeys.add(key);
        }
        const planRoutes = routesByBusAndPlan.get(key) || [];
        planRoutes.push({
          stopName: route.stop_name,
          stopId: route.stopId || null,
          stopOrder: route.stop_order,
          arrivalTime: route.arrival_time || null,
        });
        routesByBusAndPlan.set(key, planRoutes);
      }
    }

    const userCountByBus = new Map();
    const identifierToBusId = new Map();
    for (const bus of buses) {
      identifierToBusId.set(String(bus.bus_no).trim().toUpperCase(), String(bus._id));
      if (bus.preview_number != null) {
        identifierToBusId.set(String(bus.preview_number).trim().toUpperCase(), String(bus._id));
      }
    }
    for (const assignment of users) {
      const id = identifierToBusId.get(
        String(assignment._id || "").trim().toUpperCase(),
      );
      if (id) {
        userCountByBus.set(
          id,
          (userCountByBus.get(id) || 0) + assignment.count,
        );
      }
    }

    const clusterState = clusters.map((cluster) => ({
      plan_name: cluster.plan_name,
      root_bus_id: String(cluster.root_bus_id?._id || cluster.root_bus_id),
      location_bus_id: cluster.location_bus_id
        ? String(cluster.location_bus_id?._id || cluster.location_bus_id)
        : null,
      member_bus_ids: (cluster.member_bus_ids || []).map((member) =>
        String(member?._id || member),
      ),
    }));
    const busIdsByUser = users.map(
      (assignment) =>
        identifierToBusId.get(
          String(assignment._id || "").trim().toUpperCase(),
        ) || null,
    );
    const inUseBusIds = getInUseLocationBusIds(
      busIdsByUser,
      activePlan,
      clusterState,
    );
    const busOptions = buses.map((bus) => {
      const id = String(bus._id);
      const plans = [...(planNamesByBus.get(id) || [])].sort();
      return {
        id,
        busNo: bus.bus_no,
        revision: bus.revision ?? 0,
        previewNumber: bus.preview_number,
        status: bus.status,
        plans,
        assignedUsers: userCountByBus.get(id) || 0,
        currentlyInUse: inUseBusIds.has(id),
        canBeTemporaryLocation:
          bus.status === "active" || bus.alteration_type === "alter",
      };
    });
    const busOptionsById = new Map(
      busOptions.map((bus) => [bus.id, bus]),
    );

    const clusterData = clusters.map((cluster) => {
      const rootBusId = String(cluster.root_bus_id?._id || cluster.root_bus_id);
      const locationBusId = cluster.location_bus_id
        ? String(cluster.location_bus_id?._id || cluster.location_bus_id)
        : null;
      return {
        id: String(cluster._id),
        planName: cluster.plan_name,
        clusterName: cluster.cluster_name,
        rootBus: busOptionsById.get(rootBusId) || null,
        locationBus: locationBusId
          ? busOptionsById.get(locationBusId) || null
          : null,
        memberBuses: (cluster.member_bus_ids || [])
          .map((member) =>
            busOptionsById.get(String(member?._id || member)),
          )
          .filter(Boolean),
        rootStops: (routesByBusAndPlan.get(
          `${rootBusId}:${cluster.plan_name}`,
        ) || []).sort((a, b) => a.stopOrder - b.stopOrder),
      };
    });

    const versions = await getPlanMappingVersions([
      "PLAN B",
      "PLAN C",
      "PLAN D",
      "GLOBAL_ACTIVE_PLAN",
    ]);
    res.json({
      success: true,
      activePlan,
      plans: ["PLAN A", "PLAN B", "PLAN C", "PLAN D"],
      buses: busOptions,
      clusters: clusterData,
      versions: {
        "PLAN B": versions["PLAN B"],
        "PLAN C": versions["PLAN C"],
        "PLAN D": versions["PLAN D"],
      },
      globalPlanVersion: versions.GLOBAL_ACTIVE_PLAN,
    });
  } catch (error) {
    logSafeError("getPlanMappingData failed", error);
    res.status(500).json({
      success: false,
      error: "Could not load plan mapping data.",
    });
  }
}

async function savePlanMapping(req, res) {
  try {
    const {
      clusterId,
      planName: rawPlanName,
      clusterName,
      rootBusId,
      memberBusIds,
      locationBusId: rawLocationBusId,
    } = req.body || {};
    const locationBusId = rawLocationBusId ? String(rawLocationBusId) : null;
    const planName = normalizePlanName(rawPlanName);
    if (!Array.isArray(memberBusIds)) {
      return res.status(400).json({
        success: false,
        error: "Provide a plan, cluster name, root bus, and valid member buses.",
      });
    }
    const normalizedMembers = [...new Set((memberBusIds || []).map(String))];

    if (
      !["PLAN B", "PLAN C", "PLAN D"].includes(planName) ||
      typeof clusterName !== "string" ||
      !clusterName.trim() ||
      !mongoose.isValidObjectId(rootBusId) ||
      normalizedMembers.some((id) => !mongoose.isValidObjectId(id)) ||
      (locationBusId && !mongoose.isValidObjectId(locationBusId)) ||
      (clusterId && !mongoose.isValidObjectId(clusterId))
    ) {
      return res.status(400).json({
        success: false,
        error: "Provide a plan, cluster name, root bus, and valid member buses.",
      });
    }

    const [currentPlan, assignmentState] = await Promise.all([
      getCurrentPlan(),
      loadPlanState(),
    ]);
    const expectedVersion = getExpectedVersion(req);
    const idempotencyKey = getIdempotencyKey(req);
    const { buses, routes, clusters: existingClusters } = assignmentState;
    const busIds = new Set(buses.map((bus) => String(bus._id)));
    const busesByIdMap = new Map(
      buses.map((bus) => [String(bus._id), bus]),
    );
    if (
      !busIds.has(String(rootBusId)) ||
      normalizedMembers.some((id) => !busIds.has(id)) ||
      (locationBusId && !busIds.has(locationBusId))
    ) {
      return res.status(400).json({
        success: false,
        error: "Every selected bus must exist.",
      });
    }
    const existingClustersById = new Map(
      existingClusters.map((cluster) => [String(cluster._id), cluster]),
    );
    const editedCluster = clusterId
      ? existingClustersById.get(String(clusterId))
      : null;
    if (clusterId && !editedCluster) {
      return res.status(404).json({ success: false, error: "Cluster not found." });
    }
    if (locationBusId) {
      if (locationBusId === String(rootBusId)) {
        return res.status(400).json({
          success: false,
          error: "Choose a spare bus different from the route root.",
        });
      }
      if (normalizedMembers.includes(locationBusId)) {
        return res.status(400).json({
          success: false,
          error: "A mapped member bus cannot also be the temporary location bus.",
        });
      }
      const locationBus = busesByIdMap.get(locationBusId);
      const currentLocationBusId = editedCluster?.location_bus_id
        ? String(editedCluster.location_bus_id)
        : null;
      if (
        (locationBus?.status !== "active" &&
          locationBus?.alteration_type !== "alter") ||
        (currentLocationBusId !== locationBusId &&
          getInUseLocationBusIds(
            assignmentState.busIdsByUser,
            currentPlan,
            assignmentState.clusters,
          ).has(locationBusId))
      ) {
        return res.status(409).json({
          success: false,
          error: "The temporary location bus must be available and have no riders currently assigned to it.",
        });
      }
    }
    const plansByBusId = new Map(
      buses.map((bus) => [String(bus._id), new Set()]),
    );
    for (const route of routes) {
      plansByBusId
        .get(String(route.bus_id))
        ?.add(normalizePlanName(route.plan_name));
    }
    for (const bus of buses) {
      for (const route of bus.combined_routes || []) {
        plansByBusId
          .get(String(bus._id))
          ?.add(normalizePlanName(route.plan_name));
      }
    }
    const busesById = Object.fromEntries(
      buses.map((bus) => [
        String(bus._id),
        {
          plans: [...(plansByBusId.get(String(bus._id)) || [])],
          status: bus.status,
        },
      ]),
    );
    const otherClusters = existingClusters
      .filter(
        (cluster) =>
          String(cluster._id) !== String(clusterId || "") &&
          normalizePlanName(cluster.plan_name) === planName,
      )
      .map((cluster) => ({
        ...cluster,
        member_bus_ids: (cluster.member_bus_ids || []).filter(
          (id) => !normalizedMembers.includes(String(id)),
        ),
      }));
    const rootOwner = otherClusters.find(
      (cluster) => String(cluster.root_bus_id) === String(rootBusId),
    );
    if (rootOwner && !editedCluster) {
      return res.status(409).json({
        success: false,
        error: "This root bus already belongs to another cluster. Edit that cluster to swap its root.",
      });
    }
    const oldRootBusId = editedCluster
      ? String(editedCluster.root_bus_id)
      : null;
    if (rootOwner && oldRootBusId) {
      rootOwner.root_bus_id = oldRootBusId;
    }

    const validationErrors = validateCluster(
      {
        clusterId,
        planName,
        rootBusId,
        memberBusIds: normalizedMembers,
      },
      busesById,
      otherClusters,
    );
    if (validationErrors.length) {
      return res.status(400).json({
        success: false,
        error: validationErrors.join(" "),
        validationErrors,
      });
    }
    const savedId = clusterId || String(new mongoose.Types.ObjectId());
    const oldActiveClusters =
      currentPlan === planName ? assignmentState.clusters : [];
    const operations = otherClusters
      .filter((cluster) => {
        const existing = existingClustersById.get(String(cluster._id));
        const oldMembers = (existing?.member_bus_ids || []).map(String).sort();
        const nextMembers = (cluster.member_bus_ids || []).map(String).sort();
        return (
          existing &&
          oldMembers.join(",") !== nextMembers.join(",") ||
          existing &&
          String(existing.root_bus_id) !== String(cluster.root_bus_id)
        );
      })
      .map((cluster) => ({
        updateOne: {
          filter: { _id: cluster._id },
          update: {
            $set: {
              root_bus_id: cluster.root_bus_id,
              location_bus_id: cluster.location_bus_id || null,
              member_bus_ids: cluster.member_bus_ids,
            },
          },
        },
      }));
    operations.push({
      updateOne: {
        filter: { _id: savedId },
        update: {
          $set: {
            plan_name: planName,
            cluster_name: clusterName.trim(),
            root_bus_id: rootBusId,
            location_bus_id: locationBusId,
            member_bus_ids: normalizedMembers,
          },
        },
        upsert: true,
      },
    });
    const nextCluster = {
      _id: savedId,
      plan_name: planName,
      cluster_name: clusterName.trim(),
      root_bus_id: rootBusId,
      location_bus_id: locationBusId,
      member_bus_ids: normalizedMembers,
    };
    const nextPlanClusters = [
      ...otherClusters,
      nextCluster,
    ];
    const nextState = {
      ...assignmentState,
      clusters: [
        ...assignmentState.clusters.filter(
          (cluster) => normalizePlanName(cluster.plan_name) !== planName,
        ),
        ...nextPlanClusters,
      ],
    };
    const notifications =
      currentPlan === planName
        ? getPlanMappingChangeNotifications(
            nextState,
            currentPlan,
            oldActiveClusters,
          )
        : [];
    const mutation = await runPlanMappingMutation({
      scope: planName,
      idempotencyKey,
      expectedVersion,
      actorId: req.user?.id,
      action: "plan-mapping-save",
      request: {
        clusterId: clusterId || null,
        planName,
        clusterName: clusterName.trim(),
        rootBusId: String(rootBusId),
        locationBusId,
        memberBusIds: normalizedMembers,
        expectedVersion,
      },
      previousState: assignmentState.clusters
        .filter((cluster) => normalizePlanName(cluster.plan_name) === planName),
      newState: nextPlanClusters,
      recipients: notifications.map((notification) => ({
        user_id: notification.user_id,
        notification,
      })),
      mutate: (session) =>
        PlanMapping.bulkWrite(operations, {
          ordered: true,
          ...(session ? { session } : {}),
        }),
    });
    const io = getIO();
    if (io) {
      try {
        io.emit("bus-update", { actionType: "PLAN_MAPPING_CHANGED" });
      } catch (error) {
        logSafeError("Plan mapping websocket broadcast deferred", error);
      }
    }
    res.json({
      success: true,
      clusterId: String(savedId),
      version: mutation.version,
      duplicate: mutation.duplicate,
      notifiedUsers: notifications.length,
    });
  } catch (error) {
    respondMutationError(res, error, "Could not save this plan mapping.");
  }
}

async function updatePlanMappingRoutes(req, res) {
  try {
    if (!mongoose.isValidObjectId(req.params.clusterId)) {
      return res.status(400).json({ success: false, error: "Invalid cluster id." });
    }
    const cluster = await PlanMapping.findById(req.params.clusterId).lean();
    const stops = req.body?.stops;
    if (!cluster) {
      return res.status(404).json({ success: false, error: "Cluster not found." });
    }
    if (!Array.isArray(stops) || stops.length === 0 || stops.length > 100) {
      return res.status(400).json({
        success: false,
        error: "Add between 1 and 100 stops to this route.",
      });
    }

    const stopNames = stops.map((input) =>
      String(input?.stopName || "").trim(),
    );
    for (const [index, stopName] of stopNames.entries()) {
      if (!stopName) {
        return res.status(400).json({
          success: false,
          error: `Enter a stop name for route row ${index + 1}.`,
        });
      }
    }
    const resolvedStops = await resolvePlanMappingStops(
      stops.map((input, index) => ({
        stopId: input?.stopId,
        stopName: stopNames[index],
      })),
    );
    const normalizedStops = [];
    for (const [index, input] of stops.entries()) {
      const stopName = stopNames[index];
      const { stop, ambiguous } = resolvedStops[index];
      if (!stop) {
        return res.status(400).json({
          success: false,
          error: ambiguous
            ? `Stop "${stopName}" matches more than one verified stop.`
            : `Stop "${stopName}" is not a verified stop.`,
        });
      }
      let arrivalTime;
      try {
        arrivalTime = normalizeArrivalTime(input?.arrivalTime);
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: `Route row ${index + 1}: ${error.message}`,
        });
      }
      normalizedStops.push({
        stopId: stop.stopId,
        stop_name: stop.name,
        stop_order: index + 1,
        arrival_time: arrivalTime,
      });
    }

    const rootBus = await Bus.findById(cluster.root_bus_id);
    if (!rootBus) {
      return res.status(404).json({ success: false, error: "Root bus not found." });
    }
    const expectedBusVersion = getExpectedBusVersion(req);
    if (expectedBusVersion === null) {
      return res.status(428).json({
        success: false,
        error: "Provide the current root bus revision.",
        code: "BUS_REVISION_REQUIRED",
      });
    }
    const planName = normalizePlanName(cluster.plan_name);
    const existingRows = await BusRoute.find({
      bus_id: rootBus._id,
      plan_name: planName,
    })
      .select("_id stopId stop_name stop_order arrival_time")
      .lean();
    const embeddedCombined = (rootBus.combined_routes || []).some(
      (route) => normalizePlanName(route.plan_name) === planName,
    );
    const embeddedAlteration =
      rootBus.alteration_route_source === "custom" &&
      (rootBus.alteration_routes || []).some(
        (route) => normalizePlanName(route.plan_name) === planName,
      );
    if (!existingRows.length && !embeddedCombined && !embeddedAlteration) {
      return res.status(409).json({
        success: false,
        error: "The root bus route is not stored as editable uploaded route data.",
      });
    }

    const previousRows = existingRows;
    const oldCombinedRoutes = rootBus.combined_routes;
    const oldAlterationRoutes = rootBus.alteration_routes;
    if (embeddedCombined) {
      rootBus.combined_routes = [
        ...(rootBus.combined_routes || []).filter(
          (route) => normalizePlanName(route.plan_name) !== planName,
        ),
        ...normalizedStops.map((stop) => ({
          ...stop,
          plan_name: planName,
        })),
      ];
    }
    if (embeddedAlteration) {
      rootBus.alteration_routes = [
        ...(rootBus.alteration_routes || []).filter(
          (route) => normalizePlanName(route.plan_name) !== planName,
        ),
        ...normalizedStops.map((stop) => ({
          ...stop,
          plan_name: planName,
        })),
      ];
    }
    const state = await loadPlanState();
    const notifications = getClusterChangeNotifications(
      state,
      cluster,
      planName,
      true,
    );
    const currentPlan = await getCurrentPlan();
    const affectedNotifications = currentPlan === planName ? notifications : [];
    const expectedVersion = getExpectedVersion(req);
    const mutation = await runPlanMappingMutation({
      scope: planName,
      idempotencyKey: getIdempotencyKey(req),
      expectedVersion,
      actorId: req.user?.id,
      action: "plan-mapping-routes-update",
      request: {
        clusterId: String(cluster._id),
        planName,
        stops: normalizedStops,
        expectedVersion,
        expectedBusVersion,
      },
      previousState: {
        clusterId: String(cluster._id),
        routes: previousRows,
        combinedRoutes: oldCombinedRoutes,
        alterationRoutes: oldAlterationRoutes,
        rootBusRevision: rootBus.revision ?? 0,
      },
      newState: {
        clusterId: String(cluster._id),
        routes: normalizedStops,
        rootBusRevision: (rootBus.revision ?? 0) + 1,
      },
      recipients: affectedNotifications.map((notification) => ({
        user_id: notification.user_id,
        notification,
      })),
      mutate: async (session) => {
        const options = session ? { session } : {};
        const revisionFilter = expectedBusVersion === 0
          ? {
              $or: [
                { revision: 0 },
                { revision: { $exists: false } },
              ],
            }
          : { revision: expectedBusVersion };
        const busUpdate = {};
        if (embeddedCombined) busUpdate.combined_routes = rootBus.combined_routes;
        if (embeddedAlteration) busUpdate.alteration_routes = rootBus.alteration_routes;
        const updatedRootBus = await Bus.findOneAndUpdate(
          {
            $and: [
              { _id: rootBus._id },
              revisionFilter,
            ],
          },
          {
            ...(Object.keys(busUpdate).length ? { $set: busUpdate } : {}),
            $inc: { revision: 1 },
          },
          {
            new: true,
            runValidators: true,
            ...options,
          },
        ).lean();
        if (!updatedRootBus) {
          const error = new Error(
            "The root bus changed. Reload plan mappings before editing this route.",
          );
          error.code = "BUS_REVISION_CONFLICT";
          error.statusCode = 409;
          throw error;
        }
        if (existingRows.length) {
          await BusRoute.deleteMany(
            { bus_id: rootBus._id, plan_name: planName },
            options,
          );
          await BusRoute.insertMany(
            normalizedStops.map((stop) => ({
              bus_id: rootBus._id,
              plan_name: planName,
              ...stop,
            })),
            options,
          );
        }
        return {
          response: {
            stops: normalizedStops.map((stop) => ({
              stopName: stop.stop_name,
              stopId: stop.stopId,
              stopOrder: stop.stop_order,
              arrivalTime: stop.arrival_time,
            })),
            notifiedUsers: affectedNotifications.length,
            busRevision: updatedRootBus.revision,
          },
        };
      },
    });
    const io = getIO();
    if (io) {
      try {
        io.emit("bus-update", { actionType: "PLAN_MAPPING_CHANGED" });
      } catch (error) {
        logSafeError("Plan mapping websocket broadcast deferred", error);
      }
    }

    res.json({
      success: true,
      ...mutation.response,
      version: mutation.version,
      duplicate: mutation.duplicate,
    });
  } catch (error) {
    respondMutationError(res, error, "Could not update the root bus route.");
  }
}

async function deletePlanMapping(req, res) {
  try {
    if (!mongoose.isValidObjectId(req.params.clusterId)) {
      return res.status(400).json({ success: false, error: "Invalid cluster id." });
    }
    const cluster = await PlanMapping.findById(req.params.clusterId).lean();
    if (!cluster) {
      return res.status(404).json({ success: false, error: "Cluster not found." });
    }
    const currentPlan = await getCurrentPlan();
    const previousState =
      currentPlan === normalizePlanName(cluster.plan_name)
        ? await loadPlanState()
        : null;
    const planName = normalizePlanName(cluster.plan_name);
    const planState = previousState || await loadPlanState();
    const nextState = {
      ...planState,
      clusters: planState.clusters.filter(
        (item) => String(item._id) !== String(cluster._id),
      ),
    };
    const notifications =
      currentPlan === planName
        ? getPlanMappingChangeNotifications(
            nextState,
            currentPlan,
            planState.clusters,
          )
        : [];
    const mutation = await runPlanMappingMutation({
      scope: planName,
      idempotencyKey: getIdempotencyKey(req),
      expectedVersion: getExpectedVersion(req),
      actorId: req.user?.id,
      action: "plan-mapping-delete",
      request: {
        clusterId: String(cluster._id),
        planName,
        expectedVersion: getExpectedVersion(req),
      },
      previousState: cluster,
      newState: null,
      recipients: notifications.map((notification) => ({
        user_id: notification.user_id,
        notification,
      })),
      mutate: (session) =>
        PlanMapping.deleteOne(
          { _id: cluster._id },
          session ? { session } : {},
        ),
    });
    const io = getIO();
    if (io) {
      try {
        io.emit("bus-update", { actionType: "PLAN_MAPPING_CHANGED" });
      } catch (error) {
        logSafeError("Plan mapping websocket broadcast deferred", error);
      }
    }
    res.json({
      success: true,
      version: mutation.version,
      duplicate: mutation.duplicate,
      notifiedUsers: notifications.length,
    });
  } catch (error) {
    respondMutationError(res, error, "Could not delete this plan mapping.");
  }
}

async function getPlanMappingAudit(req, res) {
  const pagination = parsePagination(req.query || {}, {
    defaultLimit: 50,
    maxLimit: 100,
  });
  if (pagination.error) {
    return res.status(400).json({
      success: false,
      error: pagination.error,
    });
  }
  try {
    const filter = {};
    if (typeof req.query?.scope === "string" && req.query.scope.trim()) {
      filter.resource_id = req.query.scope.trim().toUpperCase();
    }
    const [items, total] = await Promise.all([
      AdministrativeChangeAudit.find(filter)
        .select(
          "_id actor_id action resource_id request_id previous_state new_state createdAt",
        )
        .sort({ createdAt: -1, _id: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit)
        .lean(),
      AdministrativeChangeAudit.countDocuments(filter),
    ]);
    return res.json({
      success: true,
      items,
      page: pagination.page,
      limit: pagination.limit,
      total,
    });
  } catch (error) {
    logSafeError("getPlanMappingAudit failed", error);
    return res.status(500).json({
      success: false,
      error: "Could not load plan mapping audit history.",
    });
  }
}

module.exports = {
  deletePlanMapping,
  getPlanMappingAudit,
  getPlanMappingData,
  savePlanMapping,
  updatePlanMappingRoutes,
};
