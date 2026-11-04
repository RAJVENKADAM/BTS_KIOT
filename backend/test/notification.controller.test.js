const assert = require("node:assert/strict");
const test = require("node:test");
const Notification = require("../src/models/Notification");
const { getNotifications } = require("../src/controllers/notification.controller");

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

test("notification feed projects response fields and fetches unread count concurrently", async () => {
  const originalFind = Notification.find;
  const originalCountDocuments = Notification.countDocuments;
  const userId = "64a000000000000000000001";
  const record = {
    _id: "notification-1",
    type: "bus_reassigned",
    message: "Your bus assignment changed.",
    old_preview: "4",
    new_preview: "9",
    is_bus_active: true,
    read_at: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
  const calls = [];
  let releaseFind;
  let releaseCount;
  const findGate = new Promise((resolve) => {
    releaseFind = resolve;
  });
  const countGate = new Promise((resolve) => {
    releaseCount = resolve;
  });
  let projection;
  let filter;
  let sort;
  let limit;

  Notification.find = (query) => {
    filter = query;
    return {
      select(fields) {
        projection = fields;
        return this;
      },
      sort(value) {
        sort = value;
        return this;
      },
      limit(value) {
        limit = value;
        return {
          lean: async () => {
            calls.push("find");
            await findGate;
            return [record];
          },
        };
      },
    };
  };
  Notification.countDocuments = async (query) => {
    calls.push("count");
    releaseFind();
    assert.deepEqual(query, { user_id: userId, read_at: null });
    await countGate;
    return 3;
  };

  try {
    const response = createResponse();
    const request = getNotifications({ user: { id: userId } }, response);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(new Set(calls), new Set(["count", "find"]));
    releaseCount();
    await request;

    assert.deepEqual(filter, { user_id: userId });
    assert.equal(
      projection,
      "_id type message old_preview new_preview is_bus_active read_at createdAt",
    );
    assert.deepEqual(sort, { createdAt: -1 });
    assert.equal(limit, 50);
    assert.equal(response.payload.unreadCount, 3);
    assert.deepEqual(response.payload.notifications[0], {
      id: record._id,
      type: record.type,
      message: record.message,
      oldPreview: record.old_preview,
      newPreview: record.new_preview,
      isBusActive: record.is_bus_active,
      read: false,
      createdAt: record.createdAt,
    });
  } finally {
    Notification.find = originalFind;
    Notification.countDocuments = originalCountDocuments;
  }
});
