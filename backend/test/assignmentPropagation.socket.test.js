"use strict";

const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const AppSetting = require("../src/models/AppSetting");
const AssignmentPropagationOutbox = require("../src/models/AssignmentPropagationOutbox");
const Bus = require("../src/models/Bus");
const BusLiveLocation = require("../src/models/BusLiveLocation");
const BusRoute = require("../src/models/BusRoute");
const GpsWorkerOwnership = require("../src/models/GpsWorkerOwnership");
const Notification = require("../src/models/Notification");
const StopMaster = require("../src/models/StopMaster");
const User = require("../src/models/User");
const { createAssignmentPropagationWorker } = require("../src/services/assignmentPropagation");
const { setIO } = require("../src/socket");

const originals = {
  appSettingFindOne: AppSetting.findOne,
  busFind: Bus.find,
  busFindOne: Bus.findOne,
  busLiveLocationFindOne: BusLiveLocation.findOne,
  busRouteFind: BusRoute.find,
  gpsOwnershipFindById: GpsWorkerOwnership.findById,
  notificationBulkWrite: Notification.bulkWrite,
  stopMasterFind: StopMaster.find,
  userFind: User.find,
};

after(() => {
  AppSetting.findOne = originals.appSettingFindOne;
  Bus.find = originals.busFind;
  Bus.findOne = originals.busFindOne;
  BusLiveLocation.findOne = originals.busLiveLocationFindOne;
  BusRoute.find = originals.busRouteFind;
  GpsWorkerOwnership.findById = originals.gpsOwnershipFindById;
  Notification.bulkWrite = originals.notificationBulkWrite;
  StopMaster.find = originals.stopMasterFind;
  User.find = originals.userFind;
  setIO(null);
});

test("outbox replay moves a connected student to the current authorized bus room", async () => {
  const userId = "64a000000000000000000001";
  const user = {
    _id: userId,
    role: "student",
    is_active: true,
    deleted_by_user: false,
    bus_no: "BUS-2",
  };
  const bus = {
    _id: "bus-new",
    bus_no: "BUS-2",
    preview_number: "2",
    status: "active",
    altered_to_bus_id: null,
  };
  const socketEvents = [];
  const socket = {
    user: { id: userId, role: "student" },
    rooms: new Set([`user_${userId}`, "assigned_bus_old", "preview_4"]),
    async leave(room) {
      this.rooms.delete(room);
    },
    async join(room) {
      this.rooms.add(room);
    },
    emit(event, payload) {
      socketEvents.push({ event, payload });
    },
    disconnect() {
      throw new Error("The current student assignment should remain authorized.");
    },
  };
  const operator = {
    to() {
      return this;
    },
    async fetchSockets() {
      return [socket];
    },
  };

  AppSetting.findOne = () => ({ lean: async () => ({ value: "PLAN A" }) });
  GpsWorkerOwnership.findById = () => ({
    select() {
      return this;
    },
    lean: async () => ({ configVersion: 4 }),
  });
  User.find = () => ({
    select() {
      return this;
    },
    lean: async () => [user],
  });
  Bus.findOne = () => ({
    select() {
      return this;
    },
    lean: async () => bus,
  });
  Bus.find = () => ({
    select() {
      return this;
    },
    sort() {
      return this;
    },
    lean: async () => [],
  });
  BusLiveLocation.findOne = () => ({
    select() {
      return this;
    },
    lean: async () => null,
  });
  BusRoute.find = () => ({
    select() {
      return this;
    },
    sort() {
      return this;
    },
    lean: async () => [],
  });
  StopMaster.find = () => ({
    select() {
      return this;
    },
    lean: async () => [],
  });
  Notification.bulkWrite = async () => ({ upsertedCount: 1 });
  setIO({ to: operator.to.bind(operator) });

  const job = {
    _id: "mutation-1",
    status: "pending",
    cursor: 0,
    attempts: 0,
    recipients: [{
      user_id: userId,
      notification: {
        type: "bus_reassigned",
        message: "Your bus assignment changed to Bus BUS-2.",
        old_bus_no: "BUS-1",
        new_bus_no: "BUS-2",
      },
    }],
    next_attempt_at: new Date(0),
  };
  const outboxModel = {
    findOneAndUpdate(_filter, update) {
      job.status = update.$set.status;
      job.lease_owner = update.$set.lease_owner;
      job.lease_expires_at = update.$set.lease_expires_at;
      job.attempts += update.$inc.attempts;
      return { lean: async () => structuredClone(job) };
    },
    async updateOne(_filter, update) {
      Object.assign(job, update.$set);
      return { modifiedCount: 1 };
    },
  };
  const worker = createAssignmentPropagationWorker({
    workerId: "socket-test-worker",
    outboxModel,
    notificationModel: Notification,
    resolveAssignments: async (ids) =>
      new Map(ids.map((id) => [
        id,
        {
          assignmentStatus: "assigned",
          effectiveBus: { bus_no: "BUS-2", preview_number: "2" },
        },
      ])),
    logger: { error() {} },
  });

  assert.equal(await worker.processOne(), true);
  assert.equal(job.status, "completed");
  assert.equal(socket.rooms.has("assigned_bus_old"), false);
  assert.equal(socket.rooms.has("preview_4"), false);
  assert.equal(socket.rooms.has("assigned_bus_bus-new"), true);
  assert.equal(socketEvents.length, 1);
  assert.equal(socketEvents[0].event, "assigned-bus-update");
  assert.equal(socketEvents[0].payload.busNo, "2");
  assert.equal(socketEvents[0].payload.previewNumber, "2");
  assert.equal(socketEvents[0].payload.gpsStatus, "unavailable");
  assert.equal(socketEvents[0].payload.latitude, null);
  assert.equal(socketEvents[0].payload.longitude, null);

  job.status = "pending";
  job.cursor = 0;
  job.next_attempt_at = new Date(0);
  assert.equal(await worker.processOne(), true);
  assert.equal(socket.rooms.has("assigned_bus_old"), false);
  assert.equal(socket.rooms.has("assigned_bus_bus-new"), true);
  assert.equal(socketEvents.length, 2);
  assert.equal(socketEvents[1].event, "assigned-bus-update");
  assert.equal(socketEvents[1].payload.assignmentVersion, socketEvents[0].payload.assignmentVersion);
});
