const mongoose = require("mongoose");
const AppSetting = require("../models/AppSetting");
const Bus = require("../models/Bus");
const BusRoute = require("../models/BusRoute");
const PlanMapping = require("../models/PlanMapping");
const Notification = require("../models/Notification");
const User = require("../models/User");
const { getIO } = require("../socket");
const {
  getPlanMappingChangeNotifications,
  loadPlanState,
} = require("../services/planMappingService");
const {
  validateCluster,
} = require("../utils/planMapping");

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
        .select("_id bus_no preview_number status combined_routes")
        .sort({ preview_number: 1, bus_no: 1 })
        .lean(),
      BusRoute.find({}).select("bus_id plan_name stop_name stop_order arrival_time").lean(),
      PlanMapping.find({})
        .populate("root_bus_id", "_id bus_no preview_number status")
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
    for (const route of routes) {
      const busId = String(route.bus_id);
      const plan = normalizePlanName(route.plan_name);
      if (!planNamesByBus.has(busId)) planNamesByBus.set(busId, new Set());
      planNamesByBus.get(busId).add(plan);
      const key = `${busId}:${plan}`;
      const planRoutes = routesByBusAndPlan.get(key) || [];
      planRoutes.push({
        stopName: route.stop_name,
        stopOrder: route.stop_order,
        arrivalTime: route.arrival_time || null,
      });
      routesByBusAndPlan.set(key, planRoutes);
    }
    for (const bus of buses) {
      for (const route of bus.combined_routes || []) {
        const id = String(bus._id);
        const plan = normalizePlanName(route.plan_name);
        if (!planNamesByBus.has(id)) planNamesByBus.set(id, new Set());
        planNamesByBus.get(id).add(plan);
        const key = `${id}:${plan}`;
        const planRoutes = routesByBusAndPlan.get(key) || [];
        planRoutes.push({
          stopName: route.stop_name,
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
      };
    });

    const clusterData = clusters.map((cluster) => ({
      id: String(cluster._id),
      planName: cluster.plan_name,
      clusterName: cluster.cluster_name,
      rootBus: cluster.root_bus_id
        ? busOptions.find((bus) => bus.id === String(cluster.root_bus_id._id))
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
    } = req.body || {};
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
      (clusterId && !mongoose.isValidObjectId(clusterId))
    ) {
      return res.status(400).json({
        success: false,
        error: "Provide a plan, cluster name, root bus, and valid member buses.",
      });
    }

    const [buses, routes, existingClusters, currentPlan] = await Promise.all([
      Bus.find({})
        .select("_id bus_no preview_number status combined_routes")
        .lean(),
      BusRoute.find({}).select("bus_id plan_name").lean(),
      PlanMapping.find({}).lean(),
      getCurrentPlan(),
    ]);
    const busIds = new Set(buses.map((bus) => String(bus._id)));
    if (!busIds.has(String(rootBusId)) || normalizedMembers.some((id) => !busIds.has(id))) {
      return res.status(400).json({
        success: false,
        error: "Every selected bus must exist.",
      });
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
    const editedCluster = clusterId
      ? existingClusters.find((cluster) => String(cluster._id) === String(clusterId))
      : null;
    if (clusterId && !editedCluster) {
      return res.status(404).json({ success: false, error: "Cluster not found." });
    }
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
      currentPlan === planName ? (await loadPlanState()).clusters : [];
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
};
