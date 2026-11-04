const assert = require("node:assert/strict");
const test = require("node:test");
const Bus = require("../src/models/Bus");
const BusChange = require("../src/models/BusChange");
const BusLiveLocation = require("../src/models/BusLiveLocation");
const User = require("../src/models/User");
const { getAllBuses } = require("../src/controllers/bus.controller");

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

function createQuery(result, onSelect) {
  return {
    select(fields) {
      onSelect?.(fields);
      return this;
    },
    sort() {
      return this;
    },
    lean: async () => result,
  };
}

async function withModelMocks(mocks, run) {
  const originals = {
    busFind: Bus.find,
    busChangeFind: BusChange.find,
    locationFind: BusLiveLocation.find,
    userAggregate: User.aggregate,
  };

  Bus.find = mocks.busFind;
  BusChange.find = mocks.busChangeFind;
  BusLiveLocation.find = mocks.locationFind;
  User.aggregate = mocks.userAggregate;

  try {
    await run();
  } finally {
    Bus.find = originals.busFind;
    BusChange.find = originals.busChangeFind;
    BusLiveLocation.find = originals.locationFind;
    User.aggregate = originals.userAggregate;
  }
}

function createMocks({ role, buses, locations, studentCounts }) {
  let pipeline;
  let busProjection;
  let locationProjection;
  return {
    mocks: {
      busFind: () => createQuery(buses, (fields) => (busProjection = fields)),
      busChangeFind: () => createQuery([]),
      locationFind: () =>
        createQuery(locations, (fields) => (locationProjection = fields)),
      userAggregate: async (value) => {
        pipeline = value;
        return studentCounts;
      },
    },
    get captured() {
      return { pipeline, busProjection, locationProjection };
    },
    request: { user: { role } },
  };
}

test("bus list uses projections and grouped student counts without changing admin fields", async () => {
  const setup = createMocks({
    role: "superadmin",
    buses: [
      {
        _id: "bus-1",
        bus_no: "BUS-1",
        preview_number: "1",
        status: "active",
        gps_device_id: "gps-1",
        reg_no: "REG-1",
        mobile_live: false,
        altered_to_bus_id: null,
        altered_to_preview: null,
        altered_at: null,
        alteration_type: null,
        combined_route_source: null,
      },
    ],
    locations: [
      {
        bus_id: "bus-1",
        latitude: 11,
        longitude: 78,
        speed: 20,
        is_online: true,
        lastSuccessfulGpsUpdate: new Date("2025-01-01T00:00:00Z"),
        updatedAt: new Date("2025-01-01T00:00:00Z"),
        source: "gps",
      },
    ],
    studentCounts: [
      { _id: "BUS-1", count: 2 },
      { _id: " bus-1 ", count: 1 },
    ],
  });

  await withModelMocks(setup.mocks, async () => {
    const response = createResponse();
    await getAllBuses(setup.request, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.count, 1);
    assert.equal(response.payload.buses[0].busNo, "BUS-1");
    assert.equal(response.payload.buses[0].riderCount, 3);
    assert.equal(response.payload.buses[0].latitude, 11);
    assert.equal(response.payload.buses[0].isOnline, true);
    assert.equal(response.payload.buses[0].canBeTemporaryReplacement, true);
  });

  assert.match(setup.captured.busProjection, /bus_no/);
  assert.match(setup.captured.busProjection, /altered_to_bus_id/);
  assert.match(setup.captured.locationProjection, /lastSuccessfulGpsUpdate/);
  assert.deepEqual(setup.captured.pipeline[0].$match, {
    role: "student",
    is_active: true,
    bus_no: { $nin: [null, ""] },
  });
  assert.equal(setup.captured.pipeline[1].$group._id, "$bus_no");
});

test("bus list preserves the public response privacy projection", async () => {
  const setup = createMocks({
    role: "student",
    buses: [
      {
        _id: "bus-1",
        bus_no: "BUS-1",
        preview_number: "1",
        status: "active",
        gps_device_id: "gps-1",
        reg_no: "REG-1",
        mobile_live: false,
        altered_to_bus_id: null,
        altered_to_preview: null,
        altered_at: null,
        alteration_type: null,
        combined_route_source: null,
      },
    ],
    locations: [],
    studentCounts: [{ _id: "BUS-1", count: 3 }],
  });

  await withModelMocks(setup.mocks, async () => {
    const response = createResponse();
    await getAllBuses(setup.request, response);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.payload.buses[0], {
      previewNumber: "1",
      status: "active",
      mobileLive: false,
      latitude: null,
      longitude: null,
      speed: 0,
      isOnline: false,
      lastUpdated: null,
      source: "offline",
    });
    assert.deepEqual(response.payload.alteredBuses, []);
  });

  assert.equal(setup.captured.pipeline, undefined);
});

test("user schema declares the index required by the admin assignment aggregate", () => {
  const indexes = User.schema.indexes().map(([fields]) => fields);
  assert.ok(
    indexes.some(
      (fields) =>
        fields.role === 1 && fields.is_active === 1 && fields.bus_no === 1,
    ),
  );
});
