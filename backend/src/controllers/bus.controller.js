const Bus = require("../models/Bus");
const BusRoute = require("../models/BusRoute");
const StopMaster = require("../models/StopMaster");
const { randomUUID } = require("node:crypto");
const BusLiveLocation = require("../models/BusLiveLocation");
const AppSetting = require("../models/AppSetting");
const User = require("../models/User");
const PlanMapping = require("../models/PlanMapping");
const BusChange = require("../models/BusChange");
const normalizeBusNumber = require("../utils/normalizeBusNumber");
const { getIO } = require("../socket");
const {
  getPlanChangeNotifications,
  loadPlanState,
} = require("../services/planMappingService");
const {
  resolveAssignedBusRoutes,
} = require("../utils/resolveBusServiceRoutes");
const isReusableTemporaryChangeSource = require("../utils/isReusableTemporaryChangeSource");
const normalizeStopName = require("../utils/normalizeStopName");
const {
  BUS_READ_FIELDS,
  getBusRouteRows: getContextBusRouteRows,
  getIncomingBusChanges: getContextIncomingBusChanges,
  getRoutesForBus: getContextRoutesForBus,
  loadBusReadContext,
  resolveEffectiveBus: resolveEffectiveBusFromContext,
} = require("../utils/busReadContext");
const {
  getEffectiveBusId,
  normalizeArrivalTime,
} = require("../utils/planMapping");
const { logSafeError } = require("../utils/safeErrorLog");
const { recordAssignmentMutation } = require("../services/assignmentPropagation");
const {
  checkIdempotentReplay,
  getMutationHeaders,
  runIdempotentMutation,
} = require("../services/mutationIdempotency");
const {
  getPlanMappingVersions,
  runPlanMappingMutation,
  runPlanMappingNoop,
} = require("../services/planMappingPersistence");
const { parsePagination } = require("../utils/pagination");
const {
  getPublicAssignmentSnapshot,
  resolveStudentAssignment,
} = require("../services/studentBusAssignment");

const GLOBAL_ACTIVE_PLAN_KEY = "global_active_plan";
const DEFAULT_PLAN_NAMES = ["PLAN A", "PLAN B", "PLAN C", "PLAN D"];

function getBusRevisionFilter(bus, expectedVersion) {
  return expectedVersion === 0
    ? {
        $or: [
          { revision: 0 },
          { revision: { $exists: false } },
        ],
      }
    : { revision: expectedVersion };
}

function getExpectedBusVersions(req, buses, primaryBus, primaryVersion) {
  const supplied = req.body?.expectedVersions;
  const normalized = new Map(
    Object.entries(
      supplied && typeof supplied === "object" && !Array.isArray(supplied)
        ? supplied
        : {},
    ).map(([key, value]) => [String(key).trim().toUpperCase(), value]),
  );
  const versions = new Map();
  for (const bus of buses) {
    const isPrimary = String(bus._id) === String(primaryBus?._id);
    const raw = isPrimary
      ? primaryVersion
      : normalized.get(String(bus.bus_no).trim().toUpperCase()) ??
        normalized.get(String(bus._id).trim().toUpperCase());
    const version = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isSafeInteger(version) || version < 0) {
      const error = new Error(
        `Provide the expected revision for bus ${bus.bus_no}.`,
      );
      error.code = "BUS_REVISION_REQUIRED";
      error.statusCode = 428;
      throw error;
    }
    versions.set(String(bus._id), version);
  }
  return versions;
}

async function updateBusAtRevision(bus, expectedVersion, update, session) {
  const query = Bus.findOneAndUpdate(
    {
      $and: [
        { _id: bus._id },
        getBusRevisionFilter(bus, expectedVersion),
      ],
    },
    {
      $set: update,
      $inc: { revision: 1 },
    },
    {
      new: true,
      runValidators: true,
      ...(session ? { session } : {}),
    },
  );
  const updated = await query.lean();
  if (!updated) {
    const error = new Error(
      `Bus ${bus.bus_no} changed. Reload before applying this update.`,
    );
    error.code = "BUS_REVISION_CONFLICT";
    error.statusCode = 409;
    throw error;
  }
  return updated;
}

async function saveBusAtRevision(bus, expectedVersion, session) {
  const excluded = new Set([
    "_id",
    "revision",
    "__v",
    "createdAt",
    "updatedAt",
  ]);
  const update = Object.fromEntries(
    bus
      .modifiedPaths()
      .filter((path) => !excluded.has(path))
      .map((path) => [path, bus.get(path)]),
  );
  const persisted = await updateBusAtRevision(
    bus,
    expectedVersion,
    update,
    session,
  );
  bus.revision = persisted.revision;
  return persisted;
}

async function runBusMutation({
  req,
  operation,
  request,
  resourceId,
  expectedVersion,
  mutate,
}) {
  const idempotencyKey = getMutationHeaders(req).idempotencyKey;
  return runIdempotentMutation({
    scope: getBusMutationScope(req, operation),
    idempotencyKey,
    actorId: req.user?.id,
    request,
    resourceId,
    expectedVersion,
    mutate,
  });
}

function getBusMutationScope(req, operation) {
  return `bus:${operation}:${String(req.user?.id || "")}`;
}

async function getBusMutationReplay(req, operation, request, expectedVersion) {
  const { idempotencyKey } = getMutationHeaders(req);
  return checkIdempotentReplay({
    scope: getBusMutationScope(req, operation),
    idempotencyKey,
    request,
    expectedVersion,
  });
}

function assignmentRecipient(userId, busNumber) {
  const assignmentBusNo = busNumber == null ? null : String(busNumber);
  return {
    user_id: userId,
    notification: {
      type: assignmentBusNo ? "bus_reassigned" : "bus_unassigned",
      message: assignmentBusNo
        ? `Your bus assignment changed to Bus ${assignmentBusNo}.`
        : "Your bus assignment was removed.",
      new_bus_no: assignmentBusNo,
    },
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseTemporaryChangeCursor(value) {
  if (value === undefined) {
    return {
      recorded: { done: false },
      legacy: { done: false },
    };
  }
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (parsed?.v !== 1) return null;
    const parsePosition = (position) => {
      if (!position || typeof position !== "object") return null;
      if (position.done === true) return { done: true };
      if (
        position.done === false &&
        position.date === undefined &&
        position.id === undefined
      ) {
        return { done: false };
      }
      const validDate =
        position.date === null ||
        (typeof position.date === "string" &&
          Number.isFinite(Date.parse(position.date)));
      if (
        !validDate ||
        !/^[a-f\d]{24}$/i.test(position.id || "")
      ) {
        return null;
      }
      return {
        date:
          position.date === null
            ? null
            : new Date(position.date).toISOString(),
        id: position.id,
        done: false,
      };
    };
    const recorded = parsePosition(parsed.recorded);
    const legacy = parsePosition(parsed.legacy);
    if (!recorded || !legacy) return null;
    return { recorded, legacy };
  } catch {
    return null;
  }
}

function addDescendingCursor(filter, field, position) {
  if (!position || position.date === undefined) return filter;
  if (position.date === null) {
    return {
      ...filter,
      $and: [
        ...(filter.$and || []),
        { [field]: null, _id: { $lt: position.id } },
      ],
    };
  }
  return {
    ...filter,
    $and: [
      ...(filter.$and || []),
      {
        $or: [
          { [field]: { $lt: new Date(position.date) } },
          {
            [field]: new Date(position.date),
            _id: { $lt: position.id },
          },
          { [field]: null },
        ],
      },
    ],
  };
}

function getCursorTimestamp(value) {
  const timestamp =
    value instanceof Date
      ? value.getTime()
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  return Number.isFinite(timestamp)
    ? { timestamp, cursorDate: new Date(timestamp).toISOString() }
    : { timestamp: Number.NEGATIVE_INFINITY, cursorDate: null };
}

function normalizePlanName(plan) {
  const value = String(plan ?? "")
    .trim()
    .toUpperCase();
  return value || "PLAN A";
}

function getInactivePlanMessage(plan) {
  return `Your bus is inactive for ${plan}. It has no route or mapped replacement for today's service. Contact the Super Admin for assistance.`;
}

async function getCurrentGlobalPlan() {
  const setting = await AppSetting.findOne({
    key: GLOBAL_ACTIVE_PLAN_KEY,
  }).lean();
  const activePlan = normalizePlanName(setting?.value || "PLAN A");
  return DEFAULT_PLAN_NAMES.includes(activePlan) ? activePlan : "PLAN A";
}

// ================= SHARED HELPERS =================
/**
 * Find a bus by EITHER its bus_no OR its preview_number.
 * bus_no is preferred when both match to avoid ambiguity.
 * Works for numeric (e.g. 4) and string ("4") preview numbers.
 */
async function findBusByIdentifier(identifier) {
  const normalizedBusNo = normalizeBusNumber(identifier);
  const raw = identifier;

  // 1) Exact bus_no match (most specific)
  let bus = await Bus.findOne({ bus_no: normalizedBusNo });
  if (bus) return bus;

  // 2) preview_number match — accept numeric and string forms
  bus = await Bus.findOne({
    preview_number: { $in: [raw, String(raw)] },
  });
  return bus;
}

async function resolveEffectiveBus(bus) {
  const visited = new Set();
  let effectiveBus = bus;
  let depth = 0;

  while (effectiveBus?.altered_to_bus_id && depth < 20) {
    const currentId = String(effectiveBus._id);
    if (visited.has(currentId)) break;
    visited.add(currentId);

    const nextBus = await Bus.findById(effectiveBus.altered_to_bus_id)
      .select(BUS_READ_FIELDS)
      .lean();
    if (!nextBus) break;
    effectiveBus = nextBus;
    depth += 1;
  }

  return effectiveBus;
}

async function resolvePlanMappingAssignment(bus, planName) {
  if (!bus || planName === "PLAN A") {
    return { routeBus: bus, locationBus: bus, hasTemporaryLocationBus: false };
  }
  const mapping = await PlanMapping.findOne({
    plan_name: planName,
    $or: [{ root_bus_id: bus._id }, { member_bus_ids: bus._id }],
  })
    .select("root_bus_id location_bus_id member_bus_ids")
    .lean();
  if (!mapping) {
    return { routeBus: bus, locationBus: bus, hasTemporaryLocationBus: false };
  }
  const isMember = (mapping.member_bus_ids || []).some(
    (memberBusId) => String(memberBusId) === String(bus._id),
  );
  const hasTemporaryLocationBus = Boolean(mapping.location_bus_id);
  const relatedBusIds = [
    ...(isMember ? [mapping.root_bus_id] : []),
    ...(hasTemporaryLocationBus ? [mapping.location_bus_id] : []),
  ];
  const relatedBuses = relatedBusIds.length
    ? await Bus.find({ _id: { $in: relatedBusIds } })
        .select(BUS_READ_FIELDS)
        .lean()
    : [];
  const relatedBusesById = new Map(
    relatedBuses.map((relatedBus) => [String(relatedBus._id), relatedBus]),
  );
  const routeBus = isMember
    ? relatedBusesById.get(String(mapping.root_bus_id)) || bus
    : bus;
  const locationBus = hasTemporaryLocationBus
    ? relatedBusesById.get(String(mapping.location_bus_id)) || routeBus
    : routeBus;
  return { routeBus, locationBus, hasTemporaryLocationBus };
}

async function loadEffectiveRoutesForAllPlans(bus, relatedBuses = []) {
  const mappings = await PlanMapping.find({
    plan_name: { $in: DEFAULT_PLAN_NAMES.filter((plan) => plan !== "PLAN A") },
    member_bus_ids: bus._id,
  })
    .select("plan_name root_bus_id")
    .lean();
  const rootIdsByPlan = new Map();
  for (const mapping of mappings) {
    if (!rootIdsByPlan.has(mapping.plan_name)) {
      rootIdsByPlan.set(mapping.plan_name, mapping.root_bus_id);
    }
  }
  const rootIds = [...new Set([...rootIdsByPlan.values()].map(String))];
  const roots = rootIds.length
    ? await Bus.find({ _id: { $in: rootIds } })
        .select(BUS_READ_FIELDS)
        .lean()
    : [];
  const rootsById = new Map(roots.map((root) => [String(root._id), root]));
  const context = await loadBusReadContext([bus, ...relatedBuses, ...roots]);
  const routeGroups = DEFAULT_PLAN_NAMES.map((planName) => {
    const rootId = rootIdsByPlan.get(planName);
    const planBus = rootId ? rootsById.get(String(rootId)) || bus : bus;
    return getContextRoutesForBus(context, planBus).filter(
      (route) => normalizeRoutePlanName(route?.plan_name) === planName,
    );
  });
  return { routes: routeGroups.flat(), context };
}

async function getEffectiveRoutesForAllPlans(bus) {
  const { routes } = await loadEffectiveRoutesForAllPlans(bus);
  return routes;
}

function buildAlterationDetails(sourceBus, effectiveBus) {
  if (!sourceBus || String(sourceBus._id) === String(effectiveBus?._id)) {
    return null;
  }

  const oldPreview = sourceBus.preview_number ?? "your current bus";
  const newPreview = effectiveBus.preview_number ?? "the replacement bus";
  const isCombined = sourceBus.alteration_type === "combine";
  return {
    isAltered: true,
    alterationType: sourceBus.alteration_type || "alter",
    message: isCombined
      ? `For today's service, use Bus ${newPreview}. Follow the selected combined route's stops and timings shown under View Stops on Home.`
      : `For today's service, use Bus ${newPreview}. Continue following Bus ${oldPreview}'s original stops and timings; open Home and tap View Stops to see them.`,
    newPreview: effectiveBus.preview_number ?? null,
    effectivePreview: effectiveBus.preview_number ?? null,
  };
}

const normalizeRoutePlanName = (planName) =>
  String(planName ?? "").trim().toUpperCase();

const hasRouteForPlan = (routes, planName) =>
  routes.some(
    (route) =>
      normalizeRoutePlanName(route?.plan_name) ===
      normalizeRoutePlanName(planName),
  );

async function getIncomingBusChanges(bus) {
  return Bus.find({
    altered_to_bus_id: bus._id,
    alteration_type: { $in: ["alter", "combine"] },
  })
    .select(
      "_id bus_no preview_number alteration_type alteration_route_source alteration_routes",
    )
    .sort({ bus_no: 1 })
    .lean();
}

function buildReplacementDetails(bus, incomingChanges) {
  const replacedBus = incomingChanges.find(
    (changedBus) => changedBus.alteration_type === "alter",
  );
  if (!replacedBus) return null;

  const originalPreview =
    replacedBus.preview_number ?? replacedBus.bus_no ?? "the original bus";
  return {
    isReplacement: true,
    alterationType: "alter",
    replacementForPreview: originalPreview,
    message: `For today's service, use Bus ${bus.preview_number ?? bus.bus_no}. Follow Bus ${originalPreview}'s original stops and timings; open Home and tap View Stops to see them.`,
  };
}

async function getRoutesForBus(bus) {
  const context = await loadBusReadContext([bus]);
  return getContextRoutesForBus(context, bus);
}

async function getAssignedBusRoutes(bus) {
  const context = await loadBusReadContext([bus]);
  const sourceRoutes = getContextBusRouteRows(context, bus._id);
  const targetRoutes = bus.altered_to_bus_id
    ? getContextBusRouteRows(context, bus.altered_to_bus_id)
    : [];
  return resolveAssignedBusRoutes(bus, sourceRoutes, targetRoutes);
}

async function getRouteSelectionLabel(bus, incomingChanges, busesById) {
  const selectedChange =
    (bus.alteration_route_source && bus) ||
    incomingChanges.find((change) => change.alteration_route_source);
  if (!selectedChange) return null;

  if (selectedChange.alteration_route_source === "custom") {
    return "Uploaded routes";
  }
  if (selectedChange.alteration_route_source === "source") {
    return `Bus ${selectedChange.preview_number ?? "selected"} routes`;
  }

  if (selectedChange === bus) {
    const targetBus = bus.altered_to_bus_id
      ? busesById?.get(String(bus.altered_to_bus_id)) ||
        (await Bus.findById(bus.altered_to_bus_id)
          .select("bus_no preview_number")
          .lean())
      : null;
    return `Bus ${targetBus?.preview_number ?? bus.altered_to_preview ?? "replacement"} routes`;
  }

  return `Bus ${bus.preview_number ?? bus.bus_no} routes`;
}

async function findStudentsAssignedToBus(bus, additionalIdentifiers = []) {
  const identifiers = [bus.bus_no];
  if (bus.preview_number != null) identifiers.push(String(bus.preview_number));
  identifiers.push(...additionalIdentifiers.filter((value) => value != null && value !== ""));
  return User.find({
    bus_no: {
      $in: identifiers.map(
        (identifier) => new RegExp(`^${escapeRegExp(identifier)}$`, "i"),
      ),
    },
    role: "student",
    is_active: true,
    deleted_by_user: { $ne: true },
  }).select("_id bus_no assignmentRevision").lean();
}

async function updateStudentAssignmentsAtRevision(
  students,
  getNextBusNo,
  session,
  conflictMessage,
) {
  for (const student of students) {
    const assignmentRevision = student.assignmentRevision ?? 0;
    const conditions = [{ _id: student._id }];
    if (Object.hasOwn(student, "bus_no")) {
      conditions.push({ bus_no: student.bus_no });
    }
    conditions.push(
      assignmentRevision === 0
        ? {
            $or: [
              { assignmentRevision: 0 },
              { assignmentRevision: { $exists: false } },
            ],
          }
        : { assignmentRevision },
    );

    const nextBusNo = getNextBusNo(student);
    const update = {
      $inc: { assignmentRevision: 1 },
      ...(nextBusNo !== undefined ? { $set: { bus_no: nextBusNo } } : {}),
    };
    const result = await User.updateOne(
      { $and: conditions },
      update,
      session ? { session } : {},
    );
    if (result.matchedCount !== 1) {
      const error = new Error(conflictMessage);
      error.code = "BUS_ASSIGNMENT_CONFLICT";
      error.statusCode = 409;
      throw error;
    }
  }
}

// ================= UPDATE BUS =================
async function updateBusNumber(req, res) {
  try {
    const { busNo } = req.params;
    const { newBusNo, previewNumber } = req.body;
    const { expectedVersion, idempotencyKey } = getMutationHeaders(req);
    const normalizedBusNo = normalizeBusNumber(busNo);
    const normalizedNewBusNo = newBusNo ? normalizeBusNumber(newBusNo) : null;
    const request = {
      busNo: normalizedBusNo,
      newBusNo: normalizedNewBusNo,
      previewNumber,
      expectedVersion,
    };
    const replay = await getBusMutationReplay(
      req,
      "update-number",
      request,
      expectedVersion,
    );
    if (replay) {
      return res.status(200).json({
        success: true,
        ...replay.response,
        duplicate: true,
      });
    }

    const currentBus = await Bus.findOne({ bus_no: normalizedBusNo });
    if (!currentBus) {
      return res.status(404).json({ success: false, error: "Bus not found." });
    }
    if (await findActiveChangeForBus(currentBus._id)) {
      return res.status(409).json({
        success: false,
        error: "Roll back the temporary bus change before editing this bus.",
      });
    }

    let finalBusNo = normalizedBusNo;
    let updateBusNumber = false;
    let updatePreviewNumber = false;

    if (normalizedNewBusNo && normalizedNewBusNo !== normalizedBusNo) {
      const exists = await Bus.findOne({ bus_no: normalizedNewBusNo });
      if (exists) {
        return res.status(400).json({ error: "Bus number already exists" });
      }

      updateBusNumber = true;
      finalBusNo = normalizedNewBusNo;
    }

    if (previewNumber !== undefined) {
      const exists = await Bus.findOne({
        preview_number: previewNumber,
        bus_no: { $ne: normalizeBusNumber(finalBusNo) },
      });
      if (exists) {
        return res.status(400).json({ error: "Preview number already used" });
      }

      updatePreviewNumber = true;
    }

    if (updateBusNumber || updatePreviewNumber) {
      const affectedUsers = await findStudentsAssignedToBus(currentBus);
      const affectedUserIds = affectedUsers.map((user) => user._id);
      const previousState = {
        bus: currentBus.toObject(),
        assignments: affectedUsers.map((user) => ({
          user_id: user._id,
          bus_no: user.bus_no,
          assignment_revision: user.assignmentRevision ?? 0,
        })),
      };
      const previousAssignmentValues = [currentBus.bus_no];
      if (currentBus.preview_number != null) {
        previousAssignmentValues.push(String(currentBus.preview_number));
      }
      const result = await runBusMutation({
        req,
        operation: "update-number",
        request,
        resourceId: currentBus._id,
        expectedVersion,
        mutate: async (session) => {
          const updatedBus = await updateBusAtRevision(
            currentBus,
            expectedVersion,
            {
              ...(updateBusNumber ? { bus_no: normalizedNewBusNo } : {}),
              ...(updatePreviewNumber ? { preview_number: previewNumber } : {}),
            },
            session,
          );
          if (updateBusNumber) {
            await updateStudentAssignmentsAtRevision(
              affectedUsers,
              () => normalizedNewBusNo,
              session,
              "A rider assignment changed while the bus was being renamed. Reload and retry.",
            );
          } else {
            await updateStudentAssignmentsAtRevision(
              affectedUsers,
              () => undefined,
              session,
              "A rider assignment changed while the preview number was being updated. Reload and retry.",
            );
          }
        await recordAssignmentMutation({
          session,
          actorId: req.user?.id,
          action: updateBusNumber
            ? "bus-number-updated"
            : "bus-preview-updated",
          resourceId: currentBus._id,
          requestId: idempotencyKey,
          busRevisionBefore: currentBus.revision ?? 0,
          busRevisionAfter: updatedBus.revision,
          recipients: affectedUserIds.map((userId) => ({
            user_id: userId,
            notification: null,
          })),
          previousState,
          newState: {
            bus: {
              ...currentBus.toObject(),
              bus_no: finalBusNo,
              ...(updatePreviewNumber ? { preview_number: previewNumber } : {}),
              revision: updatedBus.revision,
            },
            assignments: affectedUsers.map((user) => ({
              user_id: user._id,
              bus_no: updateBusNumber &&
                previousAssignmentValues.some((value) =>
                  new RegExp(`^${escapeRegExp(value)}$`, "i").test(
                    String(user.bus_no || ""),
                  ),
                )
                ? finalBusNo
                : user.bus_no,
              assignment_revision: (user.assignmentRevision ?? 0) + 1,
            })),
          },
        });
          return {
            response: {
              message: "Bus updated successfully",
              busNo: finalBusNo,
              previewNumber,
              revision: updatedBus.revision,
            },
            resourceVersion: updatedBus.revision,
          };
        },
      });

      return res.status(200).json({
        success: true,
        ...result.response,
        duplicate: result.duplicate,
      });
    }

    const result = await runBusMutation({
      req,
      operation: "update-number",
      request,
      resourceId: currentBus._id,
      expectedVersion,
      mutate: async () => ({
        response: {
          message: "Bus updated successfully",
          busNo: finalBusNo,
          previewNumber,
          revision: currentBus.revision ?? 0,
        },
        resourceVersion: currentBus.revision ?? 0,
      }),
    });
    res.status(200).json({
      success: true,
      ...result.response,
      duplicate: result.duplicate,
    });
  } catch (error) {
    logSafeError("Bus update failed", error);
    const statusCode = error.statusCode || (error.code === 11000 ? 409 : 500);
    res.status(statusCode).json({
      success: false,
      error: error.statusCode
        ? error.message
        : error.code === 11000
          ? "Bus number or preview number is already in use."
          : "Internal server error.",
      ...(error.code ? { code: error.code } : {}),
    });
  }
}

// ================= GET ALL BUSES WITH LIVE GPS =================
async function getAllBuses(req, res) {
  try {
    if (
      !["primary_admin", "superadmin"].includes(
        String(req.user?.role || "").toLowerCase(),
      )
    ) {
      return res.status(403).json({
        success: false,
        error: "Fleet access is restricted to administrators.",
      });
    }

    const buses = await Bus.find({})
      .select(
        "_id bus_no revision preview_number status gps_device_id reg_no mobile_live altered_to_bus_id altered_to_preview altered_at alteration_type combined_route_source",
      )
      .sort({
        preview_number: 1,
        bus_no: 1,
      })
      .lean();
    const isSuperadmin = req.user && String(req.user.role || '').toLowerCase() === 'superadmin';
    const activeChangeBusIds = new Set();
    let activeChanges = [];
    if (isSuperadmin) {
      activeChanges = await BusChange.find({
        status: { $in: ["applying", "active"] },
      }).select("sourceBusId targetBusId type status").lean();
      activeChanges.forEach((change) => {
        activeChangeBusIds.add(String(change.sourceBusId));
        activeChangeBusIds.add(String(change.targetBusId));
      });
    }

    // Batch fetch all live locations at once (fixes N+1 query)
    const busIds = buses.map((b) => b._id);
    const liveLocations = await BusLiveLocation.find({
      bus_id: { $in: busIds },
    })
      .select(
        "bus_id latitude longitude speed is_online lastSuccessfulGpsUpdate updatedAt source",
      )
      .lean();
    const assignedStudentCounts = isSuperadmin
      ? await User.aggregate([
          {
            $match: {
              role: "student",
              is_active: true,
              bus_no: { $nin: [null, ""] },
            },
          },
          {
            $group: {
              _id: "$bus_no",
              count: { $sum: 1 },
            },
          },
        ])
      : [];
    const busIdByIdentifier = new Map();
    buses.forEach((bus) => {
      busIdByIdentifier.set(String(bus.bus_no || "").trim().toUpperCase(), String(bus._id));
    });
    buses.forEach((bus) => {
      const preview = String(bus.preview_number ?? "").trim().toUpperCase();
      if (preview && !busIdByIdentifier.has(preview)) {
        busIdByIdentifier.set(preview, String(bus._id));
      }
    });
    const riderCountByBusId = new Map();
    assignedStudentCounts.forEach(({ _id: busIdentifier, count }) => {
      const busId = busIdByIdentifier.get(
        String(busIdentifier || "").trim().toUpperCase(),
      );
      if (busId) {
        riderCountByBusId.set(
          busId,
          (riderCountByBusId.get(busId) || 0) + count,
        );
      }
    });
    const locationMap = new Map(
      liveLocations.map((loc) => [loc.bus_id.toString(), loc]),
    );

    const enrichedBuses = buses.map((bus) => {
      const liveLocation = locationMap.get(bus._id.toString());
      const location = liveLocation;

      return {
        revision: bus.revision ?? 0,
        busNo: bus.bus_no,
        previewNumber: bus.preview_number,
        status: bus.status,
        gpsDeviceId: bus.gps_device_id,
        regNo: bus.reg_no,
        mobileLive: bus.mobile_live,
        latitude: location?.latitude ?? null,
        longitude: location?.longitude ?? null,
        speed: location?.speed ?? 0,
        isOnline: Boolean(location?.is_online),
        lastUpdated:
          location?.lastSuccessfulGpsUpdate ?? location?.updatedAt ?? null,
        source: location?.source ?? "offline",
        alteredToPreview: bus.altered_to_preview ?? null,
        alteredAt: bus.altered_at ?? null,
        isAltered: !!bus.altered_to_bus_id,
        alterationType: bus.altered_to_bus_id
          ? bus.alteration_type || "alter"
          : null,
        isTemporaryChange: activeChangeBusIds.has(String(bus._id)),
        riderCount: riderCountByBusId.get(String(bus._id)) || 0,
        canBeTemporaryReplacement:
          isSuperadmin &&
          ((bus.status === "active" &&
            !bus.altered_to_bus_id &&
            !bus.combined_route_source &&
            !activeChangeBusIds.has(String(bus._id))) ||
            (isReusableTemporaryChangeSource(activeChanges, bus._id) &&
              (riderCountByBusId.get(String(bus._id)) || 0) === 0)),
      };
    });

    // Privacy: remove internal identifiers for non-superadmin users
    const safeBuses = isSuperadmin
      ? enrichedBuses
      : enrichedBuses.map((b) => ({
          previewNumber: b.previewNumber,
          status: b.status,
          mobileLive: b.mobileLive,
          latitude: b.latitude,
          longitude: b.longitude,
          speed: b.speed,
          isOnline: b.isOnline,
          lastUpdated: b.lastUpdated,
          source: b.source,
        }));

    const alteredBuses = safeBuses.filter((bus) => bus.isAltered);
    const normalBuses = safeBuses.filter((bus) => !bus.isAltered);
    res.status(200).json({
      // Keep `buses` for existing clients while exposing an explicit altered section.
      buses: normalBuses,
      alteredBuses,
      count: safeBuses.length,
    });
  } catch (error) {
    logSafeError("Get all buses failed", error);
    res.status(500).json({ error: "Internal server error." });
  }
}

async function getBusesForPlan(req, res) {
  try {
    if (
      !["primary_admin", "superadmin"].includes(
        String(req.user?.role || "").toLowerCase(),
      )
    ) {
      return res.status(403).json({
        success: false,
        error: "Fleet access is restricted to administrators.",
      });
    }

    const isSuperadmin =
      req.user && String(req.user.role || "").toLowerCase() === "superadmin";
    const { plan } = req.params || {};
    const targetPlan = isSuperadmin
      ? normalizePlanName(plan || "PLAN A")
      : await getCurrentGlobalPlan();

    const buses = await Bus.find({
      $or: [{ status: "active" }, { altered_to_bus_id: { $ne: null } }],
    })
      .select(BUS_READ_FIELDS)
      .sort({
        bus_no: 1,
        preview_number: 1,
      })
      .lean();
    const mappings = targetPlan === "PLAN A"
      ? []
      : await PlanMapping.find({
          plan_name: targetPlan,
          member_bus_ids: { $in: buses.map((bus) => bus._id) },
        })
          .select("member_bus_ids root_bus_id")
          .lean();
    const rootIdByMemberId = new Map();
    for (const mapping of mappings) {
      for (const memberId of mapping.member_bus_ids || []) {
        const key = String(memberId);
        if (!rootIdByMemberId.has(key)) {
          rootIdByMemberId.set(key, mapping.root_bus_id);
        }
      }
    }
    const rootIds = [...new Set([...rootIdByMemberId.values()].map(String))];
    const roots = rootIds.length
      ? await Bus.find({ _id: { $in: rootIds } })
          .select(BUS_READ_FIELDS)
          .lean()
      : [];
    const rootsById = new Map(roots.map((root) => [String(root._id), root]));
    const context = await loadBusReadContext([...buses, ...roots]);
    const busesWithPlanById = new Map();
    for (const bus of buses) {
      const rootId = rootIdByMemberId.get(String(bus._id));
      const mappedBus = rootId ? rootsById.get(String(rootId)) || bus : bus;
      const routes = getContextRoutesForBus(context, mappedBus);
      if (hasRouteForPlan(routes, targetPlan)) {
        const locationBus = bus.altered_to_bus_id ? bus : mappedBus;
        const effectiveBus = resolveEffectiveBusFromContext(context, locationBus);
        busesWithPlanById.set(String(effectiveBus._id), effectiveBus);
      }
    }
    const busesWithPlan = [...busesWithPlanById.values()];

    const liveLocations = await BusLiveLocation.find({
      bus_id: { $in: busesWithPlan.map((bus) => bus._id) },
    })
      .select(
        "bus_id latitude longitude speed is_online lastSuccessfulGpsUpdate updatedAt source",
      )
      .lean();
    const locationMap = new Map(
      liveLocations.map((loc) => [loc.bus_id.toString(), loc]),
    );

    const response = busesWithPlan.map((bus) => {
      const liveLocation = locationMap.get(bus._id.toString());
      return {
        busNo: bus.bus_no,
        previewNumber: bus.preview_number,
        status: bus.status,
        latitude: liveLocation?.latitude ?? null,
        longitude: liveLocation?.longitude ?? null,
        speed: liveLocation?.speed ?? 0,
        isOnline: !!liveLocation,
        lastUpdated:
          liveLocation?.lastSuccessfulGpsUpdate ?? liveLocation?.updatedAt ?? null,
        source: liveLocation?.source ?? "offline",
      };
    });

    // Privacy: hide bus_no and plan details for non-superadmin users
    const safeResponse = isSuperadmin
      ? response
      : response.map((b) => ({
          previewNumber: b.previewNumber,
          status: b.status,
          latitude: b.latitude,
          longitude: b.longitude,
          speed: b.speed,
          isOnline: b.isOnline,
          lastUpdated: b.lastUpdated,
          source: b.source,
        }));

    res.status(200).json({
      success: true,
      plan: isSuperadmin ? targetPlan : null,
      buses: safeResponse,
      count: safeResponse.length,
    });
  } catch (error) {
    logSafeError("Get buses for plan failed", error);
    res.status(500).json({ success: false, error: "Internal server error." });
  }
}

// ================= DELETE BUS =================
async function deleteBus(req, res) {
  try {
    const { busNo } = req.params;
    const { expectedVersion, idempotencyKey } = getMutationHeaders(req);
    const request = {
      busNo: normalizeBusNumber(busNo),
      expectedVersion,
      expectedVersions: req.body?.expectedVersions || {},
    };
    const replay = await getBusMutationReplay(
      req,
      "delete",
      request,
      expectedVersion,
    );
    if (replay) {
      return res.json({ success: true, ...replay.response, duplicate: true });
    }

    const bus = await Bus.findOne({ bus_no: normalizeBusNumber(busNo) });
    if (!bus) {
      return res.status(404).json({ error: `Bus ${busNo} not found` });
    }
    if (await findActiveChangeForBus(bus._id)) {
      return res.status(409).json({
        success: false,
        error: "Roll back the temporary bus change before deleting this bus.",
      });
    }

    const assignedUsers = await findStudentsAssignedToBus(bus);
    const linkedBuses = await Bus.find({ altered_to_bus_id: bus._id })
      .select("_id bus_no revision")
      .lean();
    const busVersions = getExpectedBusVersions(
      req,
      [bus, ...linkedBuses],
      bus,
      expectedVersion,
    );
    const result = await runBusMutation({
      req,
      operation: "delete",
      request,
      resourceId: bus._id,
      expectedVersion,
      mutate: async (session) => {
        const options = session ? { session } : {};
        for (const linkedBus of linkedBuses) {
          await updateBusAtRevision(
            linkedBus,
            busVersions.get(String(linkedBus._id)),
            {
              altered_to_bus_id: null,
              altered_to_preview: null,
              alteration_type: null,
              alteration_route_source: null,
              alteration_routes: [],
              combined_route_source: null,
              combined_routes: [],
              altered_at: null,
            },
            session,
          );
        }
        await updateStudentAssignmentsAtRevision(
          assignedUsers,
          () => null,
          session,
          "A rider assignment changed while the bus was being deleted. Reload and retry.",
        );
      await PlanMapping.updateMany(
        { member_bus_ids: bus._id },
        { $pull: { member_bus_ids: bus._id } },
        options,
      );
      await PlanMapping.deleteMany({ root_bus_id: bus._id }, options);
      await BusRoute.deleteMany({ bus_id: bus._id }, options);
      await BusLiveLocation.deleteMany({ bus_id: bus._id }, options);
      const deleted = await Bus.deleteOne(
        {
          $and: [
            { _id: bus._id },
            getBusRevisionFilter(bus, expectedVersion),
          ],
        },
        options,
      );
      if (deleted.deletedCount !== 1) {
        const error = new Error(
          "The bus changed. Reload before deleting it.",
        );
        error.code = "BUS_REVISION_CONFLICT";
        error.statusCode = 409;
        throw error;
      }
      await recordAssignmentMutation({
        session,
        actorId: req.user?.id,
        action: "bus-deleted",
        resourceId: bus._id,
        requestId: idempotencyKey,
        busRevisionBefore: bus.revision ?? 0,
        busRevisionAfter: null,
        recipients: assignedUsers.map((user) =>
          assignmentRecipient(user._id, null),
        ),
        previousState: {
          bus: bus.toObject(),
          assignments: assignedUsers.map((user) => ({
            user_id: user._id,
            bus_no: user.bus_no,
            assignment_revision: user.assignmentRevision ?? 0,
          })),
        },
        newState: {
          bus: null,
          assignments: assignedUsers.map((user) => ({
            user_id: user._id,
            bus_no: null,
            assignment_revision: (user.assignmentRevision ?? 0) + 1,
          })),
        },
      });
        return {
          response: {
            success: true,
            message: "Bus and its database records deleted successfully",
          },
          resourceVersion: null,
        };
      },
    });

    res.json({ ...result.response, duplicate: result.duplicate });
  } catch (error) {
    logSafeError("Delete bus failed", error);
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode ? error.message : "Internal server error.",
      ...(error.code ? { code: error.code } : {}),
    });
  }
}

// ================= ACTIVATE BUS =================
async function activateBus(req, res) {
  try {
    const { busNo } = req.params;
    const { expectedVersion } = getMutationHeaders(req);
    const request = { busNo: normalizeBusNumber(busNo), status: "active", expectedVersion };
    const replay = await getBusMutationReplay(req, "status", request, expectedVersion);
    if (replay) {
      return res.json({ success: true, ...replay.response, duplicate: true });
    }
    const bus = await Bus.findOne({ bus_no: normalizeBusNumber(busNo) });
    if (!bus) return res.status(404).json({ error: "Bus not found" });
    if (await findActiveChangeForBus(bus._id)) {
      return res.status(409).json({
        success: false,
        error: "Roll back the temporary bus change before changing this bus status.",
      });
    }

    const users = await findStudentsAssignedToBus(bus);
    const previousState = { status: bus.status, bus_no: bus.bus_no, revision: bus.revision ?? 0 };
    const result = await runBusMutation({
      req,
      operation: "status",
      request,
      resourceId: bus._id,
      expectedVersion,
      mutate: async (session) => {
        const updatedBus = await updateBusAtRevision(
          bus,
          expectedVersion,
          { status: "active" },
          session,
        );
        await updateStudentAssignmentsAtRevision(
          users,
          () => undefined,
          session,
          "A rider assignment changed while the bus was being activated. Reload and retry.",
        );
      await recordAssignmentMutation({
        session,
        actorId: req.user?.id,
        action: "bus-activated",
        resourceId: bus._id,
        requestId: req.get?.("Idempotency-Key"),
        busRevisionBefore: bus.revision ?? 0,
        busRevisionAfter: updatedBus.revision,
        recipients: users.map((user) => ({
          user_id: user._id,
          notification: {
            type: "bus_status",
            message: `Bus ${bus.preview_number ?? ""} is active now.`,
            new_preview: bus.preview_number ?? null,
            is_bus_active: true,
          },
        })),
        previousState: {
          ...previousState,
          assignments: users.map((user) => ({
            user_id: user._id,
            bus_no: user.bus_no,
            assignment_revision: user.assignmentRevision ?? 0,
          })),
        },
        newState: {
          status: updatedBus.status,
          bus_no: updatedBus.bus_no,
          assignments: users.map((user) => ({
            user_id: user._id,
            bus_no: user.bus_no,
            assignment_revision: (user.assignmentRevision ?? 0) + 1,
          })),
        },
      });
        return {
          response: { message: "Bus activated", revision: updatedBus.revision },
          resourceVersion: updatedBus.revision,
        };
      },
    });

    res.json({ success: true, ...result.response, duplicate: result.duplicate });
  } catch (error) {
    logSafeError("Activate bus failed", error);
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode ? error.message : "Internal server error.",
      ...(error.code ? { code: error.code } : {}),
    });
  }
}

// ================= DEACTIVATE BUS =================
async function deactivateBus(req, res) {
  try {
    const { busNo } = req.params;
    const { expectedVersion } = getMutationHeaders(req);
    const request = { busNo: normalizeBusNumber(busNo), status: "inactive", expectedVersion };
    const replay = await getBusMutationReplay(req, "status", request, expectedVersion);
    if (replay) {
      return res.json({ success: true, ...replay.response, duplicate: true });
    }
    const bus = await Bus.findOne({ bus_no: normalizeBusNumber(busNo) });
    if (!bus) return res.status(404).json({ error: "Bus not found" });
    if (await findActiveChangeForBus(bus._id)) {
      return res.status(409).json({
        success: false,
        error: "Roll back the temporary bus change before changing this bus status.",
      });
    }

    const users = await findStudentsAssignedToBus(bus);
    const previousState = { status: bus.status, bus_no: bus.bus_no, revision: bus.revision ?? 0 };
    const result = await runBusMutation({
      req,
      operation: "status",
      request,
      resourceId: bus._id,
      expectedVersion,
      mutate: async (session) => {
        const updatedBus = await updateBusAtRevision(
          bus,
          expectedVersion,
          { status: "inactive" },
          session,
        );
        await updateStudentAssignmentsAtRevision(
          users,
          () => undefined,
          session,
          "A rider assignment changed while the bus was being deactivated. Reload and retry.",
        );
      await recordAssignmentMutation({
        session,
        actorId: req.user?.id,
        action: "bus-deactivated",
        resourceId: bus._id,
        requestId: req.get?.("Idempotency-Key"),
        busRevisionBefore: bus.revision ?? 0,
        busRevisionAfter: updatedBus.revision,
        recipients: users.map((user) => ({
          user_id: user._id,
          notification: {
            type: "bus_status",
            message: `Bus ${bus.preview_number ?? ""} is inactive now.`,
            new_preview: bus.preview_number ?? null,
            is_bus_active: false,
          },
        })),
        previousState: {
          ...previousState,
          assignments: users.map((user) => ({
            user_id: user._id,
            bus_no: user.bus_no,
            assignment_revision: user.assignmentRevision ?? 0,
          })),
        },
        newState: {
          status: updatedBus.status,
          bus_no: updatedBus.bus_no,
          assignments: users.map((user) => ({
            user_id: user._id,
            bus_no: user.bus_no,
            assignment_revision: (user.assignmentRevision ?? 0) + 1,
          })),
        },
      });
        return {
          response: { message: "Bus deactivated", revision: updatedBus.revision },
          resourceVersion: updatedBus.revision,
        };
      },
    });

    res.json({ success: true, ...result.response, duplicate: result.duplicate });
  } catch (error) {
    logSafeError("Deactivate bus failed", error);
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode ? error.message : "Internal server error.",
      ...(error.code ? { code: error.code } : {}),
    });
  }
}

// ================= VALIDATE PREVIEW NUMBER =================
async function validatePreviewNumber(req, res) {
  try {
    const { previewNumber } = req.params;
    const exists = await Bus.findOne({ preview_number: previewNumber });
    res.json({ valid: !exists });
  } catch (error) {
    logSafeError("Validate preview number failed", error);
    res.status(500).json({ error: "Internal server error." });
  }
}

// ================= UPDATE PREVIEW NUMBER =================
async function updatePreviewNumber(req, res) {
  try {
    const { busNo } = req.params;
    const { previewNumber } = req.body;
    const { expectedVersion } = getMutationHeaders(req);
    const request = {
      busNo: normalizeBusNumber(busNo),
      previewNumber: previewNumber ?? null,
      expectedVersion,
    };
    const replay = await getBusMutationReplay(
      req,
      "preview",
      request,
      expectedVersion,
    );
    if (replay) {
      return res.json({ success: true, ...replay.response, duplicate: true });
    }
    const bus = await Bus.findOne({ bus_no: normalizeBusNumber(busNo) });
    if (!bus) return res.status(404).json({ success: false, error: "Bus not found." });
    if (await findActiveChangeForBus(bus._id)) {
      return res.status(409).json({
        success: false,
        error: "Roll back the temporary bus change before editing this bus.",
      });
    }

    const affectedUsers = await findStudentsAssignedToBus(bus);
    const previousState = {
      bus_no: bus.bus_no,
      preview_number: bus.preview_number,
      revision: bus.revision ?? 0,
      assignments: affectedUsers.map((user) => ({
        user_id: user._id,
        bus_no: user.bus_no,
        assignment_revision: user.assignmentRevision ?? 0,
      })),
    };
    const result = await runBusMutation({
      req,
      operation: "preview",
      request,
      resourceId: bus._id,
      expectedVersion,
      mutate: async (session) => {
        const updatedBus = await updateBusAtRevision(
          bus,
          expectedVersion,
          { preview_number: previewNumber },
          session,
        );
        await updateStudentAssignmentsAtRevision(
          affectedUsers,
          () => undefined,
          session,
          "A rider assignment changed while the preview number was being updated. Reload and retry.",
        );
      await recordAssignmentMutation({
        session,
        actorId: req.user?.id,
        action: "bus-preview-updated",
        resourceId: bus._id,
        requestId: req.get?.("Idempotency-Key"),
        busRevisionBefore: bus.revision ?? 0,
        busRevisionAfter: updatedBus.revision,
        recipients: affectedUsers.map((user) => ({
          user_id: user._id,
          notification: null,
        })),
        previousState,
        newState: {
          bus_no: bus.bus_no,
          preview_number: updatedBus.preview_number,
          revision: updatedBus.revision,
          assignments: affectedUsers.map((user) => ({
            user_id: user._id,
            bus_no: user.bus_no,
            assignment_revision: (user.assignmentRevision ?? 0) + 1,
          })),
        },
      });
        return {
          response: {
            message: "Preview updated successfully",
            revision: updatedBus.revision,
          },
          resourceVersion: updatedBus.revision,
        };
      },
    });

    res.json({ success: true, ...result.response, duplicate: result.duplicate });
  } catch (error) {
    logSafeError("Update preview number failed", error);
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode ? error.message : "Internal server error.",
      ...(error.code ? { code: error.code } : {}),
    });
  }
}

// ================= UPDATE PLAN =================
async function updatePlan(req, res) {
  try {
    return res.status(400).json({
      success: false,
      error:
        "Individual bus plans are no longer supported. Use the global active plan instead.",
    });
  } catch (error) {
    logSafeError("Update bus plan failed", error);
    res.status(500).json({ error: "Internal server error." });
  }
}

// ================= GLOBAL ACTIVE PLAN =================
async function getGlobalActivePlan(req, res) {
  try {
    const activePlan = await getCurrentGlobalPlan();

    const isSuperadmin = req.user && String(req.user.role || '').toLowerCase() === 'superadmin';
    res.json({
      success: true,
      ...(isSuperadmin ? { activePlan, planNames: DEFAULT_PLAN_NAMES } : {}),
      ...(isSuperadmin
        ? {
            version:
              (await getPlanMappingVersions(["GLOBAL_ACTIVE_PLAN"]))
                .GLOBAL_ACTIVE_PLAN ?? 0,
          }
        : {}),
    });
  } catch (error) {
    logSafeError("Get global active plan failed", error);
    res.status(500).json({ success: false, error: "Internal server error." });
  }
}

async function setGlobalActivePlan(req, res) {
  try {
    const { plan } = req.body;
    const normalized = normalizePlanName(plan);

    if (!DEFAULT_PLAN_NAMES.includes(normalized)) {
      return res.status(400).json({
        success: false,
        error: "Invalid plan. Choose PLAN A, PLAN B, PLAN C, or PLAN D.",
      });
    }

    const rawVersion =
      req.body?.expectedVersion ?? req.get?.("If-Match") ?? req.headers?.["if-match"];
    const expectedVersion =
      typeof rawVersion === "string" && /^"?\d+"?$/.test(rawVersion)
        ? Number(rawVersion.replaceAll('"', ""))
        : rawVersion;
    const idempotencyKey =
      req.get?.("Idempotency-Key") || req.headers?.["idempotency-key"];
    const previousPlan = await getCurrentGlobalPlan();
    if (previousPlan === normalized) {
      const noop = await runPlanMappingNoop({
        scope: "GLOBAL_ACTIVE_PLAN",
        idempotencyKey,
        expectedVersion,
        actorId: req.user?.id,
        action: "global-plan-noop",
        request: { plan: normalized, expectedVersion },
        previousState: { activePlan: previousPlan },
        newState: { activePlan: normalized },
        response: { activePlan: normalized },
      });
      return res.json({
        success: true,
        message: "Global active route updated successfully.",
        activePlan: noop.response.activePlan,
        version: noop.version,
        duplicate: noop.duplicate,
        planNames: DEFAULT_PLAN_NAMES,
      });
    }

    const mappingState = await loadPlanState();
    const notifications = getPlanChangeNotifications(mappingState, normalized);
    const mutation = await runPlanMappingMutation({
      scope: "GLOBAL_ACTIVE_PLAN",
      idempotencyKey,
      expectedVersion,
      actorId: req.user?.id,
      action: "global-plan-change",
      request: { plan: normalized, expectedVersion },
      previousState: { activePlan: previousPlan },
      newState: { activePlan: normalized },
      recipients: notifications.map((notification) => ({
        user_id: notification.user_id,
        notification,
      })),
      mutate: async (session) => {
        const updated = await AppSetting.findOneAndUpdate(
          { key: GLOBAL_ACTIVE_PLAN_KEY },
          { key: GLOBAL_ACTIVE_PLAN_KEY, value: normalized },
          {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true,
            ...(session ? { session } : {}),
          },
        );
        return { response: { activePlan: updated.value } };
      },
    });

    const io = getIO();
    if (io) {
      // Do not broadcast the active plan value to all connected clients (privacy).
      // Send per-user notifications without including the plan name. Admin UIs should fetch
      // the global plan via the protected API (superadmin only).
      try {
        io.emit("bus-update", { actionType: "PLAN_CHANGED" });
      } catch (error) {
        logSafeError("Global plan websocket broadcast deferred", error);
      }
    }
    res.json({
      success: true,
      message: "Global active plan updated successfully",
      activePlan: mutation.response.activePlan,
      version: mutation.version,
      duplicate: mutation.duplicate,
      planNames: DEFAULT_PLAN_NAMES,
    });
  } catch (error) {
    logSafeError("Set global active plan failed", error);
    const statusCode =
      String(error?.code || "").startsWith("PLAN_MAPPING_")
        ? error.statusCode || 409
        : 500;
    res.status(statusCode).json({
      success: false,
      error:
        statusCode === 500 ? "Internal server error." : error.message,
      ...(error?.code ? { code: error.code } : {}),
    });
  }
}

function normalizeAlterationRoutes(routesByPlan) {
  if (
    !routesByPlan ||
    typeof routesByPlan !== "object" ||
    Array.isArray(routesByPlan)
  ) {
    return null;
  }

  const routes = [];
  for (const [rawPlanName, stops] of Object.entries(routesByPlan)) {
    const plan_name = normalizePlanName(rawPlanName);
    if (!DEFAULT_PLAN_NAMES.includes(plan_name) || !Array.isArray(stops)) {
      return null;
    }
    for (const stop of stops) {
      const stop_name =
        typeof stop?.stop_name === "string" ? stop.stop_name.trim() : "";
      const stop_order = Number(stop?.stop_order);
      const stopId = String(stop?.stopId || "").trim();
      const arrival_time = normalizeArrivalTime(stop?.arrival_time);
      if (!stop_name || !Number.isInteger(stop_order) || stop_order < 1) {
        return null;
      }
      routes.push({
        plan_name,
        stop_name,
        stop_order,
        stopId: stopId || null,
        arrival_time,
      });
    }
  }
  return routes.length ? routes : null;
}

function snapshotBus(bus) {
  return {
    busId: bus._id,
    busNo: bus.bus_no,
    status: bus.status,
    alteredToBusId: bus.altered_to_bus_id ?? null,
    alteredToPreview: bus.altered_to_preview ?? null,
    alterationType: bus.alteration_type ?? null,
    alterationRouteSource: bus.alteration_route_source ?? null,
    alterationRoutes: (bus.alteration_routes || []).map((route) =>
      typeof route.toObject === "function" ? route.toObject() : { ...route },
    ),
    alteredAt: bus.altered_at ?? null,
    combinedRouteSource: bus.combined_route_source ?? null,
    combinedRoutes: (bus.combined_routes || []).map((route) =>
      typeof route.toObject === "function" ? route.toObject() : { ...route },
    ),
  };
}

function restoreBusSnapshot(bus, snapshot) {
  bus.status = snapshot.status;
  bus.altered_to_bus_id = snapshot.alteredToBusId;
  bus.altered_to_preview = snapshot.alteredToPreview;
  bus.alteration_type = snapshot.alterationType;
  bus.alteration_route_source = snapshot.alterationRouteSource;
  bus.alteration_routes = snapshot.alterationRoutes;
  bus.altered_at = snapshot.alteredAt;
  bus.combined_route_source = snapshot.combinedRouteSource;
  bus.combined_routes = snapshot.combinedRoutes;
}

async function findActiveChangeForBus(busId) {
  return BusChange.findOne({
    status: { $in: ["applying", "active"] },
    $or: [{ sourceBusId: busId }, { targetBusId: busId }],
  }).select("_id");
}

async function getTemporaryBusChanges(req, res) {
  try {
    const pagination = parsePagination(req.query || {}, {
      defaultLimit: 50,
      maxLimit: 100,
    });
    const cursor = parseTemporaryChangeCursor(req.query?.cursor);
    if (pagination.error || !cursor || req.query?.page !== undefined) {
      return res.status(400).json({
        success: false,
        error: pagination.error || "A valid change cursor is required.",
      });
    }

    const activeStatuses = ["applying", "active"];
    const recordedFilter = {
      status: { $in: activeStatuses },
      $or: [{ createdAt: { $type: "date" } }, { createdAt: null }],
    };
    const legacyFilter = {
      alteration_type: "alter",
      altered_to_bus_id: { $ne: null },
      $or: [{ altered_at: { $type: "date" } }, { altered_at: null }],
    };
    const recordedQuery = cursor.recorded.done
      ? Promise.resolve([])
      : BusChange.find(
          addDescendingCursor(recordedFilter, "createdAt", cursor.recorded),
        )
          .select(
            "_id type status sourceBusNo sourcePreview targetBusNo targetPreview routeSource affectedUsersCount createdAt sourceBusId",
          )
          .sort({ createdAt: -1, _id: -1 })
          .limit(pagination.limit + 1)
          .lean();

    const [recordedChanges, recordedSourceIds] = await Promise.all([
      recordedQuery,
      cursor.legacy.done
        ? Promise.resolve([])
        : BusChange.distinct("sourceBusId", {
            status: { $in: activeStatuses },
          }),
    ]);
    const legacyQueryFilter = {
      ...legacyFilter,
      ...(recordedSourceIds.length
        ? { _id: { $nin: recordedSourceIds } }
        : {}),
    };
    const legacyQuery = cursor.legacy.done
      ? Promise.resolve([])
      : Bus.find(
          addDescendingCursor(legacyQueryFilter, "altered_at", cursor.legacy),
        )
          .select(
            "bus_no preview_number altered_to_bus_id altered_to_preview altered_at",
          )
          .sort({ altered_at: -1, _id: -1 })
          .limit(pagination.limit + 1)
          .lean();
    const legacyBuses = await legacyQuery;

    const entries = [
      ...recordedChanges.map((change) => ({
        source: "recorded",
        id: String(change._id),
        ...getCursorTimestamp(change.createdAt),
        change,
      })),
      ...legacyBuses.map((bus) => ({
        source: "legacy",
        id: String(bus._id),
        ...getCursorTimestamp(bus.altered_at),
        bus,
      })),
    ].sort(
      (left, right) =>
        right.timestamp - left.timestamp ||
        right.id.localeCompare(left.id) ||
        right.source.localeCompare(left.source),
    );
    const pageEntries = entries.slice(0, pagination.limit);
    const nextCursor = {
      recorded: { ...cursor.recorded },
      legacy: { ...cursor.legacy },
    };
    for (const entry of pageEntries) {
      nextCursor[entry.source] = {
        date: entry.cursorDate,
        id: entry.id,
        done: false,
      };
    }
    for (const source of ["recorded", "legacy"]) {
      const sourceEntries = entries.filter((entry) => entry.source === source);
      const sourcePageEntries = pageEntries.filter(
        (entry) => entry.source === source,
      );
      if (
        sourceEntries.length === 0 ||
        (sourceEntries.length <= pagination.limit &&
          sourcePageEntries.length === sourceEntries.length)
      ) {
        nextCursor[source] = { done: true };
      }
    }
    const hasNextPage = !nextCursor.recorded.done || !nextCursor.legacy.done;
    const legacyPage = pageEntries
      .filter((entry) => entry.source === "legacy")
      .map((entry) => entry.bus);
    const targetIds = [
      ...new Set(legacyPage.map((bus) => String(bus.altered_to_bus_id))),
    ];
    const riderIdentifiers = [
      ...new Set(
        legacyPage.flatMap((bus) =>
          [bus.bus_no, bus.preview_number]
            .filter((value) => value != null && String(value).trim())
            .map((value) => String(value).trim()),
        ),
      ),
    ];
    const [targets, riderCounts] = await Promise.all([
      targetIds.length
        ? Bus.find({ _id: { $in: targetIds } })
            .select("bus_no preview_number")
            .lean()
        : [],
      riderIdentifiers.length
        ? User.aggregate([
            {
              $match: {
                bus_no: {
                  $in: riderIdentifiers.map(
                    (identifier) =>
                      new RegExp(`^${escapeRegExp(identifier)}$`, "i"),
                  ),
                },
                role: "student",
                is_active: true,
              },
            },
            { $group: { _id: { $toUpper: "$bus_no" }, count: { $sum: 1 } } },
          ])
        : [],
    ]);
    const targetsById = new Map(
      targets.map((target) => [String(target._id), target]),
    );
    const riderCountsByBus = new Map(
      riderCounts.map((result) => [String(result._id).toUpperCase(), result.count]),
    );
    const changes = pageEntries.map((entry) => {
      if (entry.source === "recorded") {
        const change = entry.change;
        return {
          id: entry.id,
          type: change.type,
          status: change.status,
          sourceBusNo: change.sourceBusNo,
          sourcePreview: change.sourcePreview,
          targetBusNo: change.targetBusNo,
          targetPreview: change.targetPreview,
          routeSource: change.routeSource,
          affectedUsersCount: change.affectedUsersCount,
          createdAt: change.createdAt,
          legacy: false,
        };
      }
      const bus = entry.bus;
      const target = targetsById.get(String(bus.altered_to_bus_id));
      const identifiers = new Set([
        bus.bus_no,
        bus.preview_number,
      ]
        .filter((value) => value != null)
        .map((value) => String(value).trim().toUpperCase()));
      const affectedUsersCount = [...identifiers].reduce(
        (sum, identifier) => sum + (riderCountsByBus.get(identifier) || 0),
        0,
      );
      return {
        id: `legacy:${bus.bus_no}`,
        type: "alter",
        status: "active",
        sourceBusNo: bus.bus_no,
        sourcePreview: bus.preview_number,
        targetBusNo: target?.bus_no ?? null,
        targetPreview: target?.preview_number ?? bus.altered_to_preview,
        routeSource: null,
        affectedUsersCount,
        createdAt: bus.altered_at,
        legacy: true,
      };
    });

    return res.json({
      success: true,
      changes,
      pagination: {
        limit: pagination.limit,
        hasNextPage,
        nextCursor: hasNextPage
          ? Buffer.from(JSON.stringify({ v: 1, ...nextCursor })).toString("base64url")
          : null,
      },
    });
  } catch (error) {
    logSafeError("Get temporary bus changes failed", error);
    return res.status(500).json({
      success: false,
      error: "Could not load temporary bus changes.",
    });
  }
}

async function rollbackTemporaryBusChange(req, res) {
  try {
    const { expectedVersion, idempotencyKey } = getMutationHeaders(req);
    const request = {
      changeId: String(req.params.changeId),
      expectedVersion,
      expectedVersions: req.body?.expectedVersions || {},
    };
    const replay = await getBusMutationReplay(
      req,
      "rollback",
      request,
      expectedVersion,
    );
    if (replay) {
      return res.json({ success: true, ...replay.response, duplicate: true });
    }

    const change = await BusChange.findById(req.params.changeId);
    if (!change || !["applying", "active"].includes(change.status)) {
      return res.status(404).json({
        success: false,
        error: "Active temporary bus change not found.",
      });
    }

    const buses = await Bus.find({
      _id: { $in: change.busSnapshots.map((snapshot) => snapshot.busId) },
    });
    const busesById = new Map(buses.map((bus) => [String(bus._id), bus]));
    const users = await User.find({
      _id: { $in: change.assignmentSnapshots.map((snapshot) => snapshot.userId) },
    }).select("_id bus_no assignmentRevision role is_active");
    const usersById = new Map(users.map((user) => [String(user._id), user]));
    if (buses.length !== change.busSnapshots.length) {
      return res.status(409).json({
        success: false,
        error: "A bus involved in this temporary change no longer exists; rollback cannot safely restore it.",
      });
    }
    const sourceBus = busesById.get(String(change.sourceBusId));
    const busVersions = getExpectedBusVersions(
      req,
      buses,
      sourceBus,
      expectedVersion,
    );
    if (change.type === "combine") {
      const currentRiders = await findStudentsAssignedToBus(sourceBus);
      if (currentRiders.length) {
        return res.status(409).json({
          success: false,
          error: `Bus ${change.sourcePreview ?? change.sourceBusNo} now has ${currentRiders.length} rider(s). Reassign them so the bus has 0 riders before rolling back this combination.`,
        });
      }
    }

    const assignmentConflicts = change.assignmentSnapshots.filter((snapshot) => {
      const user = usersById.get(String(snapshot.userId));
      if (!user) return false;
      const current = user.bus_no ? String(user.bus_no).toUpperCase() : null;
      const before = snapshot.beforeBusNo
        ? String(snapshot.beforeBusNo).toUpperCase()
        : null;
      const after = snapshot.afterBusNo
        ? String(snapshot.afterBusNo).toUpperCase()
        : null;
      return current !== before && current !== after;
    });
    if (assignmentConflicts.length) {
      return res.status(409).json({
        success: false,
        error: `${assignmentConflicts.length} affected rider(s) have since been reassigned. Resolve those assignments before rolling back.`,
      });
    }

    const newerChanges = await BusChange.find({
      _id: { $ne: change._id },
      status: { $in: ["applying", "active"] },
      $or: [
        { createdAt: { $gt: change.createdAt } },
        { createdAt: change.createdAt, _id: { $gt: change._id } },
      ],
      $and: [
        {
          $or: [
            { sourceBusId: { $in: change.busSnapshots.map((snapshot) => snapshot.busId) } },
            { targetBusId: { $in: change.busSnapshots.map((snapshot) => snapshot.busId) } },
          ],
        },
      ],
    }).select("_id");
    if (newerChanges.length) {
      return res.status(409).json({
        success: false,
        error: "Roll back the newer temporary change using this bus first, then retry.",
      });
    }

    const restoredBusByNo = new Map(
      change.busSnapshots.map((snapshot) => [
        String(snapshot.busNo).toUpperCase(),
        snapshot.busNo,
      ]),
    );
    const rollbackRecipients = change.assignmentSnapshots.flatMap((snapshot) => {
      const user = usersById.get(String(snapshot.userId));
      if (!user) return [];
      const restoredBus = snapshot.beforeBusNo
        ? buses.find((candidate) =>
          [candidate.bus_no, candidate.preview_number].some(
            (identifier) =>
              String(identifier || "").toUpperCase() ===
              String(snapshot.beforeBusNo).toUpperCase(),
          ),
        )
        : null;
      const message = restoredBus
        ? `The temporary bus change has ended. Your previous assignment to Bus ${restoredBus.preview_number ?? restoredBus.bus_no} is restored.`
        : "The temporary bus change has ended. You do not have a bus assignment; please contact administration.";
      return [{
        user_id: user._id,
        notification: {
          type: restoredBus ? "bus_change_rolled_back" : "bus_unassigned",
          message,
          old_bus_no: snapshot.afterBusNo,
          new_bus_no: snapshot.beforeBusNo,
          old_preview: change.targetPreview,
          new_preview: restoredBus?.preview_number ?? null,
        },
      }];
    });
    const previousBusStates = buses.map((bus) => bus.toObject());
    const previousAssignments = change.assignmentSnapshots.map((snapshot) => ({
      user_id: snapshot.userId,
      bus_no: usersById.get(String(snapshot.userId))?.bus_no ?? null,
      assignment_revision:
        usersById.get(String(snapshot.userId))?.assignmentRevision ?? 0,
    }));
    const assignmentSnapshotsByUserId = new Map(
      change.assignmentSnapshots.map((snapshot) => [
        String(snapshot.userId),
        snapshot,
      ]),
    );
    const result = await runBusMutation({
      req,
      operation: "rollback",
      request,
      resourceId: change._id,
      expectedVersion,
      mutate: async (session) => {
        const restoredBuses = [];
        for (const snapshot of change.busSnapshots) {
          const bus = busesById.get(String(snapshot.busId));
          restoreBusSnapshot(bus, snapshot);
          restoredBuses.push(await saveBusAtRevision(
            bus,
            busVersions.get(String(bus._id)),
            session,
          ));
        }
        await updateStudentAssignmentsAtRevision(
          change.assignmentSnapshots
            .filter((snapshot) => snapshot.beforeBusNo !== snapshot.afterBusNo)
            .map((snapshot) => usersById.get(String(snapshot.userId)))
            .filter(Boolean),
          (user) => {
            const snapshot = assignmentSnapshotsByUserId.get(String(user._id));
            return snapshot?.beforeBusNo
              ? restoredBusByNo.get(String(snapshot.beforeBusNo).toUpperCase()) ||
                  snapshot.beforeBusNo
              : null;
          },
          session,
          "A rider assignment changed while the bus change was being rolled back. Reload and retry.",
        );
        const changeUpdate = await BusChange.updateOne(
          { _id: change._id, status: { $in: ["applying", "active"] } },
          { $set: { status: "rolled_back", rolledBackAt: new Date() } },
          session ? { session } : {},
        );
        if (changeUpdate.matchedCount !== 1) {
          const error = new Error(
            "This temporary bus change has already been updated.",
          );
          error.code = "BUS_CHANGE_CONFLICT";
          error.statusCode = 409;
          throw error;
        }
      await recordAssignmentMutation({
        session,
        actorId: req.user?.id,
        action: "temporary-bus-change-rolled-back",
        resourceId: change._id,
        requestId: idempotencyKey,
        busRevisionBefore: expectedVersion,
        busRevisionAfter: expectedVersion + 1,
        recipients: rollbackRecipients,
        previousState: { buses: previousBusStates, assignments: previousAssignments },
        newState: {
          buses: restoredBuses,
          assignments: change.assignmentSnapshots.map((snapshot) => ({
            user_id: snapshot.userId,
            bus_no: snapshot.beforeBusNo,
            assignment_revision:
              (usersById.get(String(snapshot.userId))?.assignmentRevision ?? 0) +
              (snapshot.beforeBusNo !== snapshot.afterBusNo ? 1 : 0),
          })),
          status: "rolled_back",
        },
      });
        return {
          response: {
            message: `Bus ${change.sourcePreview ?? change.sourceBusNo} restored to its normal service.`,
            notifiedStudents: change.assignmentSnapshots.length,
          },
          resourceVersion: expectedVersion + 1,
        };
      },
    });

    const io = getIO();
    if (io && !result.duplicate) {
      try {
        io.emit("bus-update", {
          actionType: "BUS_RESTORED",
          previewNumber: change.sourcePreview,
        });
      } catch (error) {
        logSafeError("Bus rollback websocket broadcast deferred", error);
      }
    }
    return res.json({
      success: true,
      ...result.response,
      duplicate: result.duplicate,
    });
  } catch (error) {
    logSafeError("Rollback temporary bus change failed", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode
        ? error.message
        : "Could not roll back this temporary bus change.",
      ...(error.code ? { code: error.code } : {}),
    });
  }
}

async function changeBus(req, res, alterationType) {
  try {
    const { expectedVersion } = getMutationHeaders(req);
    const request = {
      sourceBusNo: normalizeBusNumber(req.params.busNo),
      targetBusNo: normalizeBusNumber(req.body?.newBusNo),
      alterationType,
      routeSource: req.body?.routeSource ?? null,
      routesByPlan: req.body?.routesByPlan ?? null,
      expectedVersion,
      expectedVersions: req.body?.expectedVersions || {},
    };
    const replay = await getBusMutationReplay(
      req,
      alterationType,
      request,
      expectedVersion,
    );
    if (replay) {
      return res.json({ success: true, ...replay.response, duplicate: true });
    }

    const sourceBus = await findBusByIdentifier(req.params.busNo);
    const targetBus = await findBusByIdentifier(req.body?.newBusNo);

    if (!sourceBus) {
      return res.status(404).json({ success: false, error: 'Source bus not found.' });
    }

    if (!targetBus) {
      return res.status(404).json({ success: false, error: 'New bus not found.' });
    }
    const busVersions = getExpectedBusVersions(
      req,
      [sourceBus, targetBus],
      sourceBus,
      expectedVersion,
    );

    if (sourceBus._id.equals(targetBus._id)) {
      return res.status(400).json({ success: false, error: 'Choose a different bus.' });
    }
    if (sourceBus.altered_to_bus_id) {
      return res.status(400).json({
        success: false,
        error: 'Restore this bus before choosing another replacement.',
      });
    }
    if (sourceBus.status !== 'active') {
      return res.status(400).json({
        success: false,
        error: 'Only an active bus can be changed.',
      });
    }
    if (!sourceBus.preview_number || !targetBus.preview_number) {
      return res.status(400).json({
        success: false,
        error: 'Both buses need a preview number before they can be changed.',
      });
    }
    if (sourceBus.combined_route_source || targetBus.combined_route_source) {
      return res.status(409).json({
        success: false,
        error: "Rollback the existing temporary bus change before using either bus again.",
      });
    }
    const activeChanges = await BusChange.find({
      status: { $in: ["applying", "active"] },
    }).select("sourceBusId targetBusId type status").lean();
    const activeChangeBusIds = new Set(
      activeChanges.flatMap((change) => [
        String(change.sourceBusId),
        String(change.targetBusId),
      ]),
    );
    const sourceCanBeReused = isReusableTemporaryChangeSource(
      activeChanges,
      sourceBus._id,
    );
    const targetCanBeReused = isReusableTemporaryChangeSource(
      activeChanges,
      targetBus._id,
    );
    if (
      (targetBus.status !== "active" || targetBus.altered_to_bus_id) &&
      !targetCanBeReused
    ) {
      return res.status(400).json({
        success: false,
        error: "Choose an active bus or an empty source bus from a temporary change.",
      });
    }
    if (
      (activeChangeBusIds.has(String(sourceBus._id)) && !sourceCanBeReused) ||
      (activeChangeBusIds.has(String(targetBus._id)) && !targetCanBeReused)
    ) {
      return res.status(409).json({
        success: false,
        error: "Only an empty source bus from an active temporary change can be reused. Roll back other temporary changes before using these buses.",
      });
    }
    const legacyAlterations = await Bus.find({
      alteration_type: "alter",
      altered_to_bus_id: { $ne: null },
    }).select("_id altered_to_bus_id").lean();
    const recordedSourceIds = new Set(activeChanges.map((change) => String(change.sourceBusId)));
    const legacyTargetIds = new Set(
      legacyAlterations
        .filter((bus) => !recordedSourceIds.has(String(bus._id)))
        .map((bus) => String(bus.altered_to_bus_id)),
    );
    if (
      legacyTargetIds.has(String(sourceBus._id)) ||
      legacyTargetIds.has(String(targetBus._id))
    ) {
      return res.status(409).json({
        success: false,
        error: "This bus is already supporting a legacy alteration. Restore that bus before using it here.",
      });
    }

    const { routeSource, routesByPlan } = req.body || {};
    const activePlan = await getCurrentGlobalPlan();
    const isCombined = alterationType === "combine";
    if (!isCombined && routeSource !== undefined) {
      return res.status(400).json({
        success: false,
        error: "Altering a bus changes its location only; its original stops cannot be changed.",
      });
    }
    if (isCombined && !["source", "target", "custom"].includes(routeSource)) {
      return res.status(400).json({
        success: false,
        error: "Choose the source bus route, target bus route, or upload a custom route before combining.",
      });
    }
    if (
      routeSource !== undefined &&
      !["source", "target", "custom"].includes(routeSource)
    ) {
      return res.status(400).json({
        success: false,
        error: "Choose routes from this bus, the replacement bus, or an upload.",
      });
    }
    let alterationRoutes = [];
    const pendingStops = [];
    if (routeSource === "custom") {
      try {
        alterationRoutes = normalizeAlterationRoutes(routesByPlan);
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error.message,
        });
      }
    }
    if (routeSource === "custom" && !alterationRoutes) {
      return res.status(400).json({
        success: false,
        error: "Upload a valid route file containing at least one stop.",
      });
    }
    if (
      routeSource === "custom" &&
      !hasRouteForPlan(alterationRoutes, activePlan)
    ) {
      return res.status(409).json({
        success: false,
        error: "The uploaded routes need stops for today's active service.",
      });
    }
    if (routeSource === "custom") {
      const routeStops = await StopMaster.find({})
        .select("stopId name")
        .lean();
      const stopsById = new Map(routeStops.map((stop) => [stop.stopId, stop]));
      const stopsByName = new Map();
      routeStops.forEach((stop) => {
        const key = normalizeStopName(stop.name);
        stopsByName.set(key, [...(stopsByName.get(key) || []), stop]);
      });
      const createdStops = new Map();
      for (const route of alterationRoutes) {
        let stop = route.stopId ? stopsById.get(route.stopId) : null;
        const key = normalizeStopName(route.stop_name);
        if (!stop) {
          const matches = stopsByName.get(key) || [];
          if (matches.length > 1) {
            return res.status(400).json({
              success: false,
              error: `Stop "${route.stop_name}" matches multiple Stop Master names.`,
            });
          }
          stop = matches[0] || createdStops.get(key);
        }
        if (!stop) {
          stop = {
            stopId: `STOP-${randomUUID()}`,
            name: route.stop_name.trim().replace(/\s+/g, " "),
            source: "EXISTING_STOP",
            status: "PENDING",
          };
          pendingStops.push(stop);
          createdStops.set(key, stop);
        }
        route.stopId = stop.stopId;
        route.stop_name = stop.name;
      }
    }
    let selectedRoutes = [];
    if (routeSource === "source" || routeSource === "target") {
      const selectedRouteBus = routeSource === "source" ? sourceBus : targetBus;
      selectedRoutes = await getEffectiveRoutesForAllPlans(selectedRouteBus);
      if (!selectedRoutes.length) {
        return res.status(400).json({
          success: false,
          error: `Bus ${selectedRouteBus.preview_number ?? selectedRouteBus.bus_no} has no uploaded routes. Choose another route option or upload new routes.`,
        });
      }
    } else if (routeSource === "custom") {
      selectedRoutes = alterationRoutes;
    }

    if (!isCombined) {
      const incomingAlterations = await Bus.countDocuments({
        altered_to_bus_id: targetBus._id,
        alteration_type: "alter",
      });
      if (incomingAlterations) {
        return res.status(400).json({
          success: false,
          error: "This replacement bus is already in use for an altered bus and cannot replace another bus.",
        });
      }
      const sourceRoutes = await getRoutesForBus(sourceBus);
      if (!hasRouteForPlan(sourceRoutes, activePlan)) {
        return res.status(409).json({
          success: false,
          error: "This bus has no active stops for today's service. Map its users to an available bus first.",
        });
      }
    } else if (!hasRouteForPlan(selectedRoutes, activePlan)) {
      return res.status(409).json({
        success: false,
        error: "The selected route has no stops for today's service. Choose another route or map the users to an available bus.",
      });
    }

    const sourceUsers = await findStudentsAssignedToBus(sourceBus);
    const targetUsers = await findStudentsAssignedToBus(targetBus);
    if (!isCombined && sourceUsers.length === 0) {
      return res.status(409).json({
        success: false,
        error: "Choose a source bus with riders to move to the replacement bus.",
      });
    }
    if (!isCombined && targetUsers.length > 0) {
      return res.status(409).json({
        success: false,
        error: `Replacement Bus ${targetBus.preview_number ?? targetBus.bus_no} has ${targetUsers.length} rider(s). Choose a replacement bus with 0 riders.`,
      });
    }
    if (
      (sourceCanBeReused && sourceUsers.length > 0) ||
      (targetCanBeReused && targetUsers.length > 0)
    ) {
      const bus = sourceCanBeReused && sourceUsers.length
        ? sourceBus
        : targetBus;
      const count = bus === sourceBus ? sourceUsers.length : targetUsers.length;
      return res.status(409).json({
        success: false,
        error: `Bus ${bus.preview_number ?? bus.bus_no} has ${count} rider(s) and cannot be reused until it has 0 riders.`,
      });
    }
    const assignmentByUserId = new Map(
      sourceUsers.map((user) => [String(user._id), targetBus.bus_no]),
    );

    const assignmentSnapshots = [
      ...sourceUsers,
      ...targetUsers,
    ].map((user) => ({
      userId: user._id,
      beforeBusNo: user.bus_no ?? null,
      beforeAssignmentRevision: user.assignmentRevision ?? 0,
      afterBusNo: assignmentByUserId.has(String(user._id))
        ? assignmentByUserId.get(String(user._id))
        : user.bus_no ?? null,
      afterAssignmentRevision: assignmentByUserId.has(String(user._id))
        ? (user.assignmentRevision ?? 0) + 1
        : user.assignmentRevision ?? 0,
    }));
    const busSnapshots = [snapshotBus(sourceBus), snapshotBus(targetBus)];
    const uniqueUsers = new Map(
      [...sourceUsers, ...targetUsers].map((user) => [String(user._id), user]),
    );
    const previewMessage = isCombined
      ? `For your bus service, use Bus ${targetBus.preview_number}. Follow ${
          routeSource === "source"
            ? `Bus ${sourceBus.preview_number}'s`
            : routeSource === "target"
              ? `Bus ${targetBus.preview_number}'s`
              : "the uploaded combined route's"
        } stops and timings; open Home and tap View Stops to see the route.`
      : `For your bus service, use Bus ${targetBus.preview_number}. Continue following Bus ${sourceBus.preview_number}'s original stops and timings; open Home and tap View Stops to see them.`;
    const propagationRecipients = [...uniqueUsers.values()].map((user) => {
      const isSourceRider = sourceUsers.some(
        (sourceUser) => String(sourceUser._id) === String(user._id),
      );
      return {
        user_id: user._id,
        notification: {
          type: isCombined ? "bus_combined" : "bus_altered",
          message: isSourceRider && !isCombined
            ? `For your bus service, use Bus ${targetBus.preview_number}. Continue following Bus ${sourceBus.preview_number}'s original stops and timings; open Home and tap View Stops to see them.`
            : previewMessage,
          old_bus_no: sourceBus.bus_no,
          new_bus_no: targetBus.bus_no,
          old_preview: sourceBus.preview_number,
          new_preview: targetBus.preview_number,
        },
      };
    });
    const previousBusStates = [sourceBus.toObject(), targetBus.toObject()];
    const result = await runBusMutation({
      req,
      operation: alterationType,
      request,
      resourceId: sourceBus._id,
      expectedVersion,
      mutate: async (session) => {
        if (pendingStops.length) {
          await StopMaster.create(
            pendingStops,
            session ? { session } : {},
          );
        }
        const [change] = await BusChange.create(
          [{
            type: alterationType,
            status: "active",
            sourceBusId: sourceBus._id,
            sourceBusNo: sourceBus.bus_no,
            sourcePreview: sourceBus.preview_number,
            targetBusId: targetBus._id,
            targetBusNo: targetBus.bus_no,
            targetPreview: targetBus.preview_number,
            routeSource: isCombined ? routeSource : null,
            busSnapshots,
            assignmentSnapshots,
            affectedUsersCount: assignmentSnapshots.length,
          }],
          session ? { session } : {},
        );

        if (targetCanBeReused) {
          targetBus.status = "active";
          targetBus.altered_to_bus_id = null;
          targetBus.altered_to_preview = null;
          targetBus.alteration_type = null;
          targetBus.alteration_route_source = null;
          targetBus.alteration_routes = [];
          targetBus.altered_at = null;
          targetBus.combined_route_source = null;
          targetBus.combined_routes = [];
        }

        if (isCombined) {
          targetBus.combined_route_source = routeSource;
          targetBus.combined_routes = selectedRoutes.map((route) => ({
            plan_name: route.plan_name,
            stop_name: route.stop_name,
            stop_order: route.stop_order,
            stopId: route.stopId || null,
            arrival_time: route.arrival_time || null,
          }));
          sourceBus.status = "active";
          sourceBus.altered_to_bus_id = null;
          sourceBus.altered_to_preview = null;
          sourceBus.alteration_type = null;
          sourceBus.alteration_route_source = null;
          sourceBus.alteration_routes = [];
          sourceBus.altered_at = null;
          sourceBus.combined_route_source = null;
          sourceBus.combined_routes = [];
        } else {
          sourceBus.status = "inactive";
          sourceBus.altered_to_bus_id = targetBus._id;
          sourceBus.altered_to_preview = targetBus.preview_number ?? null;
          sourceBus.alteration_type = "alter";
          sourceBus.alteration_route_source = null;
          sourceBus.alteration_routes = [];
          sourceBus.altered_at = new Date();
        }

        const updatedTarget = await saveBusAtRevision(
          targetBus,
          busVersions.get(String(targetBus._id)),
          session,
        );
        const updatedSource = await saveBusAtRevision(
          sourceBus,
          busVersions.get(String(sourceBus._id)),
          session,
        );

        await updateStudentAssignmentsAtRevision(
          sourceUsers,
          (user) => assignmentByUserId.get(String(user._id)),
          session,
          "A rider assignment changed while the bus change was being applied. Reload and retry.",
        );

        await recordAssignmentMutation({
          session,
          actorId: req.user?.id,
          action: isCombined ? "buses-combined" : "bus-replaced",
          resourceId: change._id,
          requestId: getMutationHeaders(req).idempotencyKey,
          busRevisionBefore: expectedVersion,
          busRevisionAfter: updatedSource.revision,
          recipients: propagationRecipients,
          previousState: {
            buses: previousBusStates,
            assignments: assignmentSnapshots.map((snapshot) => ({
              user_id: snapshot.userId,
              bus_no: snapshot.beforeBusNo,
              assignment_revision: snapshot.beforeAssignmentRevision,
            })),
          },
          newState: {
            buses: [updatedSource, updatedTarget],
            assignments: assignmentSnapshots.map((snapshot) => ({
              user_id: snapshot.userId,
              bus_no: snapshot.afterBusNo,
              assignment_revision: snapshot.afterAssignmentRevision,
            })),
            status: "active",
          },
        });

        return {
          response: {
            message: previewMessage,
            sourceBusNo: sourceBus.bus_no,
            newBusNo: targetBus.bus_no,
            sourcePreview: sourceBus.preview_number,
            newPreview: targetBus.preview_number,
            notifiedStudents: uniqueUsers.size,
            temporaryChangeId: String(change._id),
            sourceRevision: updatedSource.revision,
            targetRevision: updatedTarget.revision,
          },
          resourceVersion: updatedSource.revision,
        };
      },
    });
    const io = getIO();
    if (io && !result.duplicate) {
      try {
        io.emit("bus-update", {
          actionType: isCombined ? "BUS_COMBINED" : "BUS_ALTERED",
          oldPreview: sourceBus.preview_number,
          newPreview: targetBus.preview_number,
        });
      } catch (error) {
        logSafeError("Temporary bus change websocket broadcast deferred", error);
      }
    }

    res.json({
      success: true,
      ...result.response,
      duplicate: result.duplicate,
    });
  } catch (error) {
    logSafeError(`${alterationType} bus failed`, error);
    const statusCode = error.statusCode || (error.code === 11000 ? 409 : 500);
    res.status(statusCode).json({
      success: false,
      error: error.statusCode
        ? error.message
        : error.code === 11000
          ? "Bus number, preview number, or GPS device ID is already in use."
          : `Failed to ${alterationType} the bus.`,
      ...(error.code ? { code: error.code } : {}),
    });
  }
}

async function alterBus(req, res) {
  return changeBus(req, res, "alter");
}

async function combineBus(req, res) {
  return changeBus(req, res, "combine");
}

async function restoreAlteredBus(req, res) {
  try {
    const { expectedVersion } = getMutationHeaders(req);
    const request = {
      busNo: normalizeBusNumber(req.params.busNo),
      operation: "restore-altered",
      expectedVersion,
    };
    const replay = await getBusMutationReplay(
      req,
      "restore-altered",
      request,
      expectedVersion,
    );
    if (replay) {
      return res.json({ success: true, ...replay.response, duplicate: true });
    }

    const bus = await findBusByIdentifier(req.params.busNo);
    if (!bus) {
      return res.status(404).json({ success: false, error: "Bus not found." });
    }
    if (await findActiveChangeForBus(bus._id)) {
      return res.status(409).json({
        success: false,
        error: "Use the temporary bus changes page to roll back this operation.",
      });
    }
    if (!bus.altered_to_bus_id) {
      return res.status(400).json({ success: false, error: "This bus is not combined." });
    }

    const replacementBus = await Bus.findById(bus.altered_to_bus_id);
    const previousPreview =
      replacementBus?.preview_number ?? bus.altered_to_preview ?? null;
    const alterationType = bus.alteration_type || "alter";
    const notificationType =
      alterationType === "combine" ? "bus_combined" : "bus_altered";
    const users = await findStudentsAssignedToBus(bus);
    const previousState = {
      status: bus.status,
      altered_to_bus_id: bus.altered_to_bus_id,
      altered_to_preview: bus.altered_to_preview,
      alteration_type: bus.alteration_type,
      bus_no: bus.bus_no,
      preview_number: bus.preview_number,
      revision: bus.revision ?? 0,
      assignments: users.map((user) => ({
        user_id: user._id,
        bus_no: user.bus_no,
        assignment_revision: user.assignmentRevision ?? 0,
      })),
    };
    const message =
      alterationType === "combine"
        ? `The combined service with bus ${previousPreview ?? "replacement"} has ended. Your original bus plans and stops are restored.`
        : `The bus alteration with bus ${previousPreview ?? "replacement"} has ended. Your original bus is restored.`;
    const result = await runBusMutation({
      req,
      operation: "restore-altered",
      request,
      resourceId: bus._id,
      expectedVersion,
      mutate: async (session) => {
        const updatedBus = await updateBusAtRevision(
          bus,
          expectedVersion,
          {
            status: "active",
            altered_to_bus_id: null,
            altered_to_preview: null,
            alteration_type: null,
            alteration_route_source: null,
            alteration_routes: [],
            altered_at: null,
          },
          session,
        );
        await updateStudentAssignmentsAtRevision(
          users,
          () => undefined,
          session,
          "A rider assignment changed while the altered bus was being restored. Reload and retry.",
        );
      await recordAssignmentMutation({
        session,
        actorId: req.user?.id,
        action: "altered-bus-restored",
        resourceId: bus._id,
        requestId: getMutationHeaders(req).idempotencyKey,
        busRevisionBefore: expectedVersion,
        busRevisionAfter: updatedBus.revision,
        recipients: users.map((user) => ({
          user_id: user._id,
          notification: {
            type: notificationType,
            message,
            old_bus_no: replacementBus?.bus_no ?? null,
            new_bus_no: bus.bus_no,
            old_preview: previousPreview,
            new_preview: bus.preview_number ?? null,
          },
        })),
        previousState,
        newState: {
          status: updatedBus.status,
          altered_to_bus_id: null,
          altered_to_preview: null,
          alteration_type: null,
          bus_no: updatedBus.bus_no,
          preview_number: updatedBus.preview_number,
          revision: updatedBus.revision,
          assignments: users.map((user) => ({
            user_id: user._id,
            bus_no: user.bus_no,
            assignment_revision: (user.assignmentRevision ?? 0) + 1,
          })),
        },
      });
        return {
          response: {
            message,
            previewNumber: updatedBus.preview_number,
            notifiedStudents: users.length,
            revision: updatedBus.revision,
          },
          resourceVersion: updatedBus.revision,
        };
      },
    });

    const io = getIO();
    if (io && !result.duplicate) {
      try {
        io.emit("bus-update", {
          actionType: "BUS_RESTORED",
          previewNumber: bus.preview_number,
        });
      } catch (error) {
        logSafeError("Bus restore websocket broadcast deferred", error);
      }
    }
    return res.json({
      success: true,
      ...result.response,
      duplicate: result.duplicate,
    });
  } catch (error) {
    logSafeError("Restore altered bus failed", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode ? error.message : "Failed to restore combined bus.",
      ...(error.code ? { code: error.code } : {}),
    });
  }
}

// ================= GET BUS ROUTES (PLANS + STOPS) =================
async function getBusRoutes(req, res) {
  try {
    if (String(req.user?.role || "").toLowerCase() === "student") {
      const assignment = await resolveStudentAssignment(req.user.id, {
        includeStops: true,
      });
      return res.json(
        assignment.publicSnapshot || getPublicAssignmentSnapshot(assignment),
      );
    }

    const { busNo } = req.params;

    const bus = await findBusByIdentifier(busNo);
    if (!bus) {
      return res
        .status(404)
        .json({ success: false, error: `Bus ${busNo} not found` });
    }
    const activePlan = await getCurrentGlobalPlan();
    const isSuperadmin =
      req.user && String(req.user.role || "").toLowerCase() === "superadmin";
    const assignment = await resolvePlanMappingAssignment(bus, activePlan);
    const mappedBus = assignment.routeBus;
    const locationBus = assignment.locationBus;
    const allPlanContext = isSuperadmin
      ? await loadEffectiveRoutesForAllPlans(bus, [mappedBus, locationBus])
      : null;
    const context =
      allPlanContext?.context ||
      (await loadBusReadContext([bus, mappedBus, locationBus]));
    const effectiveLocationBus = resolveEffectiveBusFromContext(
      context,
      locationBus,
    );
    const routes = isSuperadmin
      ? allPlanContext.routes
      : getContextRoutesForBus(context, mappedBus);
    const incomingChanges = getContextIncomingBusChanges(context, bus);
    const routeSelectionLabel = await getRouteSelectionLabel(
      bus,
      incomingChanges,
      context.busesById,
    );
    const routeBusPreviewNumber =
      mappedBus._id.equals(bus._id)
        ? (
      incomingChanges.find((changedBus) => changedBus.alteration_type === "alter")
        ?.preview_number ?? bus.preview_number
          )
        : mappedBus.preview_number;
    const isReplacementRoute = incomingChanges.some(
      (changedBus) => changedBus.alteration_type === "alter",
    );

    const plansMap = {};
    for (const r of routes) {
      if (!plansMap[r.plan_name]) plansMap[r.plan_name] = [];
      plansMap[r.plan_name].push({
        stopId: r.stopId,
        stop_name: r.stop_name,
        stop_order: r.stop_order,
        arrival_time: r.arrival_time || null,
        latitude: r.latitude,
        longitude: r.longitude,
        stopStatus: r.stopStatus,
      });
    }

    const activePlanKey = Object.keys(plansMap).find(
      (name) => normalizePlanName(name) === normalizePlanName(activePlan),
    );
    const isBusActiveInCurrentPlan = hasRouteForPlan(routes, activePlan);

    res.json({
      success: true,
      busNo: isSuperadmin ? bus.bus_no : String(bus.preview_number ?? bus.bus_no),
      previewNumber: bus.preview_number,
      effectivePreviewNumber: effectiveLocationBus.preview_number,
      routeBusPreviewNumber,
      isReplacementRoute,
      routeSelectionLabel,
      isBusActiveInCurrentPlan: !!isBusActiveInCurrentPlan,
      notActiveMessage: isBusActiveInCurrentPlan ? null : getInactivePlanMessage(activePlan),
      ...(isSuperadmin ? { plans: plansMap } : {}),
      stops: plansMap[activePlanKey] || [],
      hasStops: (plansMap[activePlanKey] || []).length > 0,
    });
  } catch (error) {
    logSafeError("Get bus routes failed", error);
    res.status(500).json({ success: false, error: "Internal server error." });
  }
}

// ================= UPDATE BUS DETAILS =================
async function updateBusDetails(req, res) {
  try {
    const { busNo } = req.params;
    const { previewNumber, gpsDeviceId, regNo } = req.body;
    const { idempotencyKey, expectedVersion } = getMutationHeaders(req);
    const update = {};
    if (previewNumber !== undefined) update.preview_number = previewNumber || null;
    if (gpsDeviceId !== undefined && gpsDeviceId !== null && gpsDeviceId !== "") {
      update.gps_device_id = gpsDeviceId;
    }
    if (regNo !== undefined) update.reg_no = regNo || null;
    if (!Object.keys(update).length) {
      return res.status(400).json({
        success: false,
        error: "Provide at least one bus detail to update.",
      });
    }
    const scope = `bus-details:${String(req.user?.id || "")}`;
    const request = {
      busNo: normalizeBusNumber(busNo),
      update,
      expectedVersion,
    };
    const replay = await checkIdempotentReplay({
      scope,
      idempotencyKey,
      request,
      expectedVersion,
    });
    if (replay) {
      return res.status(200).json({
        ...replay.response,
        duplicate: true,
      });
    }

    const bus = await Bus.findOne({ bus_no: normalizeBusNumber(busNo) });
    if (!bus) {
      return res
        .status(404)
        .json({ success: false, error: `Bus ${busNo} not found` });
    }

    if (Object.hasOwn(update, "preview_number")) {
      if (previewNumber !== null && previewNumber !== "") {
        const exists = await Bus.findOne({
          preview_number: previewNumber,
          bus_no: { $ne: bus.bus_no },
        });
        if (exists) {
          return res
            .status(400)
            .json({ success: false, error: "Preview number already in use" });
        }
      }
    }

    if (Object.hasOwn(update, "gps_device_id")) {
      const exists = await Bus.findOne({
        gps_device_id: gpsDeviceId,
        bus_no: { $ne: bus.bus_no },
      });
      if (exists) {
        return res
          .status(400)
          .json({ success: false, error: "GPS device ID already in use" });
      }
    }

    const result = await runIdempotentMutation({
      scope,
      idempotencyKey,
      actorId: req.user?.id,
      request,
      resourceId: bus._id,
      expectedVersion,
      mutate: async (session) => {
        const query = Bus.findOneAndUpdate(
          {
          $and: [
            { _id: bus._id },
            expectedVersion === 0
              ? {
                  $or: [
                    { revision: 0 },
                    { revision: { $exists: false } },
                  ],
                }
              : { revision: expectedVersion },
          ],
          },
          {
          $set: update,
          $inc: { revision: 1 },
          },
          {
          new: true,
          runValidators: true,
          ...(session ? { session } : {}),
          },
        );
        const updatedBus = await query.lean();
        if (!updatedBus) {
          const error = new Error(
          "The bus changed. Reload before applying this update.",
          );
          error.code = "BUS_REVISION_CONFLICT";
          error.statusCode = 409;
          throw error;
        }
        if (
          Object.hasOwn(update, "gps_device_id") &&
          String(bus.gps_device_id || "") !== String(updatedBus.gps_device_id || "")
        ) {
          await BusLiveLocation.deleteOne(
            { bus_id: bus._id },
            session ? { session } : {},
          );
        }
        const affectedUsers = await findStudentsAssignedToBus(bus);
        const previousState = {
          bus_no: bus.bus_no,
          preview_number: bus.preview_number,
          gps_device_id: bus.gps_device_id,
          reg_no: bus.reg_no,
          revision: bus.revision ?? 0,
        };
        await recordAssignmentMutation({
          session,
          actorId: req.user?.id,
          action: "bus-details-updated",
          resourceId: bus._id,
          requestId: idempotencyKey,
          busRevisionBefore: bus.revision ?? 0,
          busRevisionAfter: updatedBus.revision,
          recipients: affectedUsers.map((user) => ({
          user_id: user._id,
          notification: null,
          })),
          previousState,
          newState: {
          bus_no: updatedBus.bus_no,
          preview_number: updatedBus.preview_number,
          gps_device_id: updatedBus.gps_device_id,
          reg_no: updatedBus.reg_no,
          revision: updatedBus.revision,
          },
        });
        return {
          response: {
          success: true,
          message: "Bus details updated successfully",
          bus: {
            busNo: updatedBus.bus_no,
            previewNumber: updatedBus.preview_number,
            gpsDeviceId: updatedBus.gps_device_id,
            regNo: updatedBus.reg_no,
            revision: updatedBus.revision,
          },
          },
          resourceVersion: updatedBus.revision,
        };
      },
    });
    return res.status(200).json({
      ...result.response,
      duplicate: result.duplicate,
    });
  } catch (error) {
    logSafeError("Update bus details failed", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.statusCode
        ? error.message
        : "Internal server error.",
      ...(error.code ? { code: error.code } : {}),
    });
  }
}

// ================= GET PLANS =================
async function getPlans(req, res) {
  try {
    const { busNo } = req.params;

    const bus = await findBusByIdentifier(busNo);
    if (!bus) {
      return res.status(404).json({ error: `Bus ${busNo} not found` });
    }

    const effectiveRoutes = await getRoutesForBus(bus);
    res.json({
      plans: [...new Set(effectiveRoutes.map((route) => route.plan_name))].sort(),
      stops: effectiveRoutes.length,
    });
  } catch (error) {
    logSafeError("Get bus live location failed", error);
    res.status(500).json({ error: "Internal server error." });
  }
}

// ================= GET LIVE LOCATION =================
async function getLiveLocation(req, res) {
  try {
    const { busNo } = req.params;
    const normalizedBusNo = normalizeBusNumber(busNo ?? "");
    if (String(req.user?.role || "").toLowerCase() === "student") {
      const assignment = await resolveStudentAssignment(req.user.id, {
        includeStops: req.query?.gpsOnly !== "true",
      });
      return res.status(200).json(
        assignment.publicSnapshot || getPublicAssignmentSnapshot(assignment),
      );
    }
    if (req.query?.gpsOnly === "true") {
      return await getGpsLocationSnapshot(req, res, busNo, normalizedBusNo);
    }

    // Search by bus_no first, then fall back to preview_number.
    // This lets users track a bus via its short preview number (e.g. "4")
    // while still preferring exact bus_no matches to avoid ambiguity.
    let bus = await Bus.findOne({ bus_no: normalizedBusNo })
      .select(BUS_READ_FIELDS)
      .lean();
    if (!bus) {
      bus = await Bus.findOne({
        preview_number: { $in: [busNo, String(busNo)] },
      })
        .select(BUS_READ_FIELDS)
        .lean();
    }

    if (!bus) {
      return res.status(404).json({
        success: false,
        busNo: normalizedBusNo,
        error: "Bus not found",
        latitude: null,
        longitude: null,
        speed: null,
        status: "offline",
      });
    }

    const activePlan = await getCurrentGlobalPlan();
    const assignment = await resolvePlanMappingAssignment(bus, activePlan);
    const mappedBus = assignment.routeBus;
    const locationBus = assignment.hasTemporaryLocationBus
      ? assignment.locationBus
      : bus.altered_to_bus_id
        ? bus
        : mappedBus;
    const context = await loadBusReadContext([
      bus,
      mappedBus,
      assignment.locationBus,
      locationBus,
    ]);
    const effectiveBus = resolveEffectiveBusFromContext(context, locationBus);
    const incomingChanges = getContextIncomingBusChanges(context, bus);
    const alteration = assignment.hasTemporaryLocationBus
      ? {
          isAltered: true,
          alterationType: "plan_mapping",
          message: `For today's service, use Bus ${effectiveBus.preview_number ?? effectiveBus.bus_no}. Follow Bus ${mappedBus.preview_number ?? mappedBus.bus_no}'s stops and timings; open Home and tap View Stops to see the route.`,
          newPreview: effectiveBus.preview_number ?? null,
          effectivePreview: effectiveBus.preview_number ?? null,
        }
      : !mappedBus._id.equals(bus._id)
      ? {
          isAltered: true,
          alterationType: "plan_mapping",
          message: `For today's service, use Bus ${effectiveBus.preview_number ?? mappedBus.preview_number ?? "the assigned bus"}. Follow Bus ${mappedBus.preview_number ?? mappedBus.bus_no}'s stops and timings; open Home and tap View Stops to see the route.`,
          newPreview: effectiveBus.preview_number ?? null,
          effectivePreview: effectiveBus.preview_number ?? null,
        }
      : buildAlterationDetails(bus, effectiveBus) ||
        buildReplacementDetails(bus, incomingChanges);
    const location = await BusLiveLocation.findOne({ bus_id: effectiveBus._id })
      .select(
        "bus_id latitude longitude speed is_online lastSuccessfulGpsUpdate providerTimestamp locationVersion updatedAt source",
      )
      .lean();
    const routes = getContextRoutesForBus(context, mappedBus);
    const routeSelectionLabel = await getRouteSelectionLabel(
      bus,
      incomingChanges,
      context.busesById,
    );
    const routeBusPreviewNumber = mappedBus._id.equals(bus._id)
      ? incomingChanges.find((changedBus) => changedBus.alteration_type === "alter")
        ?.preview_number ?? bus.preview_number
      : mappedBus.preview_number;
    const isReplacementRoute = incomingChanges.some(
      (changedBus) => changedBus.alteration_type === "alter",
    );
    const activeStops = routes
      .filter(
        (route) =>
          normalizePlanName(route?.plan_name) === normalizePlanName(activePlan),
      )
      .map(
        ({
          stopId,
          stop_name,
          stop_order,
          latitude,
          longitude,
          stopStatus,
          arrival_time,
        }) => ({
          stopId,
          stop_name,
          stop_order,
          latitude,
          longitude,
          stopStatus,
          arrival_time,
        }),
      );
    const isBusActiveInCurrentPlan = activeStops.length > 0;

    // Privacy: only superadmin may receive internal bus_no in responses.
    const isSuperadmin = req.user && String(req.user.role || '').toLowerCase() === 'superadmin';

    // Choose the bus identifier to return to the client: previewNumber for regular users
    // and bus_no for superadmin.
    const clientBusIdentifier = isSuperadmin
      ? effectiveBus.bus_no
      : String(effectiveBus.preview_number ?? effectiveBus.bus_no);

    const responseData = {
      // A database bus is a successful lookup even when GPS has no record yet.
      // The client must be able to show its inactive plan and available-bus options.
      success: true,
      // For privacy return only the previewNumber to regular users.
      busNo: clientBusIdentifier,
      // Include bus_no only for superadmin
      ...(isSuperadmin ? { bus_no: clientBusIdentifier } : {}),
      isBusActiveInCurrentPlan: !!isBusActiveInCurrentPlan,
      notActiveMessage: isBusActiveInCurrentPlan
        ? null
        : getInactivePlanMessage(activePlan),
      previewNumber: effectiveBus.preview_number,
      effectivePreviewNumber: effectiveBus.preview_number,
      ...(isSuperadmin ? { effectiveBusNo: effectiveBus.bus_no } : {}),
      routeBusPreviewNumber,
      isReplacementRoute,
      routeSelectionLabel,
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null,
      speed: location?.speed ?? 0,
      status: location
        ? location.is_online
          ? "online"
          : "offline"
        : "offline",
      source: location?.source || "offline",
      lastSuccessfulGpsUpdate: location?.lastSuccessfulGpsUpdate ?? null,
      providerTimestamp: location?.providerTimestamp ?? null,
      locationVersion:
        location?.locationVersion == null
          ? null
          : String(location.locationVersion),
      lastUpdated:
        location?.lastSuccessfulGpsUpdate ?? location?.updatedAt ?? null,
      gpsOfflineThresholdMs:
        Number(process.env.GPS_OFFLINE_THRESHOLD_MS) || 3 * 60 * 1000,
      alteration,
      stops: activeStops,
      hasStops: activeStops.length > 0,
    };

    if (location) {
      res.status(200).json(responseData);
    } else {
      // Bus exists in DB but has no live location document yet → treat as offline
      res.status(200).json({
        ...responseData,
        success: true,
        status: "offline",
        source: "offline",
      });
    }
  } catch (error) {
    logSafeError("Get bus live location failed", error);
    res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
}

async function getGpsLocationSnapshot(req, res, busNo, normalizedBusNo) {
  let bus = await Bus.findOne({ bus_no: normalizedBusNo })
    .select("_id bus_no preview_number altered_to_bus_id")
    .lean();
  if (!bus) {
    bus = await Bus.findOne({
      preview_number: { $in: [busNo, String(busNo)] },
    })
      .select("_id bus_no preview_number altered_to_bus_id")
      .lean();
  }
  if (!bus) {
    return res.status(404).json({
      success: false,
      error: "Bus not found",
    });
  }

  const activePlan = await getCurrentGlobalPlan();
  let locationBus = bus;
  if (activePlan !== "PLAN A") {
    const mapping = await PlanMapping.findOne({
      plan_name: activePlan,
      $or: [{ root_bus_id: bus._id }, { member_bus_ids: bus._id }],
    })
      .select("root_bus_id location_bus_id member_bus_ids")
      .lean();
    if (mapping) {
      const isMember = (mapping.member_bus_ids || []).some(
        (memberBusId) => String(memberBusId) === String(bus._id),
      );
      const locationBusId = mapping.location_bus_id
        ? mapping.location_bus_id
        : isMember
          ? mapping.root_bus_id
          : bus._id;
      if (String(locationBusId) !== String(bus._id)) {
        locationBus =
          (await Bus.findById(locationBusId)
            .select("_id bus_no preview_number altered_to_bus_id")
            .lean()) || bus;
      }
    }
  }

  for (let depth = 0; locationBus?.altered_to_bus_id && depth < 20; depth += 1) {
    const replacement = await Bus.findById(locationBus.altered_to_bus_id)
      .select("_id bus_no preview_number altered_to_bus_id")
      .lean();
    if (!replacement) break;
    locationBus = replacement;
  }

  const location = await BusLiveLocation.findOne({ bus_id: locationBus._id })
    .select(
      "latitude longitude speed is_online lastSuccessfulGpsUpdate providerTimestamp locationVersion source",
    )
    .lean();
  const threshold =
    Number(process.env.GPS_OFFLINE_THRESHOLD_MS) || 3 * 60 * 1000;
  const lastSuccessfulGpsUpdate = location?.lastSuccessfulGpsUpdate ?? null;
  const lastSuccessTime = Date.parse(lastSuccessfulGpsUpdate);
  const isFresh =
    location?.is_online === true &&
    Number.isFinite(lastSuccessTime) &&
    Date.now() - lastSuccessTime <= threshold;
  const isSuperadmin =
    String(req.user?.role || "").toLowerCase() === "superadmin";
  const publicBusNumber = isSuperadmin
    ? locationBus.bus_no
    : String(locationBus.preview_number ?? locationBus.bus_no);

  return res.status(200).json({
    success: true,
    busNo: publicBusNumber,
    previewNumber: locationBus.preview_number ?? null,
    latitude: location?.latitude ?? null,
    longitude: location?.longitude ?? null,
    speed: location?.speed ?? 0,
    providerTimestamp: location?.providerTimestamp ?? null,
    lastSuccessfulGpsUpdate,
    locationVersion:
      location?.locationVersion == null
        ? null
        : String(location.locationVersion),
    is_online: isFresh,
    status: isFresh ? "online" : "offline",
    source: location?.source || "offline",
    gpsOfflineThresholdMs: threshold,
  });
}

async function getMyAssignment(req, res) {
  try {
    if (String(req.user?.role || "").toLowerCase() !== "student") {
      return res.status(403).json({
        success: false,
        error: "This endpoint is available to students only.",
      });
    }
    const assignment = await resolveStudentAssignment(req.user.id, {
      includeStops: true,
    });
    return res.status(200).json(
      assignment.publicSnapshot || getPublicAssignmentSnapshot(assignment),
    );
  } catch (error) {
    logSafeError("Get student assignment failed", error);
    return res.status(500).json({
      success: false,
      error: "Could not load your current bus assignment.",
    });
  }
}

// ================= TRACK BY PREVIEW =================
async function trackByPreview(req, res) {
  try {
    if (
      !["primary_admin", "superadmin"].includes(
        String(req.user?.role || "").toLowerCase(),
      )
    ) {
      return res.status(403).json({
        success: false,
        error: "Preview tracking is restricted to administrators.",
      });
    }

    const { previewNumber } = req.params;

    // Accept string or numeric preview numbers (e.g. "4" or 4).
    const bus = await Bus.findOne({
      preview_number: { $in: [previewNumber, String(previewNumber)] },
    })
      .select(BUS_READ_FIELDS)
      .lean();

    if (!bus) {
      return res.status(404).json({ error: "No bus found for preview number" });
    }

    const activePlan = await getCurrentGlobalPlan();
    const assignment = await resolvePlanMappingAssignment(bus, activePlan);
    const mappedBus = assignment.routeBus;
    const locationBus = assignment.hasTemporaryLocationBus
      ? assignment.locationBus
      : bus.altered_to_bus_id
        ? bus
        : mappedBus;
    const context = await loadBusReadContext([
      bus,
      mappedBus,
      assignment.locationBus,
      locationBus,
    ]);
    const effectiveBus = resolveEffectiveBusFromContext(context, locationBus);
    const incomingChanges = getContextIncomingBusChanges(context, bus);
    const alteration = assignment.hasTemporaryLocationBus
      ? {
          isAltered: true,
          alterationType: "plan_mapping",
          message:
            `Bus: Uses Bus ${effectiveBus.preview_number ?? effectiveBus.bus_no} location\n` +
            `Stops: Uses Bus ${mappedBus.preview_number ?? mappedBus.bus_no} stops; find them on the Home page.\n` +
            "If you have any doubts, ask your administration.",
          newPreview: effectiveBus.preview_number ?? null,
          effectivePreview: effectiveBus.preview_number ?? null,
        }
      : !mappedBus._id.equals(bus._id)
      ? {
          isAltered: true,
          alterationType: "plan_mapping",
          message:
            `Bus: Uses Bus ${effectiveBus.preview_number ?? mappedBus.preview_number ?? "the assigned bus"} location\n` +
            `Stops: Uses Bus ${mappedBus.preview_number ?? mappedBus.bus_no} stops; find them on the Home page.\n` +
            "If you have any doubts, ask your administration.",
          newPreview: effectiveBus.preview_number ?? null,
          effectivePreview: effectiveBus.preview_number ?? null,
        }
      : buildAlterationDetails(bus, effectiveBus) ||
        buildReplacementDetails(bus, incomingChanges);
    const location = await BusLiveLocation.findOne({ bus_id: effectiveBus._id })
      .select(
        "bus_id latitude longitude speed is_online lastSuccessfulGpsUpdate providerTimestamp locationVersion updatedAt source",
      )
      .lean();
    const routes = getContextRoutesForBus(context, mappedBus);
    const routeSelectionLabel = await getRouteSelectionLabel(
      bus,
      incomingChanges,
      context.busesById,
    );
    const routeBusPreviewNumber = mappedBus._id.equals(bus._id)
      ? incomingChanges.find((changedBus) => changedBus.alteration_type === "alter")
        ?.preview_number ?? bus.preview_number
      : mappedBus.preview_number;
    const isReplacementRoute = incomingChanges.some(
      (changedBus) => changedBus.alteration_type === "alter",
    );
    const isBusActiveInCurrentPlan = hasRouteForPlan(routes, activePlan);

    // Bus found → always return 200 with offline status if no location doc,
    // so the frontend can show the bus's plan even when GPS is offline.
    // Privacy: return previewNumber to regular users; superadmin may receive bus_no and plan.
    const isSuperadmin = req.user && String(req.user.role || '').toLowerCase() === 'superadmin';
    res.status(200).json({
      success: true,
      busNo: isSuperadmin
        ? effectiveBus.bus_no
        : String(effectiveBus.preview_number ?? effectiveBus.bus_no),
      ...(isSuperadmin ? { bus_no: effectiveBus.bus_no } : {}),
      previewNumber: effectiveBus.preview_number,
      effectivePreviewNumber: effectiveBus.preview_number,
      ...(isSuperadmin ? { effectiveBusNo: effectiveBus.bus_no } : {}),
      routeBusPreviewNumber,
      isReplacementRoute,
      routeSelectionLabel,
      isBusActiveInCurrentPlan: !!isBusActiveInCurrentPlan,
      notActiveMessage: isBusActiveInCurrentPlan
        ? null
        : getInactivePlanMessage(activePlan),
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null,
      speed: location?.speed ?? 0,
      status: location
        ? location.is_online
          ? "online"
          : "offline"
        : "offline",
      lastSuccessfulGpsUpdate: location?.lastSuccessfulGpsUpdate ?? null,
      providerTimestamp: location?.providerTimestamp ?? null,
      locationVersion:
        location?.locationVersion == null
          ? null
          : String(location.locationVersion),
      lastUpdated:
        location?.lastSuccessfulGpsUpdate ?? location?.updatedAt ?? null,
      gpsOfflineThresholdMs:
        Number(process.env.GPS_OFFLINE_THRESHOLD_MS) || 3 * 60 * 1000,
      alteration,
    });
  } catch (error) {
    logSafeError("Track bus by preview failed", error);
    res.status(500).json({ error: "Internal server error." });
  }
}

module.exports = {
  findBusByIdentifier,
  findStudentsAssignedToBus,
  resolveEffectiveBus,
  getCurrentGlobalPlan,
  getRoutesForBus,
  getAssignedBusRoutes,
  getIncomingBusChanges,
  updateBusNumber,
  getAllBuses,
  getBusesForPlan,
  deleteBus,
  activateBus,
  deactivateBus,
  validatePreviewNumber,
  updatePreviewNumber,
  updatePlan,
  setGlobalActivePlan,
  getGlobalActivePlan,
  updateBusDetails,
  getBusRoutes,
  getPlans,
  getLiveLocation,
  getMyAssignment,
  trackByPreview,
  alterBus,
  combineBus,
  restoreAlteredBus,
  getTemporaryBusChanges,
  rollbackTemporaryBusChange,
};
