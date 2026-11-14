const Bus = require('../models/Bus');
const BusRoute = require('../models/BusRoute');
const BusLiveLocation = require('../models/BusLiveLocation');
const StopMaster = require('../models/StopMaster');
const User = require('../models/User');
const BusChange = require('../models/BusChange');
const { randomUUID } = require("node:crypto");
const { recordAssignmentMutation } = require("../services/assignmentPropagation");
const {
  checkIdempotentReplay,
  getMutationHeaders,
  runIdempotentMutation,
} = require("../services/mutationIdempotency");
const { normalizeArrivalTime } = require("../utils/planMapping");
const normalizeStopNameKey = require("../utils/normalizeStopName");
const getRouteUpdateImpactBuses = require("../utils/routeUpdateImpact");
const normalizeBusNumber = require("../utils/normalizeBusNumber");
const { logSafeError } = require("../utils/safeErrorLog");
const importLedger = require("../services/importLedger");

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function normalizeBusNo(busNo) {
  return normalizeBusNumber(busNo || '');
}

function normalizePlanName(planName) {
  return (planName || '').toString().trim();
}

function normalizeStopName(stopName) {
  return (stopName || '').toString().trim();
}

function normalizeStopOrder(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildRouteKey(busId, plan_name, stop_order) {
  return `${busId}__${plan_name}__${stop_order}`;
}

async function incrementAssignmentRevision(student, session) {
  const expectedRevision = student.assignmentRevision ?? 0;
  const conditions = [{ _id: student._id }];
  if (Object.hasOwn(student, "bus_no")) {
    conditions.push({ bus_no: student.bus_no });
  }
  conditions.push(
    expectedRevision === 0
      ? {
          $or: [
            { assignmentRevision: 0 },
            { assignmentRevision: { $exists: false } },
          ],
        }
      : { assignmentRevision: expectedRevision },
  );
  const result = await User.updateOne(
    { $and: conditions },
    { $inc: { assignmentRevision: 1 } },
    session ? { session } : {},
  );
  if (result.matchedCount !== 1) {
    const error = new Error(
      "A student assignment changed during the route import. Reload and retry.",
    );
    error.code = "BUS_ASSIGNMENT_CONFLICT";
    error.statusCode = 409;
    throw error;
  }
}

async function getRouteUpdateRecipients(updatedBus, session) {
  let incomingChangesQuery = Bus.find({
    altered_to_bus_id: updatedBus._id,
    alteration_type: { $in: ["alter", "combine"] },
  }).select("_id bus_no preview_number alteration_type alteration_route_source");
  if (session) incomingChangesQuery = incomingChangesQuery.session(session);
  const incomingChanges = await incomingChangesQuery.lean();
  const affectedBuses = getRouteUpdateImpactBuses(
    updatedBus,
    incomingChanges,
  );
  const identifiers = [
    ...new Set(
      affectedBuses.flatMap((bus) =>
        [bus.bus_no, bus.preview_number]
          .filter((value) => value !== null && value !== undefined)
          .map(String),
      ),
    ),
  ];
  if (!identifiers.length) return [];

  let usersQuery = User.find({
    bus_no: {
      $in: identifiers.map(
        (identifier) =>
          new RegExp(
            `^${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
            "i",
          ),
      ),
    },
    role: "student",
    is_active: true,
  }).select("_id");
  if (session) usersQuery = usersQuery.session(session);
  const users = await usersQuery;
  if (!users.length) return [];

  const isCombined =
    updatedBus.alteration_type === "combine" ||
    affectedBuses.some((bus) => bus.alteration_type === "combine");
  const notificationType = isCombined ? "bus_combined" : "bus_altered";
  const message = `Route stops for Bus ${updatedBus.preview_number ?? updatedBus.bus_no} have been updated. Check your bus route for the latest stops.`;
  return users.map((user) => ({
      user_id: user._id,
      notification: {
        type: notificationType,
        message,
        new_bus_no: updatedBus.bus_no,
        new_preview: updatedBus.preview_number ?? null,
      },
    }));
}

async function importBusRoutes(req, res) {
  let ledgerUploadId;
  let ledgerOwner;
  let ledgerRow;
  try {
    const payload = req.body || {};
    const { expectedVersion, idempotencyKey } = getMutationHeaders(req);
    const request = {
      ...payload,
      expectedVersion,
    };
    const scope = `bus-routes:${String(req.user?.id || "")}`;
    const replay = await checkIdempotentReplay({
      scope,
      idempotencyKey,
      request,
      expectedVersion,
    });
    if (replay) {
      return res.status(200).json({
        success: true,
        ...replay.response,
        duplicate: true,
      });
    }

    const {
      busNo,
      previewNumber = null,
      gpsId = null,
      deviceId = null,
      regNo = null,
      routesByPlan = null,
      // optional: allow flat routes too
      routes = null,
      replaceRoutes = false,
    } = payload;

    if (!isNonEmptyString(busNo)) {
      return res.status(400).json({ success: false, error: 'busNo is required' });
    }

    const normalizedBusNoValue = normalizeBusNo(busNo);
    const busFilter = { bus_no: normalizedBusNoValue };
    const existingBus = await Bus.findOne(busFilter)
      .select("_id bus_no revision bus_name preview_number gps_device_id reg_no status altered_to_bus_id alteration_type alteration_route_source")
      .lean();
    if (existingBus) {
      const activeChange = await BusChange.findOne({
        status: { $in: ["applying", "active"] },
        $or: [
          { sourceBusId: existingBus._id },
          { targetBusId: existingBus._id },
        ],
      }).select("_id");
      if (activeChange) {
        return res.status(409).json({
          success: false,
          error: "Roll back the temporary bus change before editing this bus's routes.",
        });
      }
    }

    // Normalize routes into routesByPlan map
    let normalizedRoutesByPlan = {};
    if (routesByPlan && typeof routesByPlan === 'object') {
      normalizedRoutesByPlan = routesByPlan;
    } else if (Array.isArray(routes)) {
      // Expect each route has plan_name
      for (const r of routes) {
        const plan = normalizePlanName(r?.plan_name);
        if (!plan) continue;
        normalizedRoutesByPlan[plan] = normalizedRoutesByPlan[plan] || [];
        normalizedRoutesByPlan[plan].push(r);
      }
    }

    const planNames = Object.keys(normalizedRoutesByPlan);
    const allStops = [];
    for (const plan of planNames) {
      const list = Array.isArray(normalizedRoutesByPlan[plan]) ? normalizedRoutesByPlan[plan] : [];
      for (const stop of list) {
        allStops.push({ plan_name: plan, ...stop });
      }
    }

    const summary = {
      totalRows: allStops.length,
      insertedRows: 0,
      updatedRows: 0,
      unchangedRows: 0,
      failedRows: 0,
      rowResults: [],
    };

    // Validate bus
    if (!isNonEmptyString(deviceId) && !isNonEmptyString(gpsId)) {
      // Your existing Bus schema uses gps_device_id as required.
      // We'll treat deviceId as gps_device_id (matches your AddBusesScreen).
      return res.status(400).json({ success: false, error: 'deviceId (gps_device_id) is required' });
    }

    const gps_device_id = isNonEmptyString(gpsId) ? gpsId : deviceId;

    // Validate and normalize route rows
    const normalizedStops = allStops.map((row, idx) => {
      try {
        const plan_name = normalizePlanName(row.plan_name);
        const stop_name = normalizeStopName(row.stop_name);
        const stop_order = normalizeStopOrder(row.stop_order);
        const arrival_time = normalizeArrivalTime(row.arrival_time);
        const stopId = row.stopId || row.stop_id || null;

        if (!plan_name) throw new Error('Invalid plan_name');
        if (!stop_name) throw new Error('Invalid stop_name');
        if (stop_order === null || stop_order < 1) throw new Error('Invalid stop_order');

        return {
          ok: true,
          idx,
          value: { plan_name, stop_name, stop_order, stopId, arrival_time },
        };
      } catch (e) {
        return { ok: false, idx, error: e.message || 'Validation error' };
      }
    });

    for (const r of normalizedStops) {
      if (!r.ok) {
        summary.failedRows += 1;
        summary.rowResults.push({ index: r.idx, status: 'failed', reason: r.error });
      }
    }

    const good = normalizedStops.filter((r) => r.ok).map((r) => r.value);

    // Allow creating a bus with zero routes (no Excel uploaded yet).
    // Only reject if routes were provided but ALL rows failed validation.
    if (allStops.length > 0 && good.length === 0) {
      return res.status(400).json({ success: false, summary, error: 'All route rows failed validation' });
    }

    const masterStops = await StopMaster.find({})
      .select("stopId name")
      .lean();
    const stopsByName = new Map();
    const stopsById = new Map(masterStops.map((stop) => [stop.stopId, stop]));
    masterStops.forEach((stop) => {
      const key = normalizeStopNameKey(stop.name);
      stopsByName.set(key, [...(stopsByName.get(key) || []), stop]);
    });
    const pendingStopsByName = new Map();
    const pendingStops = [];
    const resolvedStops = [];
    for (const row of good) {
      let stop = row.stopId ? stopsById.get(String(row.stopId)) : null;
      if (!stop) {
        const matches = stopsByName.get(normalizeStopNameKey(row.stop_name)) || [];
        if (matches.length > 1) {
          return res.status(400).json({
            success: false,
            error: `Stop "${row.stop_name}" matches multiple Stop Master names; rename the duplicate entries before importing this route.`,
          });
        }
        stop = matches[0];
      }

      if (!stop) {
        const key = normalizeStopNameKey(row.stop_name);
        stop = pendingStopsByName.get(key);
        if (!stop) {
          stop = {
            stopId: `STOP-${randomUUID()}`,
            name: row.stop_name.trim().replace(/\s+/g, " "),
            source: "EXISTING_STOP",
            status: "PENDING",
          };
          pendingStops.push(stop);
          pendingStopsByName.set(key, stop);
        }
      }
      resolvedStops.push({ ...row, stopId: stop.stopId, stop_name: stop.name });
    }

    const staged = await importLedger.createOrResumeImport({
      actorId: req.user?.id,
      importType: "bus-routes",
      idempotencyKey,
      content: request,
      rows: [{
        rowNumber: 1,
        identity: normalizedBusNoValue,
        expectedVersion,
        expectedVersionCaptured: true,
        input: request,
      }],
    });
    ledgerUploadId = staged.uploadId;
    if (staged.operation?.status === "completed" && staged.operation.result) {
      return res.status(200).json({
        success: true,
        ...staged.operation.result,
        uploadId: ledgerUploadId,
        duplicate: true,
      });
    }
    if (staged.staging) {
      return res.status(202).json({
        success: true,
        status: "processing",
        uploadId: ledgerUploadId,
      });
    }
    ledgerOwner = randomUUID();
    ledgerRow = await importLedger.claimNextRow(ledgerUploadId, ledgerOwner);
    if (!ledgerRow) {
      const current = await importLedger.finalizeImport(ledgerUploadId);
      if (current?.status === "completed" && current.result) {
        return res.status(200).json({
          success: true,
          ...current.result,
          uploadId: ledgerUploadId,
          duplicate: true,
        });
      }
      return res.status(202).json({
        success: true,
        status: current?.status || "processing",
        uploadId: ledgerUploadId,
      });
    }

    const mutation = await runIdempotentMutation({
      scope,
      idempotencyKey,
      actorId: req.user?.id,
      request,
      resourceId: existingBus?._id || normalizedBusNoValue,
      expectedVersion,
      mutate: async (session) => {
        const options = session ? { session } : {};
        if (pendingStops.length) {
          await StopMaster.create(pendingStops, options);
        }

        let currentBusQuery = Bus.findOne(busFilter)
          .select("_id bus_no revision bus_name preview_number gps_device_id reg_no status");
        if (session) currentBusQuery = currentBusQuery.session(session);
        const busBeforeMutation = await currentBusQuery.lean();
        let persistedBus;
        if (busBeforeMutation) {
          const revisionFilter = expectedVersion === 0
            ? {
                $or: [
                  { revision: 0 },
                  { revision: { $exists: false } },
                ],
              }
            : { revision: expectedVersion };
          persistedBus = await Bus.findOneAndUpdate(
            {
              $and: [
                { _id: busBeforeMutation._id },
                revisionFilter,
              ],
            },
            {
              $set: {
                bus_name: busNo,
                gps_device_id,
                reg_no: regNo || null,
                preview_number: previewNumber || null,
              },
              $inc: { revision: 1 },
            },
            {
              new: true,
              runValidators: true,
              ...options,
            },
          ).lean();
          if (!persistedBus) {
            const error = new Error(
              "The bus changed. Reload before importing routes.",
            );
            error.code = "BUS_REVISION_CONFLICT";
            error.statusCode = 409;
            throw error;
          }
        } else {
          if (expectedVersion !== 0) {
            const error = new Error(
              "A new bus must use expectedVersion 0.",
            );
            error.code = "BUS_REVISION_CONFLICT";
            error.statusCode = 409;
            throw error;
          }
          const [createdBus] = await Bus.create(
            [{
              ...busFilter,
              bus_name: busNo,
              gps_device_id,
              reg_no: regNo || null,
              preview_number: previewNumber || null,
              status: "active",
              revision: 0,
            }],
            options,
          );
          persistedBus = createdBus.toObject();
        }
        if (
          busBeforeMutation &&
          String(busBeforeMutation.gps_device_id || "") !==
            String(persistedBus.gps_device_id || "")
        ) {
          await BusLiveLocation.deleteOne(
            { bus_id: persistedBus._id },
            options,
          );
        }

        const desiredBusState = {
          bus_no: normalizedBusNoValue,
          bus_name: busNo,
          gps_device_id,
          reg_no: regNo || null,
          preview_number: previewNumber || null,
          status: busBeforeMutation?.status || "active",
        };
        const metadataChanged =
          !busBeforeMutation ||
          ["bus_name", "gps_device_id", "reg_no", "preview_number"].some(
            (field) =>
              String(busBeforeMutation[field] ?? "") !==
              String(desiredBusState[field] ?? ""),
          );
        const assignmentIdentityChanged =
          !busBeforeMutation ||
          String(busBeforeMutation.preview_number ?? "") !==
            String(desiredBusState.preview_number ?? "");
        let affectedStudents = [];
        let assignmentSnapshots = [];
        let priorCandidates = [];
        if (assignmentIdentityChanged) {
          const identifiers = [
            normalizedBusNoValue,
            busBeforeMutation?.preview_number,
            desiredBusState.preview_number,
          ].filter((value) => value !== null && value !== undefined && value !== "");
          const identifierPatterns = [...new Set(identifiers.map(String))].map(
            (identifier) => new RegExp(`^${escapeRegExp(identifier)}$`, "i"),
          );
          let studentsQuery = User.find({
            bus_no: { $in: identifierPatterns },
            role: "student",
            is_active: true,
            deleted_by_user: { $ne: true },
          }).select("_id bus_no assignmentRevision");
          let busesQuery = Bus.find({
            $or: [
              { bus_no: { $in: identifierPatterns } },
              { preview_number: { $in: identifierPatterns } },
            ],
          }).select("_id bus_no preview_number status");
          if (session) {
            studentsQuery = studentsQuery.session(session);
            busesQuery = busesQuery.session(session);
          }
          affectedStudents = await studentsQuery.lean();
          priorCandidates = await busesQuery.lean();
        }

        if (assignmentIdentityChanged) {
          const newCandidates = priorCandidates.filter(
            (candidate) =>
              String(candidate._id) !== String(busBeforeMutation?._id || ""),
          );
          newCandidates.push(persistedBus);
          const resolveAlias = (value, candidates) => {
            if (value === null || value === undefined || value === "") return null;
            const normalized = normalizeBusNo(value);
            return (
              candidates.find(
                (candidate) => normalizeBusNo(candidate.bus_no) === normalized,
              ) ||
              candidates.find(
                (candidate) =>
                  String(candidate.preview_number ?? "") === String(value),
              ) ||
              null
            );
          };
          assignmentSnapshots = affectedStudents.map((student) => {
            const beforeBus = resolveAlias(student.bus_no, priorCandidates);
            const afterBus = resolveAlias(student.bus_no, newCandidates);
            return {
              user_id: student._id,
              bus_no: student.bus_no ?? null,
              previous_effective_bus_id: beforeBus?._id ?? null,
              new_effective_bus_id: afterBus?._id ?? null,
              previous_assignment_revision: student.assignmentRevision ?? 0,
              new_assignment_revision: (student.assignmentRevision ?? 0) + 1,
              assignment_changed:
                String(beforeBus?._id ?? "") !== String(afterBus?._id ?? ""),
            };
          });
          assignmentSnapshots = assignmentSnapshots.filter(
            (snapshot) => snapshot.assignment_changed,
          );
          affectedStudents = affectedStudents.filter((student) =>
            assignmentSnapshots.some(
              (snapshot) =>
                String(snapshot.user_id) === String(student._id),
            ),
          );
          for (const student of affectedStudents) {
            await incrementAssignmentRevision(student, session);
          }
        }

        if (metadataChanged) {
          await recordAssignmentMutation({
            session,
            actorId: req.user?.id,
            action: busBeforeMutation
              ? "bus-metadata-updated-by-route-import"
              : "bus-created-by-route-import",
            resourceId: persistedBus._id,
            requestId: idempotencyKey,
            busRevisionBefore: busBeforeMutation?.revision ?? null,
            busRevisionAfter: persistedBus.revision ?? 0,
            recipients: affectedStudents.map((student) => ({
              user_id: student._id,
              notification: null,
            })),
            previousState: {
              bus: busBeforeMutation || null,
              assignments: assignmentSnapshots.map((assignment) => ({
                user_id: assignment.user_id,
                bus_no: assignment.bus_no,
                effective_bus_id: assignment.previous_effective_bus_id,
                assignment_revision: assignment.previous_assignment_revision,
              })),
            },
            newState: {
              bus: persistedBus,
              assignments: assignmentSnapshots.map((assignment) => ({
                user_id: assignment.user_id,
                bus_no: assignment.bus_no,
                effective_bus_id: assignment.new_effective_bus_id,
                assignment_revision: assignment.new_assignment_revision,
              })),
            },
          });
        }

        let previousRoutesQuery = BusRoute.find({ bus_id: persistedBus._id })
          .select("plan_name stop_name stop_order arrival_time");
        if (session) previousRoutesQuery = previousRoutesQuery.session(session);
        const previousRoutes = replaceRoutes
          ? await previousRoutesQuery.lean()
          : [];
        const previousArrivalByStop = new Map(
          previousRoutes.map((row) => [
            `${normalizePlanName(row.plan_name)}:${row.stop_order}:${normalizeStopNameKey(row.stop_name)}`,
            row.arrival_time,
          ]),
        );
        const goodWithBus = resolvedStops.map((row) => ({
          ...row,
          bus_id: persistedBus._id,
          arrival_time:
            row.arrival_time ||
            previousArrivalByStop.get(
              `${normalizePlanName(row.plan_name)}:${row.stop_order}:${normalizeStopNameKey(row.stop_name)}`,
            ) ||
            null,
        }));

        if (!goodWithBus.length) {
          if (replaceRoutes) {
            const recipients = busBeforeMutation
              ? await getRouteUpdateRecipients(persistedBus, session)
              : [];
            await BusRoute.deleteMany({ bus_id: persistedBus._id }, options);
            await recordAssignmentMutation({
              session,
              actorId: req.user?.id,
              action: "bus-routes-replaced",
              resourceId: persistedBus._id,
              requestId: idempotencyKey,
              recipients,
              previousState: { routes: previousRoutes },
              newState: { routes: [] },
            });
          }
          const response = {
            busNo: normalizedBusNoValue,
            previewNumber: persistedBus.preview_number,
            summary,
          };
          await importLedger.completeClaimedRow({
            uploadId: ledgerUploadId,
            rowId: ledgerRow._id,
            owner: ledgerOwner,
            session,
            resultResourceId: persistedBus._id,
            result: response,
          });
          return {
            response,
            resourceVersion: persistedBus.revision ?? 0,
          };
        }

        let existingRoutesQuery = replaceRoutes
          ? null
          : BusRoute.find({
              bus_id: persistedBus._id,
              plan_name: {
                $in: Array.from(
                  new Set(goodWithBus.map((row) => row.plan_name)),
                ),
              },
            });
        if (session && existingRoutesQuery) {
          existingRoutesQuery = existingRoutesQuery.session(session);
        }
        const existing = existingRoutesQuery
          ? await existingRoutesQuery.lean()
          : [];
        const existingKeyToRow = new Map(
          existing.map((row) => [
            buildRouteKey(
              persistedBus._id.toString(),
              row.plan_name,
              row.stop_order,
            ),
            row,
          ]),
        );
        const ops = [];
        for (const row of goodWithBus) {
          const key = buildRouteKey(
            persistedBus._id.toString(),
            row.plan_name,
            row.stop_order,
          );
          const current = existingKeyToRow.get(key);
          if (!current) {
            ops.push({
              updateOne: {
                filter: {
                  bus_id: persistedBus._id,
                  plan_name: row.plan_name,
                  stop_order: row.stop_order,
                },
                update: {
                  $set: {
                    bus_id: persistedBus._id,
                    plan_name: row.plan_name,
                    stop_name: row.stop_name,
                    stop_order: row.stop_order,
                    stopId: row.stopId,
                    ...(row.arrival_time
                      ? { arrival_time: row.arrival_time }
                      : {}),
                  },
                },
                upsert: true,
              },
            });
            continue;
          }

          const unchanged =
            current.stop_name === row.stop_name &&
            current.stop_order === row.stop_order &&
            current.plan_name === row.plan_name &&
            current.stopId === row.stopId &&
            (!row.arrival_time || current.arrival_time === row.arrival_time);
          if (unchanged) {
            summary.unchangedRows += 1;
            continue;
          }
          ops.push({
            updateOne: {
              filter: {
                bus_id: persistedBus._id,
                plan_name: row.plan_name,
                stop_order: row.stop_order,
              },
              update: {
                $set: {
                  stop_name: row.stop_name,
                  stopId: row.stopId,
                  ...(row.arrival_time
                    ? { arrival_time: row.arrival_time }
                    : {}),
                },
              },
              upsert: false,
            },
          });
        }

        if (replaceRoutes || ops.length) {
          const recipients = busBeforeMutation
            ? await getRouteUpdateRecipients(persistedBus, session)
            : [];
          if (replaceRoutes) {
            await BusRoute.deleteMany({ bus_id: persistedBus._id }, options);
          }
          const writeResult = ops.length
            ? await BusRoute.bulkWrite(ops, {
                ordered: false,
                ...options,
              })
            : null;
          await recordAssignmentMutation({
            session,
            actorId: req.user?.id,
            action: replaceRoutes ? "bus-routes-replaced" : "bus-routes-updated",
            resourceId: persistedBus._id,
            requestId: idempotencyKey,
            recipients,
            previousState: { routes: replaceRoutes ? previousRoutes : existing },
            newState: { routes: goodWithBus },
          });
          summary.insertedRows = writeResult?.upsertedCount || 0;
          summary.updatedRows = writeResult?.modifiedCount || 0;
        }

        const response = {
          busNo: normalizedBusNoValue,
          previewNumber: persistedBus.preview_number,
          summary,
        };
        await importLedger.completeClaimedRow({
          uploadId: ledgerUploadId,
          rowId: ledgerRow._id,
          owner: ledgerOwner,
          session,
          resultResourceId: persistedBus._id,
          result: response,
        });
        return {
          response,
          resourceVersion: persistedBus.revision ?? 0,
        };
      },
    });

    const finalized = await importLedger.finalizeImport(
      ledgerUploadId,
      mutation.response,
    );
    return res.status(200).json({
      success: true,
      ...mutation.response,
      uploadId: ledgerUploadId,
      status: finalized?.status || "completed",
      duplicate: mutation.duplicate,
    });
  } catch (error) {
    if (ledgerUploadId && ledgerRow && ledgerOwner) {
      try {
        await importLedger.failClaimedRow({
          uploadId: ledgerUploadId,
          claimedRowId: ledgerRow._id,
          owner: ledgerOwner,
          category: error?.statusCode === 409 ? "revision_conflict" : "processing",
          message:
            error?.statusCode === 409
              ? "The bus or assignment state changed. Reload and retry with a new operation."
              : "The route import did not complete and can be retried with the same key and content.",
          conflict: error?.statusCode === 409,
          retryable: error?.statusCode !== 409,
        });
        await importLedger.finalizeImport(ledgerUploadId);
      } catch (ledgerError) {
        logSafeError("Bus route import ledger update failed", ledgerError);
      }
    }
    logSafeError('importBusRoutes failed', error);
    const statusCode = error.statusCode || (error.code === 11000 ? 409 : 500);
    return res.status(statusCode).json({
      success: false,
      summary: { totalRows: 0, insertedRows: 0, updatedRows: 0, unchangedRows: 0, failedRows: 1 },
      error: error.statusCode
        ? error.message
        : error.code === 11000
          ? "Bus number, preview number, or GPS device ID is already in use."
          : 'Route import failed. Please try again.',
      ...(error.code ? { code: error.code } : {}),
    });
  }
}

module.exports = { importBusRoutes };
