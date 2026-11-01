require("dotenv").config();
const mongoose = require("mongoose");
const { MONGODB_URI } = require("../src/config/mongodb");
const Bus = require("../src/models/Bus");
const BusChange = require("../src/models/BusChange");
const BusLiveLocation = require("../src/models/BusLiveLocation");
const BusRoute = require("../src/models/BusRoute");
const PlanMapping = require("../src/models/PlanMapping");
const User = require("../src/models/User");
const groupBusNumberRecords = require("../src/utils/groupBusNumberRecords");
const mergeBusRouteRecords = require("../src/utils/mergeBusRouteRecords");
const normalizeBusNumber = require("../src/utils/normalizeBusNumber");

function getDistinctValues(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && String(value).trim() !== "").map(String))];
}

function getConflict(group) {
  const previews = getDistinctValues(group.buses.map((bus) => bus.preview_number));
  if (previews.length > 1) {
    return `conflicting preview numbers: ${previews.join(", ")}`;
  }

  const alteredBuses = group.buses.filter(
    (bus) => bus.altered_to_bus_id || bus.alteration_type,
  );
  if (alteredBuses.length > 1) {
    return "multiple buses have alteration/combine settings";
  }
  const groupIds = new Set(group.buses.map((bus) => String(bus._id)));
  if (alteredBuses.some((bus) => groupIds.has(String(bus.altered_to_bus_id)))) {
    return "an alteration/combine setting would point the merged bus to itself";
  }
  return null;
}

async function buildMigrationPlan(group, session) {
  const busIds = group.buses.map((bus) => bus._id);
  const routes = await BusRoute.find({ bus_id: { $in: busIds } })
    .session(session || null)
    .lean();
  const users = await User.collection.countDocuments(
    {
      bus_no: { $in: group.buses.map((bus) => String(bus.bus_no).trim()) },
    },
    { session },
  );
  const locations = await BusLiveLocation.find({ bus_id: { $in: busIds } })
    .session(session || null)
    .lean();
  const activeChange = await BusChange.findOne({
    status: { $in: ["applying", "active"] },
    $or: [
      { sourceBusId: { $in: busIds } },
      { targetBusId: { $in: busIds } },
    ],
  })
    .select("_id")
    .session(session || null)
    .lean();
  const conflict = getConflict(group);
  if (conflict) throw new Error(`Bus ${group.canonicalBusNo}: ${conflict}.`);
  if (activeChange) {
    throw new Error(
      `Bus ${group.canonicalBusNo} has an active temporary bus change; roll it back first.`,
    );
  }

  const orderedBusIds = [
    group.keeper._id,
    ...group.duplicates.map((bus) => bus._id),
  ];
  const mergedRoutes = mergeBusRouteRecords(routes, orderedBusIds);
  const deviceAliases = getDistinctValues(
    group.buses.flatMap((bus) => [
      bus.gps_device_id,
      ...(bus.gps_device_aliases || []),
    ]),
  ).filter((deviceId) => deviceId !== String(group.keeper.gps_device_id));
  const regNoAliases = getDistinctValues(
    group.buses.flatMap((bus) => [
      bus.reg_no,
      ...(bus.reg_no_aliases || []),
    ]),
  ).filter((regNo) => regNo !== String(group.keeper.reg_no));
  const inheritedAlteration = group.buses.find(
    (bus) => String(bus._id) !== String(group.keeper._id) &&
      (bus.altered_to_bus_id || bus.alteration_type),
  );
  const locationByFreshness = [...locations].sort((first, second) => {
    const firstTime = new Date(
      first.lastSuccessfulGpsUpdate || first.updatedAt || 0,
    ).getTime();
    const secondTime = new Date(
      second.lastSuccessfulGpsUpdate || second.updatedAt || 0,
    ).getTime();
    return secondTime - firstTime;
  });

  return {
    ...group,
    routes,
    mergedRoutes,
    userCount: users,
    locations,
    freshestLocation: locationByFreshness[0] || null,
    deviceAliases,
    regNoAliases,
    inheritedAlteration,
  };
}

async function migrateGroup(plan, session) {
  const duplicateIds = plan.duplicates.map((bus) => bus._id);
  const keeperId = plan.keeper._id;
  const busNoAliases = plan.buses.map((bus) => String(bus.bus_no).trim());
  const location = plan.freshestLocation;

  await User.collection.updateMany(
    { bus_no: { $in: busNoAliases } },
    { $set: { bus_no: plan.canonicalBusNo } },
    { session },
  );

  for (const { route, stopOrder } of plan.mergedRoutes.retainedRoutes) {
    await BusRoute.updateOne(
      { _id: route._id },
      {
        $set: {
          bus_id: keeperId,
          stop_order: stopOrder,
          arrival_time: route.arrival_time ?? null,
          ...(route.stopId ? { stopId: route.stopId } : {}),
        },
      },
      { session },
    );
  }
  if (plan.mergedRoutes.duplicateIds.length) {
    await BusRoute.deleteMany(
      { _id: { $in: plan.mergedRoutes.duplicateIds } },
      { session },
    );
  }

  if (location) {
    const { _id, bus_id, createdAt, updatedAt, ...locationFields } = location;
    await BusLiveLocation.updateOne(
      { bus_id: keeperId },
      {
        $set: { ...locationFields, bus_id: keeperId },
        $setOnInsert: { createdAt },
      },
      { upsert: true, session },
    );
  }
  await BusLiveLocation.deleteMany(
    { bus_id: { $in: duplicateIds } },
    { session },
  );

  const mappingQuery = {
    $or: [
      { root_bus_id: { $in: duplicateIds } },
      { location_bus_id: { $in: duplicateIds } },
      { member_bus_ids: { $in: duplicateIds } },
    ],
  };
  const mappings = await PlanMapping.find(mappingQuery).session(session).lean();
  for (const mapping of mappings) {
    const memberBusIds = [...new Set(
      (mapping.member_bus_ids || [])
        .map((id) =>
          duplicateIds.some((duplicateId) => String(duplicateId) === String(id))
            ? String(keeperId)
            : String(id),
        )
        .filter((id) => id !== String(keeperId) ||
          String(mapping.root_bus_id) !== String(keeperId)),
    )];
    await PlanMapping.updateOne(
      { _id: mapping._id },
      {
        $set: {
          root_bus_id: duplicateIds.some(
            (id) => String(id) === String(mapping.root_bus_id),
          ) ? keeperId : mapping.root_bus_id,
          location_bus_id: duplicateIds.some(
            (id) => String(id) === String(mapping.location_bus_id),
          ) ? keeperId : mapping.location_bus_id,
          member_bus_ids: memberBusIds,
        },
      },
      { session },
    );
  }

  if (duplicateIds.length) {
    await Bus.updateMany(
      { altered_to_bus_id: { $in: duplicateIds } },
      { $set: { altered_to_bus_id: keeperId } },
      { session },
    );
  }

  const busUpdate = {
    gps_device_aliases: plan.deviceAliases,
    reg_no_aliases: plan.regNoAliases,
  };
  if (!plan.keeper.preview_number) {
    const preview = plan.buses.find((bus) => bus.preview_number)?.preview_number;
    if (preview) busUpdate.preview_number = preview;
  }
  if (!plan.keeper.reg_no) {
    const regNo = plan.buses.find((bus) => bus.reg_no)?.reg_no;
    if (regNo) busUpdate.reg_no = regNo;
  }
  if (!plan.keeper.bus_name) {
    const busName = plan.buses.find((bus) => bus.bus_name)?.bus_name;
    if (busName) busUpdate.bus_name = busName;
  }
  if (plan.buses.some((bus) => bus.status === "active")) {
    busUpdate.status = "active";
  }
  if (plan.inheritedAlteration) {
    for (const field of [
      "altered_to_bus_id",
      "altered_to_preview",
      "alteration_type",
      "alteration_route_source",
      "alteration_routes",
      "combined_route_source",
      "combined_routes",
      "altered_at",
    ]) {
      busUpdate[field] = plan.inheritedAlteration[field];
    }
  }
  if (plan.canonicalBusNo !== String(plan.keeper.bus_no).trim()) {
    busUpdate.bus_no = plan.canonicalBusNo;
  }
  await Bus.updateOne({ _id: keeperId }, { $set: busUpdate }, { session });

  if (duplicateIds.length) {
    await Bus.deleteMany({ _id: { $in: duplicateIds } }, { session });
  }
  return {
    busNo: plan.canonicalBusNo,
    busRecordsMerged: plan.buses.length,
    usersReassigned: plan.userCount,
    routesMerged: plan.routes.length - plan.mergedRoutes.duplicateIds.length,
  };
}

async function migrate(session) {
  const buses = await Bus.find({}).session(session || null).lean();
  const groups = groupBusNumberRecords(buses);
  const plans = [];
  for (const group of groups) {
    plans.push(await buildMigrationPlan(group, session));
  }
  const legacyUsers = await User.collection.find(
    { bus_no: /^0[1-9]$/ },
    { projection: { _id: 1, bus_no: 1 }, session },
  ).toArray();
  const userCountsByBusNo = new Map();
  for (const user of legacyUsers) {
    const canonicalBusNo = normalizeBusNumber(user.bus_no);
    userCountsByBusNo.set(
      canonicalBusNo,
      (userCountsByBusNo.get(canonicalBusNo) || 0) + 1,
    );
  }

  if (session) {
    for (const canonicalBusNo of userCountsByBusNo.keys()) {
      const legacyBusNo = `0${canonicalBusNo}`;
      await User.collection.updateMany(
        { bus_no: legacyBusNo },
        { $set: { bus_no: canonicalBusNo } },
        { session },
      );
    }
  }

  const summaries = [];
  for (const plan of plans) {
    summaries.push(session
      ? await migrateGroup(plan, session)
      : {
          busNo: plan.canonicalBusNo,
          busRecordsMerged: plan.buses.length,
          usersReassigned: plan.userCount,
          routesMerged:
            plan.routes.length - plan.mergedRoutes.duplicateIds.length,
        });
  }
  return {
    buses: summaries,
    userAssignmentsNormalized: legacyUsers.length,
    usersByCanonicalBusNo: Object.fromEntries(userCountsByBusNo),
  };
}

async function main() {
  const apply = process.argv.includes("--apply");
  await mongoose.connect(MONGODB_URI);
  try {
    if (apply) {
      const session = await mongoose.startSession();
      let summaries;
      try {
        await session.withTransaction(async () => {
          summaries = await migrate(session);
        });
      } finally {
        await session.endSession();
      }
      console.log("Bus-number migration applied:", JSON.stringify(summaries, null, 2));
    } else {
      const summaries = await migrate(null);
      console.log(
        "Dry run only. Review this plan, back up the database, then rerun with --apply:",
        JSON.stringify(summaries, null, 2),
      );
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  console.error("Bus-number migration failed:", error);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
