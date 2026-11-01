const mongoose = require("mongoose");
const AppSetting = require("../models/AppSetting");
const Bus = require("../models/Bus");
const BusRoute = require("../models/BusRoute");
const PlanMapping = require("../models/PlanMapping");
const Notification = require("../models/Notification");
const User = require("../models/User");
const StopMaster = require("../models/StopMaster");
const { getIO } = require("../socket");
const {
  getClusterChangeNotifications,
  getInUseLocationBusIds,
  getPlanMappingChangeNotifications,
  loadPlanState,
} = require("../services/planMappingService");
const {
  normalizeArrivalTime,
  validateCluster,
} = require("../utils/planMapping");
const findVerifiedStop = require("../utils/findVerifiedStop");

const GLOBAL_ACTIVE_PLAN_KEY = "global_active_plan";

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
        .select("_id bus_no preview_number status alteration_type combined_route_source combined_routes alteration_route_source alteration_routes")
        .sort({ preview_number: 1, bus_no: 1 })
        .lean(),
      BusRoute.find({}).select("bus_id plan_name stopId stop_name stop_order arrival_time").lean(),
      PlanMapping.find({})
        .populate("root_bus_id", "_id bus_no preview_number status")
        .populate("location_bus_id", "_id bus_no preview_number status")
        .populate("member_bus_ids", "_id bus_no preview_number status")
        .sort({ plan_name: 1, cluster_name: 1 })
        .lean(),
      User.find({ role: "student", is_active: true })
        .select("bus_no")
        .lean(),
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
    for (const user of users) {
      const id = identifierToBusId.get(String(user.bus_no || "").trim().toUpperCase());
      if (id) userCountByBus.set(id, (userCountByBus.get(id) || 0) + 1);
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
    const busIdsByUser = users.map((user) =>
      identifierToBusId.get(String(user.bus_no || "").trim().toUpperCase()) || null,
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
        previewNumber: bus.preview_number,
        status: bus.status,
        plans,
        assignedUsers: userCountByBus.get(id) || 0,
        currentlyInUse: inUseBusIds.has(id),
        canBeTemporaryLocation:
          bus.status === "active" || bus.alteration_type === "alter",
      };
    });

    const clusterData = clusters.map((cluster) => ({
      id: String(cluster._id),
      planName: cluster.plan_name,
      clusterName: cluster.cluster_name,
      rootBus: cluster.root_bus_id
        ? busOptions.find((bus) => bus.id === String(cluster.root_bus_id._id))
        : null,
      locationBus: cluster.location_bus_id
        ? busOptions.find((bus) => bus.id === String(cluster.location_bus_id._id))
        : null,
      memberBuses: (cluster.member_bus_ids || [])
        .map((member) =>
          busOptions.find((bus) => bus.id === String(member._id)),
        )
        .filter(Boolean),
      rootStops: (routesByBusAndPlan.get(
        `${String(cluster.root_bus_id?._id)}:${cluster.plan_name}`,
      ) || []).sort((a, b) => a.stopOrder - b.stopOrder),
    }));

    res.json({
      success: true,
      activePlan,
      plans: ["PLAN A", "PLAN B", "PLAN C", "PLAN D"],
      buses: busOptions,
      clusters: clusterData,
    });
  } catch (error) {
    console.error("getPlanMappingData error:", error);
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

    const [buses, routes, existingClusters, currentPlan, assignmentState] = await Promise.all([
      Bus.find({})
        .select("_id bus_no preview_number status alteration_type combined_routes")
        .lean(),
      BusRoute.find({}).select("bus_id plan_name").lean(),
      PlanMapping.find({}).lean(),
      getCurrentPlan(),
      loadPlanState(),
    ]);
    const busIds = new Set(buses.map((bus) => String(bus._id)));
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
    const editedCluster = clusterId
      ? existingClusters.find((cluster) => String(cluster._id) === String(clusterId))
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
      const locationBus = buses.find(
        (bus) => String(bus._id) === locationBusId,
      );
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
        const existing = existingClusters.find(
          (item) => String(item._id) === String(cluster._id),
        );
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
    await PlanMapping.bulkWrite(operations, { ordered: true });
    if (currentPlan === planName) {
      const state = await loadPlanState();
      const notifications = getPlanMappingChangeNotifications(
        state,
        currentPlan,
        oldActiveClusters,
      );
      if (notifications.length) {
        try {
          await Notification.insertMany(notifications);
        } catch (error) {
          console.error("savePlanMapping notification persistence error:", error);
          const io = getIO();
          if (io) io.emit("bus-update", { actionType: "PLAN_MAPPING_CHANGED" });
          return res.status(500).json({
            success: false,
            mappingSaved: true,
            error: "Mapping saved, but affected users could not be notified.",
          });
        }
      }
      const io = getIO();
      if (io) {
        notifications.forEach((notification) => {
          io.to(`user_${String(notification.user_id)}`).emit("notification", {
            type: notification.type,
            message: notification.message,
            newPreview: notification.new_preview,
            isBusActive: notification.is_bus_active,
          });
        });
      }
    } else if (
      editedCluster &&
      String(editedCluster.location_bus_id || "") !== String(locationBusId || "")
    ) {
      const state = await loadPlanState();
      const updatedCluster = state.clusters.find(
        (cluster) => String(cluster._id) === String(savedId),
      );
      const notifications = updatedCluster
        ? getClusterChangeNotifications(state, updatedCluster, planName)
        : [];
      if (notifications.length) {
        try {
          await Notification.insertMany(notifications);
        } catch (error) {
          console.error("savePlanMapping notification persistence error:", error);
          const io = getIO();
          if (io) io.emit("bus-update", { actionType: "PLAN_MAPPING_CHANGED" });
          return res.status(500).json({
            success: false,
            mappingSaved: true,
            error: "Mapping saved, but affected users could not be notified.",
          });
        }
        const io = getIO();
        if (io) {
          notifications.forEach((notification) => {
            io.to(`user_${String(notification.user_id)}`).emit("notification", {
              type: notification.type,
              message: notification.message,
              newPreview: notification.new_preview,
              isBusActive: notification.is_bus_active,
            });
          });
        }
      }
    }
    const io = getIO();
    if (io) io.emit("bus-update", { actionType: "PLAN_MAPPING_CHANGED" });
    res.json({ success: true, clusterId: String(savedId) });
  } catch (error) {
    console.error("savePlanMapping error:", error);
    res.status(500).json({
      success: false,
      error: "Could not save this plan mapping.",
    });
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

    const normalizedStops = [];
    for (const [index, input] of stops.entries()) {
      const stopName = String(input?.stopName || "").trim();
      if (!stopName) {
        return res.status(400).json({
          success: false,
          error: `Enter a stop name for route row ${index + 1}.`,
        });
      }
      let stop;
      let ambiguous = false;
      if (input?.stopId) {
        stop = await StopMaster.findOne({ stopId: String(input.stopId) }).lean();
        if (stop && stop.name.trim().toLowerCase() !== stopName.toLowerCase()) {
          stop = null;
        }
      } else {
        ({ stop, ambiguous } = await findVerifiedStop({ name: stopName }));
        if (!stop && !ambiguous) {
          stop = await StopMaster.findOne({
            status: "PENDING",
            name: stopName,
          }).lean();
        }
      }
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
    const planName = normalizePlanName(cluster.plan_name);
    const existingRows = await BusRoute.find({
      bus_id: rootBus._id,
      plan_name: planName,
    })
      .select("_id")
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

    if (existingRows.length) {
      await BusRoute.deleteMany({ bus_id: rootBus._id, plan_name: planName });
      await BusRoute.insertMany(
        normalizedStops.map((stop) => ({
          bus_id: rootBus._id,
          plan_name: planName,
          ...stop,
        })),
      );
    }
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
    if (embeddedCombined || embeddedAlteration) await rootBus.save();

    const state = await loadPlanState();
    const notifications = getClusterChangeNotifications(
      state,
      cluster,
      planName,
      true,
    );
    if (notifications.length) {
      try {
        await Notification.insertMany(notifications);
      } catch (error) {
        console.error("updatePlanMappingRoutes notification persistence error:", error);
        const io = getIO();
        if (io) io.emit("bus-update", { actionType: "PLAN_MAPPING_CHANGED" });
        return res.status(500).json({
          success: false,
          routeUpdated: true,
          error: "Route updated, but affected users could not be notified.",
        });
      }
      const io = getIO();
      if (io) {
        notifications.forEach((notification) => {
          io.to(`user_${String(notification.user_id)}`).emit("notification", {
            type: notification.type,
            message: notification.message,
            newPreview: notification.new_preview,
            isBusActive: true,
          });
        });
      }
    }
    const io = getIO();
    if (io) io.emit("bus-update", { actionType: "PLAN_MAPPING_CHANGED" });

    res.json({
      success: true,
      stops: normalizedStops.map((stop) => ({
        stopName: stop.stop_name,
        stopId: stop.stopId,
        stopOrder: stop.stop_order,
        arrivalTime: stop.arrival_time,
      })),
      notifiedUsers: notifications.length,
    });
  } catch (error) {
    console.error("updatePlanMappingRoutes error:", error);
    res.status(500).json({
      success: false,
      error: "Could not update the root bus route.",
    });
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
    await PlanMapping.deleteOne({ _id: cluster._id });
    if (previousState) {
      const state = await loadPlanState();
      const notifications = getPlanMappingChangeNotifications(
        state,
        currentPlan,
        previousState.clusters,
      );
      if (notifications.length) {
        try {
          await Notification.insertMany(notifications);
        } catch (error) {
          console.error("deletePlanMapping notification persistence error:", error);
          return res.status(500).json({
            success: false,
            mappingDeleted: true,
            error: "Cluster deleted, but affected users could not be notified.",
          });
        }
      }
      const io = getIO();
      if (io) {
        notifications.forEach((notification) => {
          io.to(`user_${String(notification.user_id)}`).emit("notification", {
            type: notification.type,
            message: notification.message,
            newPreview: notification.new_preview,
            isBusActive: notification.is_bus_active,
          });
        });
      }
    }
    const io = getIO();
    if (io) io.emit("bus-update", { actionType: "PLAN_MAPPING_CHANGED" });
    res.json({ success: true });
  } catch (error) {
    console.error("deletePlanMapping error:", error);
    res.status(500).json({
      success: false,
      error: "Could not delete this plan mapping.",
    });
  }
}

module.exports = {
  deletePlanMapping,
  getPlanMappingData,
  savePlanMapping,
  updatePlanMappingRoutes,
};
