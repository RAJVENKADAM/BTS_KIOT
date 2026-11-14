const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const test = require("node:test");
const { registerTrackSocketHandlers } = require("../src/socket/trackSocket");

function createHarness({
  active = true,
  lookupDelayMs = 0,
  resolveStudentAssignmentFn,
} = {}) {
  const ioHandlers = {};
  const queries = [];
  const io = {
    on(event, handler) {
      ioHandlers[event] = handler;
    },
  };
  const BusModel = {
    findOne(filter) {
      queries.push(filter);
      return {
        select(fields) {
          assert.equal(fields, "_id");
          return this;
        },
        lean: async () => {
          if (lookupDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, lookupDelayMs));
          }
          return active ? { _id: "bus-1" } : null;
        },
      };
    },
    findById() {
      throw new Error("Unexpected bus lookup");
    },
  };
  const BusLiveLocationModel = {
    findOne() {
      throw new Error("Unexpected location lookup");
    },
  };
  registerTrackSocketHandlers({
    io,
    BusModel,
    BusLiveLocationModel,
    resolveStudentAssignmentFn,
  });
  return { ioHandlers, queries };
}

function createSocket(id) {
  const events = {};
  return {
    id,
    user: { id: `student-${id}`, role: "primary_admin" },
    connected: true,
    rooms: new Set(),
    events,
    emissions: [],
    join(room) {
      this.rooms.add(room);
    },
    leave(room) {
      this.rooms.delete(room);
    },
    on(event, handler) {
      events[event] = handler;
    },
    emit(event, payload) {
      this.emissions.push({ event, payload });
    },
  };
}

async function connectSocket(harness, socket) {
  harness.ioHandlers.connection(socket);
}

test("connection adds the authenticated user room and invalid preview inputs are ignored", async () => {
  const harness = createHarness();
  const socket = createSocket("one");
  await connectSocket(harness, socket);
  socket.events["join-user"]("another-student");
  await socket.events["join-bus"]({ preview: "4" });
  await socket.events["join-bus"]("");
  await socket.events["join-bus"](null);
  await socket.events["join-bus"]("  ");
  await socket.events["join-bus"]("x".repeat(65));
  await socket.events["join-bus"]("4\n");
  await socket.events["request-bus-location"]("x".repeat(65));
  await socket.events["request-bus-location"]("BUS-\u0000");

  assert.ok(socket.rooms.has("user_student-one"));
  assert.equal(socket.rooms.has("user_another-student"), false);
  assert.equal(harness.queries.length, 0);
});

test("students can join only their resolved bus and cannot request another bus", async () => {
  const resolvedUsers = [];
  const snapshot = { success: true, busNo: "21", gpsStatus: "fresh" };
  const harness = createHarness({
    resolveStudentAssignmentFn: async (userId) => {
      resolvedUsers.push(userId);
      return {
        assignmentStatus: "assigned",
        effectiveBus: { _id: "authorized-bus-id" },
        publicSnapshot: snapshot,
      };
    },
  });
  const socket = createSocket("assigned-student");
  socket.user = { id: "student-42", role: "student" };
  await connectSocket(harness, socket);
  await new Promise((resolve) => setImmediate(resolve));

  await socket.events["join-bus"]("another-bus-preview");
  await socket.events["request-bus-location"]("another-bus-id");

  assert.deepEqual(resolvedUsers, [
    "student-42",
    "student-42",
    "student-42",
  ]);
  assert.ok(socket.rooms.has("assigned_bus_authorized-bus-id"));
  assert.equal(socket.rooms.has("preview_another-bus-preview"), false);
  assert.equal(harness.queries.length, 0);
  assert.deepEqual(
    socket.emissions.map(({ event, payload }) => ({ event, payload })),
    [
      { event: "assigned-bus-update", payload: snapshot },
      { event: "assigned-bus-update", payload: snapshot },
    ],
  );
});

test("repeated preview joins do one active-bus lookup and one room join", async () => {
  const harness = createHarness({ lookupDelayMs: 5 });
  const socket = createSocket("one");
  let roomJoinCount = 0;
  const originalJoin = socket.join.bind(socket);
  socket.join = (room) => {
    roomJoinCount++;
    originalJoin(room);
  };
  await connectSocket(harness, socket);

  await Promise.all([
    socket.events["join-bus"]("4"),
    socket.events["join-bus"](" 4 "),
    socket.events["join-bus"](4),
  ]);
  await socket.events["join-bus"]("4");

  assert.equal(harness.queries.length, 1);
  assert.equal(roomJoinCount, 2);
  assert.ok(socket.rooms.has("preview_4"));
});

test("multiple sockets for one user each remain in the authenticated user room", async () => {
  const harness = createHarness();
  const firstDevice = createSocket("device-a");
  const secondDevice = createSocket("device-b");
  const otherUser = createSocket("other-user");
  firstDevice.user.id = "student-1";
  secondDevice.user.id = "student-1";
  otherUser.user.id = "student-2";

  await Promise.all([
    connectSocket(harness, firstDevice),
    connectSocket(harness, secondDevice),
    connectSocket(harness, otherUser),
  ]);

  assert.ok(firstDevice.rooms.has("user_student-1"));
  assert.ok(secondDevice.rooms.has("user_student-1"));
  assert.ok(otherUser.rooms.has("user_student-2"));
  assert.equal(firstDevice.rooms.has("user_student-2"), false);
  assert.equal(secondDevice.rooms.has("user_student-2"), false);
});

test("reconnect bursts for the same preview share validation work across sockets", async () => {
  const harness = createHarness({ lookupDelayMs: 10 });
  const sockets = Array.from({ length: 1_000 }, (_, index) =>
    createSocket(`viewer-${index}`),
  );
  const started = performance.now();
  for (const socket of sockets) await connectSocket(harness, socket);
  await Promise.all(
    sockets.map((socket) => socket.events["join-bus"]("4")),
  );
  const elapsedMs = performance.now() - started;
  const joined = sockets.filter((socket) => socket.rooms.has("preview_4")).length;

  assert.equal(harness.queries.length, 1);
  assert.equal(joined, 1_000);
  console.log(
    `Socket reconnect simulation: connections=1000, shared lookups=1, preview joins=${joined}, elapsed=${elapsedMs.toFixed(2)}ms`,
  );
});

test("leave and disconnect prevent an in-flight lookup from creating stale room membership", async () => {
  const harness = createHarness({ lookupDelayMs: 10 });
  const socket = createSocket("one");
  await connectSocket(harness, socket);
  const joining = socket.events["join-bus"]("4");
  socket.events["leave-bus"]("4");
  await joining;
  assert.equal(socket.rooms.has("preview_4"), false);

  const lateJoin = socket.events["join-bus"]("5");
  socket.connected = false;
  socket.events.disconnect();
  socket.rooms.clear();
  await lateJoin;
  assert.equal(socket.rooms.has("preview_5"), false);
  assert.equal(socket.rooms.has("user_student-one"), false);
});

test("leave during an asynchronous adapter join removes the late room addition", async () => {
  const harness = createHarness();
  const socket = createSocket("one");
  await connectSocket(harness, socket);
  let releaseJoin;
  let notifyJoinStarted;
  const joinStarted = new Promise((resolve) => {
    notifyJoinStarted = resolve;
  });
  socket.join = async (room) => {
    if (room === "preview_4") {
      notifyJoinStarted();
      await new Promise((resolve) => {
        releaseJoin = resolve;
      });
    }
    socket.rooms.add(room);
  };

  const joining = socket.events["join-bus"]("4");
  await joinStarted;
  await socket.events["leave-bus"]("4");
  releaseJoin();
  await joining;
  assert.equal(socket.rooms.has("preview_4"), false);
});

test("inactive preview buses cannot be joined", async () => {
  const harness = createHarness({ active: false });
  const socket = createSocket("one");
  await connectSocket(harness, socket);
  await socket.events["join-bus"]("inactive");
  assert.equal(socket.rooms.has("preview_inactive"), false);
  assert.equal(harness.queries.length, 1);
});

test("location request rate limiting remains capped at 30 requests per minute per socket", async () => {
  const ioHandlers = {};
  let busReads = 0;
  let locationReads = 0;
  const io = { on: (event, handler) => (ioHandlers[event] = handler) };
  const BusModel = {
    findOne(filter) {
      busReads++;
      return {
        select() {
          return this;
        },
        lean: async () =>
          filter.bus_no
            ? { _id: "bus-1", bus_no: "BUS-4", preview_number: "4" }
            : null,
      };
    },
  };
  const BusLiveLocationModel = {
    findOne() {
      locationReads++;
      return {
        select() {
          return this;
        },
        lean: async () => null,
      };
    },
  };
  registerTrackSocketHandlers({ io, BusModel, BusLiveLocationModel });
  const socket = createSocket("rate-limited");
  ioHandlers.connection(socket);

  for (let request = 0; request < 31; request++) {
    await socket.events["request-bus-location"]("BUS-4");
  }

  assert.equal(busReads, 30);
  assert.equal(locationReads, 30);
  assert.equal(socket.emissions.length, 31);
  assert.equal(socket.emissions[30].event, "locationUpdate");
  assert.equal(socket.emissions[30].payload.error, "Too many location requests");
});
