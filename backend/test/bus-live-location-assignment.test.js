const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const AppSetting = require("../src/models/AppSetting");
const Bus = require("../src/models/Bus");
const BusLiveLocation = require("../src/models/BusLiveLocation");
const BusRoute = require("../src/models/BusRoute");
const PlanMapping = require("../src/models/PlanMapping");
const StopMaster = require("../src/models/StopMaster");
const {
  getLiveLocation,
  trackByPreview,
} = require("../src/controllers/bus.controller");

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
    select() {
      return this;
    },
    sort() {
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
  }
}

test("returns the altered bus identity and GPS for an assigned bus", async () => {
  const sourceId = new mongoose.Types.ObjectId();
  const replacementId = new mongoose.Types.ObjectId();
  const sourceBus = {
    _id: sourceId,
    bus_no: "BUS-12",
    preview_number: "12",
    altered_to_bus_id: replacementId,
    alteration_type: "alter",
  };
  const replacementBus = {
    _id: replacementId,
    bus_no: "BUS-21",
    preview_number: "21",
    altered_to_bus_id: null,
  };
  const location = {
    bus_id: replacementId,
    latitude: 11.5,
    longitude: 78,
    is_online: true,
    source: "gps",
  };

  await withModelMocks(
    {
      appSettingFindOne: () => ({ lean: async () => null }),
      busFindOne: async () => sourceBus,
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
        { params: { busNo: "BUS-12" }, user: { role: "student" } },
        response,
      );

      assert.equal(response.statusCode, 200);
      assert.equal(response.payload.busNo, "21");
      assert.equal(response.payload.previewNumber, "21");
      assert.equal(response.payload.latitude, 11.5);
      assert.equal(response.payload.longitude, 78);
      assert.equal(response.payload.gpsOfflineThresholdMs, 180_000);
      assert.equal(response.payload.alteration.originalPreview, undefined);
      assert.match(response.payload.alteration.message, /use Bus 21/);
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
    altered_to_bus_id: null,
  };
  const routeBus = {
    _id: routeId,
    bus_no: "BUS-21",
    preview_number: "21",
    altered_to_bus_id: null,
  };
  const locationBus = {
    _id: locationId,
    bus_no: "BUS-31",
    preview_number: "31",
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
  };

  await withModelMocks(
    {
      appSettingFindOne: () => ({ lean: async () => ({ value: "PLAN B" }) }),
      busFindOne: async () => assignedBus,
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
        { params: { busNo: "BUS-12" }, user: { role: "student" } },
        response,
      );

      assert.equal(response.statusCode, 200);
      assert.equal(response.payload.busNo, "31");
      assert.equal(response.payload.previewNumber, "31");
      assert.equal(response.payload.latitude, 11.6);
      assert.equal(response.payload.longitude, 78.1);
      assert.match(response.payload.alteration.message, /use Bus 31/);
      assert.match(response.payload.alteration.message, /Bus 21's stops/);
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
        { params: { previewNumber: "12" }, user: { role: "student" } },
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
