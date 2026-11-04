const assert = require("node:assert/strict");
const test = require("node:test");
const Bus = require("../src/models/Bus");
const BusLiveLocation = require("../src/models/BusLiveLocation");
const { setIO } = require("../src/socket");
const { registerTrackSocketHandlers } = require("../src/socket/trackSocket");
const { GpsSyncWorker } = require("../src/workers/gpsSyncWorker");

function locationIo(sockets) {
  const emissions = [];
  const io = {
    to(room) {
      const rooms = new Set([room]);
      const operator = {
        to(nextRoom) {
          rooms.add(nextRoom);
          return operator;
        },
        emit(event, payload) {
          const recipients = sockets
            .filter((socket) => [...rooms].some((joinedRoom) => socket.rooms.has(joinedRoom)))
            .map((socket) => socket.id);
          emissions.push({ event, payload, rooms: [...rooms], recipients });
        },
      };
      return operator;
    },
  };
  return { io, emissions };
}

test("worker emits one location event to the union of relevant rooms", () => {
  const firstSocket = {
    id: "socket-1",
    rooms: new Set(["preview_4", "user_student-1"]),
  };
  const secondSocket = {
    id: "socket-2",
    rooms: new Set(["user_student-2"]),
  };
  const unrelatedSocket = {
    id: "socket-3",
    rooms: new Set(["preview_9", "user_other"]),
  };
  const { io, emissions } = locationIo([
    firstSocket,
    secondSocket,
    unrelatedSocket,
  ]);
  const worker = new GpsSyncWorker({
    socketGetter: () => io,
  });
  worker.staleThresholdMs = 180_000;

  worker.emitLocation(
    { preview_number: "4", bus_no: "BUS-4" },
    {
      latitude: 10,
      longitude: 77,
      speed: 5,
      is_online: true,
      lastSuccessfulGpsUpdate: new Date("2026-11-04T00:00:00Z"),
      source: "gps",
      user_id: "student-1",
    },
    new Map([["BUS-4", new Set(["student-1", "student-2"])]]),
    new Date("2026-11-04T00:00:00Z"),
  );

  assert.equal(emissions.length, 1);
  assert.equal(emissions[0].event, "locationUpdate");
  assert.deepEqual(emissions[0].recipients, ["socket-1", "socket-2"]);
  assert.deepEqual(
    Object.keys(emissions[0].payload).sort(),
    [
      "gpsOfflineThresholdMs",
      "is_online",
      "lastSuccessfulGpsUpdate",
      "lastUpdated",
      "latitude",
      "longitude",
      "previewNumber",
      "source",
      "speed",
      "status",
    ].sort(),
  );
  assert.equal(emissions[0].payload.gpsOfflineThresholdMs, 180_000);
});

test("legacy socket location request uses projected lean reads and preserves event fields", async () => {
  const originalBusFindOne = Bus.findOne;
  const originalLocationFindOne = BusLiveLocation.findOne;
  const bus = { _id: "bus-4", bus_no: "BUS-4", preview_number: "4" };
  const location = {
    latitude: 10,
    longitude: 77,
    speed: 4,
    is_online: true,
    source: "gps",
    lastSuccessfulGpsUpdate: new Date("2026-11-04T00:00:00Z"),
    updatedAt: new Date("2026-11-04T00:00:00Z"),
  };
  const busProjections = [];
  let locationProjection;
  let connectionHandler;
  const socketEvents = {};
  const output = [];
  const io = {
    on(event, handler) {
      assert.equal(event, "connection");
      connectionHandler = handler;
    },
  };
  const socket = {
    user: { id: "student-1" },
    join() {},
    on(event, handler) {
      socketEvents[event] = handler;
    },
    emit(event, payload) {
      output.push({ event, payload });
    },
  };
  Bus.findOne = (filter) => ({
    select(fields) {
      busProjections.push(fields);
      return this;
    },
    lean: async () => (filter.bus_no ? bus : null),
  });
  BusLiveLocation.findOne = (filter) => ({
    select(fields) {
      locationProjection = fields;
      assert.equal(filter.bus_id, bus._id);
      return this;
    },
    lean: async () => location,
  });
  setIO(io);

  try {
    registerTrackSocketHandlers();
    connectionHandler(socket);
    await socketEvents["request-bus-location"]("BUS-4");

    assert.deepEqual(busProjections, ["_id bus_no preview_number"]);
    assert.match(locationProjection, /latitude longitude speed/);
    assert.equal(output.length, 1);
    assert.equal(output[0].event, "locationUpdate");
    assert.deepEqual(
      Object.keys(output[0].payload).sort(),
      [
        "gpsOfflineThresholdMs",
        "is_online",
        "lastSuccessfulGpsUpdate",
        "lastUpdated",
        "latitude",
        "longitude",
        "previewNumber",
        "source",
        "speed",
        "status",
      ].sort(),
    );
    assert.equal(output[0].payload.previewNumber, "4");
    assert.equal(output[0].payload.gpsOfflineThresholdMs, 180_000);
  } finally {
    Bus.findOne = originalBusFindOne;
    BusLiveLocation.findOne = originalLocationFindOne;
    setIO(null);
  }
});
