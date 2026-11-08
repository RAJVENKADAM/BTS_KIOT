const assert = require("node:assert/strict");
const { test } = require("node:test");
const Bus = require("../src/models/Bus");
const BusChange = require("../src/models/BusChange");
const User = require("../src/models/User");
const { getTemporaryBusChanges } = require("../src/controllers/bus.controller");

function responseDouble() {
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

function queryDouble(records, callbacks = {}) {
  return {
    select(fields) {
      callbacks.select?.(fields);
      return this;
    },
    sort(sort) {
      callbacks.sort?.(sort);
      return this;
    },
    limit(limit) {
      callbacks.limit?.(limit);
      return this;
    },
    lean: async () => records,
  };
}

test("temporary bus changes merge bounded streams and resume without duplicates", async () => {
  const originals = {
    busFind: Bus.find,
    changeFind: BusChange.find,
    distinct: BusChange.distinct,
    aggregate: User.aggregate,
  };
  const timestamp = new Date("2026-11-07T08:00:00.000Z");
  const recordedChange = {
    _id: "64a000000000000000000002",
    type: "combine",
    status: "active",
    sourceBusNo: "BUS-2",
    sourcePreview: "2",
    targetBusNo: "BUS-3",
    targetPreview: "3",
    routeSource: "target",
    affectedUsersCount: 2,
    createdAt: timestamp,
  };
  const legacyBus = {
    _id: "64a000000000000000000003",
    bus_no: "BUS-1",
    preview_number: "1",
    altered_to_bus_id: "64a000000000000000000099",
    altered_to_preview: "9",
    altered_at: timestamp,
  };
  const calls = { recorded: 0, legacy: 0, target: 0, aggregates: 0 };
  const queryLimits = [];

  BusChange.find = (filter) => {
    calls.recorded += 1;
    return queryDouble([recordedChange], {
      limit: (limit) => queryLimits.push(limit),
    });
  };
  BusChange.distinct = async () => [];
  Bus.find = (filter) => {
    if (filter.alteration_type) {
      calls.legacy += 1;
      return queryDouble(calls.legacy === 1 ? [legacyBus] : [], {
        limit: (limit) => queryLimits.push(limit),
      });
    }
    calls.target += 1;
    return queryDouble([
      { _id: legacyBus.altered_to_bus_id, bus_no: "BUS-9", preview_number: "9" },
    ]);
  };
  User.aggregate = async () => {
    calls.aggregates += 1;
    return [
      { _id: "BUS-1", count: 2 },
      { _id: "1", count: 1 },
    ];
  };

  try {
    const firstResponse = responseDouble();
    await getTemporaryBusChanges({ query: { limit: "1" } }, firstResponse);

    assert.equal(firstResponse.statusCode, 200);
    assert.equal(firstResponse.payload.changes.length, 1);
    assert.equal(firstResponse.payload.changes[0].legacy, true);
    assert.equal(firstResponse.payload.changes[0].affectedUsersCount, 3);
    assert.ok(firstResponse.payload.pagination.hasNextPage);
    assert.deepEqual(queryLimits, [2, 2]);
    assert.equal(calls.target, 1);
    assert.equal(calls.aggregates, 1);
    const cursorState = JSON.parse(
      Buffer.from(
        firstResponse.payload.pagination.nextCursor,
        "base64url",
      ).toString("utf8"),
    );
    assert.deepEqual(cursorState.recorded, { done: false });

    const secondResponse = responseDouble();
    await getTemporaryBusChanges(
      {
        query: {
          limit: "1",
          cursor: firstResponse.payload.pagination.nextCursor,
        },
      },
      secondResponse,
    );

    assert.equal(secondResponse.statusCode, 200);
    assert.equal(secondResponse.payload.changes.length, 1);
    assert.equal(secondResponse.payload.changes[0].legacy, false);
    assert.equal(secondResponse.payload.changes[0].id, recordedChange._id);
    assert.equal(secondResponse.payload.pagination.hasNextPage, false);
    assert.equal(calls.recorded, 2);
    assert.equal(calls.legacy, 1);
  } finally {
    Bus.find = originals.busFind;
    BusChange.find = originals.changeFind;
    BusChange.distinct = originals.distinct;
    User.aggregate = originals.aggregate;
  }
});

test("temporary bus changes reject malformed cursors before database reads", async () => {
  const originalFind = BusChange.find;
  BusChange.find = () => {
    throw new Error("Must not query changes for an invalid cursor.");
  };
  const response = responseDouble();

  try {
    await getTemporaryBusChanges({ query: { cursor: "invalid" } }, response);
    assert.equal(response.statusCode, 400);
    assert.equal(response.payload.success, false);
  } finally {
    BusChange.find = originalFind;
  }
});
