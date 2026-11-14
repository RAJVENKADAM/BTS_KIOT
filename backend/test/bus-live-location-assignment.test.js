const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const AppSetting = require("../src/models/AppSetting");
const Bus = require("../src/models/Bus");
const BusLiveLocation = require("../src/models/BusLiveLocation");
const BusRoute = require("../src/models/BusRoute");
const PlanMapping = require("../src/models/PlanMapping");
const StopMaster = require("../src/models/StopMaster");
const User = require("../src/models/User");
const GpsWorkerOwnership = require("../src/models/GpsWorkerOwnership");
const {
  getLiveLocation,
  trackByPreview,
} = require("../src/controllers/bus.controller");
const busRouter = require("../src/routes/bus.routes");
const { authenticateToken } = require("../src/middleware/auth");

function createResponse() {
  return {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function emptyQuery(result = []) {
  return {
    select() {
      return this;
    },
    sort() {
      return this;
    },
    lean: async () => result,
  };
}

function valueQuery(result) {
  return {
    select(fields) {
      result?.select?.(fields);
      return this;
    },
    sort(sort) {
      result?.sort?.(sort);
      return this;
    },
    lean: async () => (result?.lean ? result.lean() : result),
  };
}

async function withModelMocks(mocks, run) {
  const originals = {
    appSettingFindOne: AppSetting.findOne,
    busFindOne: Bus.findOne,
    busFind: Bus.find,
    busFindById: Bus.findById,
    liveLocationFindOne: BusLiveLocation.findOne,
    busRouteFind: BusRoute.find,
    planMappingFindOne: PlanMapping.findOne,
    stopMasterFind: StopMaster.find,
    userFindById: User.findById,
    gpsWorkerOwnershipFindById: GpsWorkerOwnership.findById,
  };

  AppSetting.findOne = mocks.appSettingFindOne;
  Bus.findOne = (...args) => valueQuery(mocks.busFindOne(...args));
  Bus.find = mocks.busFind || (() => emptyQuery());
  Bus.findById = mocks.busFindById || (async () => null);
  BusLiveLocation.findOne = (...args) =>
    valueQuery(mocks.liveLocationFindOne(...args));
  BusRoute.find = mocks.busRouteFind || (() => emptyQuery());
  PlanMapping.findOne = (...args) =>
    valueQuery(
      mocks.planMappingFindOne
        ? mocks.planMappingFindOne(...args)
        : null,
    );
  StopMaster.find = mocks.stopMasterFind || (() => emptyQuery());
  User.findById = mocks.userFindById || (() => valueQuery(null));
  GpsWorkerOwnership.findById =
    mocks.gpsWorkerOwnershipFindById || (() => valueQuery(null));

  try {
    await run();
  } finally {
    AppSetting.findOne = originals.appSettingFindOne;
    Bus.findOne = originals.busFindOne;
    Bus.find = originals.busFind;
    Bus.findById = originals.busFindById;
    BusLiveLocation.findOne = originals.liveLocationFindOne;
    BusRoute.find = originals.busRouteFind;
    PlanMapping.findOne = originals.planMappingFindOne;
    StopMaster.find = originals.stopMasterFind;
    User.findById = originals.userFindById;
    GpsWorkerOwnership.findById = originals.gpsWorkerOwnershipFindById;
  }
}

test("returns the altered bus identity and GPS for an assigned bus", async () => {
  const sourceId = new mongoose.Types.ObjectId();
  const replacementId = new mongoose.Types.ObjectId();
  const sourceBus = {
    _id: sourceId,
    bus_no: "BUS-12",
    preview_number: "12",
    status: "active",
    altered_to_bus_id: replacementId,
    alteration_type: "alter",
  };
  const replacementBus = {
    _id: replacementId,
    bus_no: "BUS-21",
    preview_number: "21",
    status: "active",
    altered_to_bus_id: null,
  };
  const location = {
    bus_id: replacementId,
    latitude: 11.5,
    longitude: 78,
    is_online: true,
    source: "gps",
    providerTimestamp: new Date(),
  };

  await withModelMocks(
    {
      appSettingFindOne: () => ({ lean: async () => null }),
      busFindOne: async () => sourceBus,
      userFindById: () => ({
        select() {
          return this;
        },
        lean: async () => ({
          _id: "student-1",
          role: "student",
          is_active: true,
          deleted_by_user: false,
          bus_no: "BUS-12",
        }),
      }),
      busFindById: () => ({
        select() {
          return this;
        },
        lean: async () => replacementBus,
      }),
      busFind: (filter) =>
        emptyQuery(
          filter._id
            ? filter._id.$in.includes(String(replacementId))
              ? [replacementBus]
              : []
            : [],
        ),
      liveLocationFindOne: async () => location,
    },
    async () => {
      const response = createResponse();
      await getLiveLocation(
        {
          params: { busNo: "BUS-999" },
          user: { id: "student-1", role: "student" },
        },
        response,
      );

      assert.equal(response.statusCode, 200);
      assert.equal(response.payload.busNo, "21");
      assert.equal(response.payload.previewNumber, "21");
      assert.equal(response.payload.latitude, 11.5);
      assert.equal(response.payload.longitude, 78);
      assert.equal(response.payload.gpsOfflineThresholdMs, 180_000);
      assert.equal(response.payload.isReplacementRoute, true);
      assert.equal(response.payload.routeBusPreviewNumber, "12");
      assert.equal("bus_no" in response.payload, false);
    },
  );
});

test("returns the mapped location bus identity after a global plan change", async () => {
  const assignedId = new mongoose.Types.ObjectId();
  const routeId = new mongoose.Types.ObjectId();
  const locationId = new mongoose.Types.ObjectId();
  const assignedBus = {
    _id: assignedId,
    bus_no: "BUS-12",
    preview_number: "12",
    status: "active",
    altered_to_bus_id: null,
  };
  const routeBus = {
    _id: routeId,
    bus_no: "BUS-21",
    preview_number: "21",
    status: "active",
    altered_to_bus_id: null,
  };
  const locationBus = {
    _id: locationId,
    bus_no: "BUS-31",
    preview_number: "31",
    status: "active",
    altered_to_bus_id: null,
  };
  const busesById = new Map([
    [String(routeId), routeBus],
    [String(locationId), locationBus],
  ]);
  const location = {
    bus_id: locationId,
    latitude: 11.6,
    longitude: 78.1,
    is_online: true,
    source: "gps",
    providerTimestamp: new Date(),
  };

  await withModelMocks(
    {
      appSettingFindOne: () => ({ lean: async () => ({ value: "PLAN B" }) }),
      busFindOne: async () => assignedBus,
      userFindById: () => ({
        select() {
          return this;
        },
        lean: async () => ({
          _id: "student-1",
          role: "student",
          is_active: true,
          deleted_by_user: false,
          bus_no: "BUS-12",
        }),
      }),
      busFind: (filter) =>
        emptyQuery(
          filter._id
            ? filter._id.$in
                .map((id) => busesById.get(String(id)))
                .filter(Boolean)
            : [],
        ),
      liveLocationFindOne: async () => location,
      planMappingFindOne: () => ({
        lean: async () => ({
          root_bus_id: routeId,
          location_bus_id: locationId,
          member_bus_ids: [assignedId],
        }),
      }),
    },
    async () => {
      const response = createResponse();
      await getLiveLocation(
        {
          params: { busNo: "BUS-999" },
          user: { id: "student-1", role: "student" },
        },
        response,
      );

      assert.equal(response.statusCode, 200);
      assert.equal(response.payload.busNo, "31");
      assert.equal(response.payload.previewNumber, "31");
      assert.equal(response.payload.latitude, 11.6);
      assert.equal(response.payload.longitude, 78.1);
      assert.equal(response.payload.routeBusPreviewNumber, "21");
    },
  );
});

test("primary admins and superadmins retain their existing live-location access and privacy", async () => {
  const bus = {
    _id: new mongoose.Types.ObjectId(),
    bus_no: "BUS-12",
    preview_number: "12",
    altered_to_bus_id: null,
  };
  await withModelMocks(
    {
      appSettingFindOne: () => ({ lean: async () => null }),
      busFindOne: async () => bus,
      liveLocationFindOne: async () => null,
    },
    async () => {
      const primaryAdminResponse = createResponse();
      await getLiveLocation(
        { params: { busNo: "BUS-12" }, user: { role: "primary_admin" } },
        primaryAdminResponse,
      );
      assert.equal(primaryAdminResponse.statusCode, 200);
      assert.equal(primaryAdminResponse.payload.busNo, "12");
      assert.equal("bus_no" in primaryAdminResponse.payload, false);

      const superadminResponse = createResponse();
      await getLiveLocation(
        { params: { busNo: "BUS-12" }, user: { role: "superadmin" } },
        superadminResponse,
      );
      assert.equal(superadminResponse.statusCode, 200);
      assert.equal(superadminResponse.payload.busNo, "BUS-12");
      assert.equal(superadminResponse.payload.bus_no, "BUS-12");
    },
  );
});

test("track-by-preview retains its public response shape and bus isolation", async () => {
  const bus = {
    _id: new mongoose.Types.ObjectId(),
    bus_no: "BUS-12",
    preview_number: "12",
    altered_to_bus_id: null,
  };
  await withModelMocks(
    {
      appSettingFindOne: () => ({ lean: async () => null }),
      busFindOne: async () => bus,
      liveLocationFindOne: async () => null,
    },
    async () => {
      const response = createResponse();
      await trackByPreview(
        { params: { previewNumber: "12" }, user: { role: "primary_admin" } },
        response,
      );

      assert.equal(response.statusCode, 200);
      assert.equal(response.payload.previewNumber, "12");
      assert.equal(response.payload.busNo, "12");
      assert.equal("bus_no" in response.payload, false);
      assert.equal(response.payload.status, "offline");
    },
  );
});

test("students cannot access fleet preview tracking", async () => {
  let busReads = 0;
  await withModelMocks(
    {
      appSettingFindOne: () => ({ lean: async () => null }),
      busFindOne: async () => {
        busReads++;
        return null;
      },
      liveLocationFindOne: async () => null,
    },
    async () => {
      const response = createResponse();
      await trackByPreview(
        { params: { previewNumber: "12" }, user: { role: "student" } },
        response,
      );
      assert.equal(response.statusCode, 403);
      assert.equal(busReads, 0);
    },
  );
});

test("GPS-only location snapshot is authenticated and performs only projected indexed reads", async () => {
  const bus = {
    _id: new mongoose.Types.ObjectId(),
    bus_no: "BUS-12",
    preview_number: "12",
    altered_to_bus_id: null,
  };
  const location = {
    bus_id: bus._id,
    latitude: 11.5,
    longitude: 78,
    speed: 10,
    is_online: true,
    source: "gps",
    lastSuccessfulGpsUpdate: new Date(Date.now() - 1000),
    providerTimestamp: new Date("2026-11-07T08:00:00Z"),
    locationVersion: 12n,
  };
  const busProjections = [];
  let liveLocationProjection;
  const route = busRouter.stack.find(
    (layer) => layer.route?.path === "/location/:busNo",
  );
  assert.equal(route.route.stack[0].handle, authenticateToken);

  await withModelMocks(
    {
      appSettingFindOne: () => ({ lean: async () => null }),
      busFindOne: (filter) => {
        assert.deepEqual(filter, { bus_no: "BUS-12" });
        return {
          select(fields) {
            busProjections.push(fields);
            return this;
          },
          lean: async () => bus,
        };
      },
      liveLocationFindOne: (filter) => {
        assert.deepEqual(filter, { bus_id: bus._id });
        return {
          select(fields) {
            liveLocationProjection = fields;
            return this;
          },
          lean: async () => location,
        };
      },
      busRouteFind: () => {
        throw new Error("GPS-only snapshot must not load bus routes");
      },
      stopMasterFind: () => {
        throw new Error("GPS-only snapshot must not load stops");
      },
    },
    async () => {
      const response = createResponse();
      await getLiveLocation(
        {
          params: { busNo: "BUS-12" },
          query: { gpsOnly: "true" },
          user: { role: "primary_admin" },
        },
        response,
      );

      assert.equal(response.statusCode, 200);
      assert.deepEqual(busProjections, [
        "_id bus_no preview_number altered_to_bus_id",
      ]);
      assert.equal(
        liveLocationProjection,
        "latitude longitude speed is_online lastSuccessfulGpsUpdate providerTimestamp locationVersion source",
      );
      assert.equal(response.payload.locationVersion, "12");
      assert.equal(response.payload.previewNumber, "12");
      assert.equal(response.payload.status, "online");
      assert.equal("gpsFenceToken" in response.payload, false);
      assert.equal("publicationPending" in response.payload, false);
      assert.equal("bus_no" in response.payload, false);
      assert.deepEqual(
        Object.keys(response.payload).sort(),
        [
          "success",
          "busNo",
          "previewNumber",
          "latitude",
          "longitude",
          "speed",
          "providerTimestamp",
          "lastSuccessfulGpsUpdate",
          "locationVersion",
          "is_online",
          "status",
          "source",
          "gpsOfflineThresholdMs",
        ].sort(),
      );
    },
  );
});

test("GPS-only location snapshot rejects an unknown bus without reading location state", async () => {
  let locationReads = 0;
  await withModelMocks(
    {
      appSettingFindOne: () => ({ lean: async () => null }),
      busFindOne: async () => null,
      liveLocationFindOne: async () => {
        locationReads++;
        return null;
      },
    },
    async () => {
      const response = createResponse();
      await getLiveLocation(
        {
          params: { busNo: "UNKNOWN" },
          query: { gpsOnly: "true" },
          user: { role: "primary_admin" },
        },
        response,
      );
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.payload, {
        success: false,
        error: "Bus not found",
      });
      assert.equal(locationReads, 0);
    },
  );
});

test("GPS-only snapshot resolves active-plan location mapping without loading route context", async () => {
  const sourceBus = {
    _id: new mongoose.Types.ObjectId(),
    bus_no: "BUS-12",
    preview_number: "12",
    altered_to_bus_id: null,
  };
  const mappedBus = {
    _id: new mongoose.Types.ObjectId(),
    bus_no: "BUS-21",
    preview_number: "21",
    altered_to_bus_id: null,
  };
  const location = {
    latitude: 11,
    longitude: 78,
    is_online: false,
    locationVersion: 13n,
  };
  let liveLocationFilter;
  let relatedBusProjection;
  let routeReads = 0;
  await withModelMocks(
    {
      appSettingFindOne: () => ({
        lean: async () => ({ value: "PLAN B" }),
      }),
      busFindOne: () => sourceBus,
      planMappingFindOne: () => ({
        root_bus_id: sourceBus._id,
        location_bus_id: mappedBus._id,
        member_bus_ids: [sourceBus._id],
      }),
      busFindById: () => ({
        select(fields) {
          relatedBusProjection = fields;
          return this;
        },
        lean: async () => mappedBus,
      }),
      liveLocationFindOne: (filter) => {
        liveLocationFilter = filter;
        return location;
      },
      busRouteFind: () => {
        routeReads++;
        throw new Error("GPS-only snapshot must not load bus routes");
      },
      stopMasterFind: () => {
        throw new Error("GPS-only snapshot must not load stops");
      },
    },
    async () => {
      const response = createResponse();
      await getLiveLocation(
        {
          params: { busNo: "BUS-12" },
          query: { gpsOnly: "true" },
          user: { role: "primary_admin" },
        },
        response,
      );
      assert.equal(response.statusCode, 200);
      assert.deepEqual(liveLocationFilter, { bus_id: mappedBus._id });
      assert.equal(
        relatedBusProjection,
        "_id bus_no preview_number altered_to_bus_id",
      );
      assert.equal(response.payload.previewNumber, "21");
      assert.equal(response.payload.locationVersion, "13");
      assert.equal(response.payload.status, "offline");
      assert.equal(routeReads, 0);
    },
  );
});
