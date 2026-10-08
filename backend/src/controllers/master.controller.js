const User = require("../models/User");
const Bus = require("../models/Bus");
const BusLiveLocation = require("../models/BusLiveLocation");
const {
  getCurrentGlobalPlan,
  getRoutesForBus,
  getAssignedBusRoutes,
  getIncomingBusChanges,
  resolveEffectiveBus,
} = require("./bus.controller");
const {
  getCollegeArrival,
  getMasterRecommendation,
  selectBestMasterRecommendation,
} = require("../utils/masterRecommendation");
const getMasterServiceIdentity = require("../utils/masterServiceIdentity");

const GPS_FRESHNESS_MS = 3 * 60 * 1000;

function isCoordinate(value, minimum, maximum) {
  return (
    value !== undefined &&
    value !== null &&
    String(value).trim() !== "" &&
    Number.isFinite(Number(value)) &&
    Number(value) >= minimum &&
    Number(value) <= maximum
  );
}

function normalizeBusIdentifier(value) {
  return String(value ?? "").trim().toUpperCase();
}

async function findAssignedBus(identifier) {
  const normalized = normalizeBusIdentifier(identifier);
  if (!normalized) return null;
  return (
    (await Bus.findOne({ bus_no: normalized }).lean()) ||
    (await Bus.findOne({ preview_number: normalized }).lean())
  );
}

async function getRecommendation(req, res) {
  const latitude = Number(req.query.latitude);
  const longitude = Number(req.query.longitude);
  if (
    !isCoordinate(req.query.latitude, -90, 90) ||
    !isCoordinate(req.query.longitude, -180, 180)
  ) {
    return res.status(400).json({
      success: false,
      error: "Valid user latitude and longitude are required.",
    });
  }

  const collegeArrival = getCollegeArrival({ latitude, longitude });
  if (collegeArrival) {
    return res.json({
      success: true,
      ...collegeArrival,
      message: "You are already at KIOT College.",
    });
  }

  try {
    const user = await User.findById(req.user.id)
      .select("bus_no role is_active deleted_by_user")
      .lean();
    if (!user || !user.is_active || user.deleted_by_user) {
      return res.status(403).json({
        success: false,
        error: "An active account is required to use Master.",
      });
    }

    const assignedBus = await findAssignedBus(user.bus_no);
    const effectiveAssignedBus = assignedBus
      ? await resolveEffectiveBus(assignedBus)
      : null;
    const activePlan = await getCurrentGlobalPlan();
    const activeBuses = await Bus.find({ status: "active" })
      .sort({ bus_no: 1 })
      .lean();
    if (!activeBuses.length) {
      return res.json({
        success: true,
        status: "NO_ACTIVE_BUSES",
        message: "There are no active buses right now.",
        plan: activePlan,
        recommendation: null,
      });
    }

    const services = await Promise.all(
      activeBuses.map(async (bus) => {
        const [operationalBus, incomingChanges] = await Promise.all([
          resolveEffectiveBus(bus),
          getIncomingBusChanges(bus),
        ]);
        const isAssignedOperationalService =
          assignedBus &&
          effectiveAssignedBus &&
          String(operationalBus?._id) === String(effectiveAssignedBus._id);
        const routes = isAssignedOperationalService
          ? await getAssignedBusRoutes(assignedBus)
          : await getRoutesForBus(bus);
        const planRoutes = routes
          .filter(
            (route) =>
              String(route.plan_name || "").toUpperCase() === activePlan,
          )
          .sort(
            (first, second) =>
              Number(first.stop_order) - Number(second.stop_order),
          );
        return {
          bus,
          incomingChanges,
          operationalBus,
          isAssignedOperationalService,
          planRoutes,
          routeStops: planRoutes.map((route) => ({
            stopId: route.stopId,
            name: route.stop_name,
            stop_order: route.stop_order,
            latitude: route.latitude,
            longitude: route.longitude,
            status: route.stopStatus,
          })),
        };
      }),
    );
    const routedServices = services.filter((service) => service.planRoutes.length);
    if (!routedServices.length) {
      return res.json({
        success: true,
        status: "NOT_IN_ACTIVE_PLAN",
        message: `No active buses have a route in the active plan (${activePlan}).`,
        plan: activePlan,
        recommendation: null,
      });
    }

    const runningServices = routedServices.filter(
      (service) => service.operationalBus?.status === "active",
    );
    if (!runningServices.length) {
      return res.json({
        success: true,
        status: "BUS_INACTIVE",
        message: "No active bus is currently available for the selected plan.",
        plan: activePlan,
        recommendation: null,
      });
    }

    const operationalBusIds = [
      ...new Set(runningServices.map((service) => String(service.operationalBus._id))),
    ];
    const liveLocations = await BusLiveLocation.find({
      bus_id: { $in: operationalBusIds },
    })
      .select(
        "bus_id latitude longitude speed speedKmh is_online lastSuccessfulGpsUpdate lastUpdated updatedAt",
      )
      .lean();
    const locationByBusId = new Map(
      liveLocations.map((location) => [String(location.bus_id), location]),
    );
    const now = Date.now();
    const evaluated = runningServices.map((service) => {
      const location = locationByBusId.get(String(service.operationalBus._id));
      const lastSuccessfulGpsUpdate = location?.lastSuccessfulGpsUpdate;
      const isGpsFresh =
        !!location?.is_online &&
        !!lastSuccessfulGpsUpdate &&
        now - new Date(lastSuccessfulGpsUpdate).getTime() <= GPS_FRESHNESS_MS &&
        isCoordinate(location.latitude, -90, 90) &&
        isCoordinate(location.longitude, -180, 180);
      const serviceIdentity = getMasterServiceIdentity({
        bus: service.bus,
        operationalBus: service.operationalBus,
        assignedBus,
        incomingChanges: service.incomingChanges,
        isAssignedOperationalService: service.isAssignedOperationalService,
      });
      const isOriginalAssignedBus =
        service.isAssignedOperationalService &&
        String(service.bus._id) === String(assignedBus?._id) &&
        assignedBus?.status === "active";
      const isAlteredAssignedBus =
        service.isAssignedOperationalService &&
        String(service.operationalBus._id) !== String(assignedBus?._id);
      const assignmentPriority = isOriginalAssignedBus
        ? 0
        : isAlteredAssignedBus
          ? 1
          : 2;
      const base = {
        ...serviceIdentity,
        routeId: null,
        userLocation: { latitude, longitude },
        gps: isGpsFresh
          ? {
              latitude: Number(location.latitude),
              longitude: Number(location.longitude),
              status: "ONLINE",
              lastUpdated: lastSuccessfulGpsUpdate,
            }
          : {
              latitude: null,
              longitude: null,
              status: "UNAVAILABLE",
              lastUpdated: lastSuccessfulGpsUpdate || null,
            },
      };
      if (!isGpsFresh) {
        return {
          status: "GPS_UNAVAILABLE",
          recommendation: base,
          assignmentPriority,
        };
      }
      const result = getMasterRecommendation({
        userLocation: { latitude, longitude },
        busLocation: {
          latitude: Number(location.latitude),
          longitude: Number(location.longitude),
        },
        routeStops: service.routeStops,
        busSpeedKmh: location.speedKmh,
      });
      return {
        status: result.status,
        assignmentPriority,
        recommendation: result.recommendation
          ? {
              ...base,
              ...result.recommendation,
              etaUnavailableReason:
                result.recommendation.etaMinutes == null
                  ? "ETA is unavailable until the bus has multiple recent GPS fixes."
                  : null,
              status: result.recommendation.busStatus,
            }
          : base,
      };
    });

    const bestRecommendation = selectBestMasterRecommendation(evaluated);
    if (bestRecommendation) {
      return res.json({
        success: true,
        status: "RECOMMENDED",
        plan: activePlan,
        recommendation: bestRecommendation.recommendation,
      });
    }

    const statuses = evaluated.map((item) => item.status);
    const status = statuses.every((value) => value === "GPS_UNAVAILABLE")
      ? "GPS_UNAVAILABLE"
      : statuses.includes("NO_VERIFIED_STOPS")
        ? "NO_VERIFIED_STOPS"
        : statuses.includes("NO_CATCHABLE_STOPS")
          ? "NO_CATCHABLE_STOPS"
          : statuses.includes("NO_FUTURE_STOPS")
            ? "NO_FUTURE_STOPS"
            : statuses.includes("GPS_UNAVAILABLE")
              ? "GPS_UNAVAILABLE"
              : "BUS_OFF_ROUTE";
    const messageByStatus = {
      GPS_UNAVAILABLE: "Live location is currently unavailable for the active buses.",
      NO_VERIFIED_STOPS:
        "No stop with coordinates is available yet. Admins can upload the Stop Master coordinate sheet; active buses will continue to work.",
      NO_CATCHABLE_STOPS:
        "The active buses will reach their future stops before you can get there.",
      NO_FUTURE_STOPS: "The active buses have already passed their remaining stops.",
      BUS_OFF_ROUTE:
        "Active bus locations are too far from their routes to determine a waiting stop.",
    };
    return res.json({
      success: true,
      status,
      message: messageByStatus[status] || "No waiting stop is available right now.",
      plan: activePlan,
      recommendation: null,
    });
  } catch (error) {
    console.error("getMasterRecommendation error:", error);
    return res.status(500).json({
      success: false,
      error: "Could not calculate your waiting stop right now.",
    });
  }
}

module.exports = { getRecommendation };
