"use strict";

const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const {
  buildUserRevisionFilter,
  revisionCondition,
  updateUserWithRevision,
} = require("../src/services/userRevision");
const User = require("../src/models/User");
const {
  runIdempotentMutation,
  getMutationHeaders,
  stableStringify,
} = require("../src/services/mutationIdempotency");
const MutationIdempotency = require("../src/models/MutationIdempotency");
const { mockMutationIdempotency } = require("./helpers/mutationIdempotencyMock.cjs");
const mutationIdempotency = mockMutationIdempotency();
after(() => mutationIdempotency.restore());

test("user revision filters atomically compare legacy and current resource versions", () => {
  assert.deepEqual(revisionCondition("resourceVersion", 0), {
    $or: [{ resourceVersion: 0 }, { resourceVersion: { $exists: false } }],
  });
  assert.deepEqual(
    buildUserRevisionFilter({
      userId: "user-1",
      expectedResourceVersion: 4,
      expectedAssignmentRevision: 2,
    }),
    {
      $and: [
        { _id: "user-1" },
        { resourceVersion: 4 },
        { assignmentRevision: 2 },
      ],
    },
  );
});

test("mutation headers require a stable key and nonnegative expected version", () => {
  assert.deepEqual(
    getMutationHeaders({
      headers: { "idempotency-key": "request-123" },
      body: { expectedVersion: 0 },
    }),
    { idempotencyKey: "request-123", expectedVersion: 0 },
  );
  assert.throws(
    () => getMutationHeaders({ headers: {}, body: {} }),
    (error) => error.statusCode === 400 && error.code === "IDEMPOTENCY_KEY_REQUIRED",
  );
  assert.throws(
    () =>
      getMutationHeaders({
        headers: { "idempotency-key": "request-123" },
        body: {},
      }),
    (error) => error.statusCode === 428 && error.code === "RESOURCE_VERSION_REQUIRED",
  );
});

test("canonical mutation payload hashes do not depend on object key order", () => {
  assert.equal(
    stableStringify({ update: { name: "Student", role: "student" } }),
    stableStringify({ update: { role: "student", name: "Student" } }),
  );
});

test("user writes use one conditional update and atomically increment resource revisions", async () => {
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  let captured;
  User.findOneAndUpdate = (filter, update, options) => {
    captured = { filter, update, options };
    const query = {
      select() {
        return this;
      },
      then(resolve, reject) {
        return Promise.resolve({
          _id: "user-1",
          resourceVersion: 5,
          assignmentRevision: 3,
        }).then(resolve, reject);
      },
    };
    return query;
  };
  try {
    const result = await updateUserWithRevision({
      userId: "user-1",
      expectedResourceVersion: 4,
      expectedAssignmentRevision: 2,
      update: { $set: { bus_no: "BUS-2" } },
    });
    assert.equal(result.resourceVersion, 5);
    assert.deepEqual(captured.filter, {
      $and: [
        { _id: "user-1" },
        { resourceVersion: 4 },
        { assignmentRevision: 2 },
      ],
    });
    assert.deepEqual(captured.update, {
      $set: { bus_no: "BUS-2" },
      $inc: { resourceVersion: 1, assignmentRevision: 1 },
    });
    assert.equal(captured.options.new, true);
  } finally {
    User.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("profile writes increment resourceVersion without changing assignmentRevision", async () => {
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  let captured;
  User.findOneAndUpdate = (filter, update) => {
    captured = { filter, update };
    return Promise.resolve({
      resourceVersion: 8,
      assignmentRevision: 3,
    });
  };
  try {
    const result = await updateUserWithRevision({
      userId: "user-2",
      expectedResourceVersion: 7,
      update: { $set: { name: "Changed name" } },
    });
    assert.equal(result.assignmentRevision, 3);
    assert.deepEqual(captured.update.$inc, { resourceVersion: 1 });
    assert.deepEqual(captured.filter, {
      $and: [
        { _id: "user-2" },
        { resourceVersion: 7 },
      ],
    });
  } finally {
    User.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("concurrent stale user writes allow only one conditional update", async () => {
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  const state = { name: "Before", resourceVersion: 0, assignmentRevision: 0 };
  const capturedFilters = [];
  User.findOneAndUpdate = (filter, update) => {
    capturedFilters.push(filter);
    const expectedResourceVersion = filter.$and.find(
      (condition) => condition.resourceVersion !== undefined || condition.$or,
    );
    const matches =
      expectedResourceVersion?.resourceVersion === state.resourceVersion ||
      expectedResourceVersion?.$or?.some(
        (option) =>
          option.resourceVersion === state.resourceVersion ||
          (option.resourceVersion?.$exists === false &&
            state.resourceVersion === undefined),
      );
    if (!matches) return Promise.resolve(null);
    Object.assign(state, update.$set);
    for (const [field, amount] of Object.entries(update.$inc || {})) {
      state[field] = (state[field] || 0) + amount;
    }
    return Promise.resolve({ ...state });
  };
  try {
    const writes = await Promise.all([
      updateUserWithRevision({
        userId: "user-3",
        expectedResourceVersion: 0,
        update: { $set: { name: "First" } },
      }),
      updateUserWithRevision({
        userId: "user-3",
        expectedResourceVersion: 0,
        update: { $set: { name: "Second" } },
      }),
    ]);
    assert.equal(writes.filter(Boolean).length, 1);
    assert.equal(state.resourceVersion, 1);
    assert.equal(capturedFilters.length, 2);
  } finally {
    User.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("idempotent mutation replays results and serializes concurrent duplicate requests", async () => {
  let mutationCalls = 0;
  let enterMutation;
  let releaseMutation;
  const entered = new Promise((resolve) => {
    enterMutation = resolve;
  });
  const mutationGate = new Promise((resolve) => {
    releaseMutation = resolve;
  });
  const base = {
    scope: "test-concurrent-resource",
    idempotencyKey: "request-key-456",
    request: { value: "first" },
    expectedVersion: 4,
    barrier: async (operation) => operation(null),
    mutate: async () => {
      mutationCalls += 1;
      enterMutation();
      await mutationGate;
      return {
        response: { success: true, value: mutationCalls },
        resourceVersion: 5,
      };
    },
  };

  const firstPromise = runIdempotentMutation(base);
  await entered;
  const duplicatePromise = runIdempotentMutation(base);
  await assert.rejects(
    runIdempotentMutation({ ...base, request: { value: "different" } }),
    (error) =>
      error.statusCode === 409 && error.code === "IDEMPOTENCY_KEY_CONFLICT",
  );
  releaseMutation();
  const [first, duplicate] = await Promise.all([firstPromise, duplicatePromise]);

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.response, first.response);
  assert.equal(mutationCalls, 1);
  const replay = await runIdempotentMutation({
    ...base,
    mutate: async () => {
      mutationCalls += 1;
      return null;
    },
  });
  assert.equal(replay.duplicate, true);
  assert.equal(mutationCalls, 1);
});

test("idempotency reservation rolls back with a failed transaction", async () => {
  const originalFindById = MutationIdempotency.findById;
  const originalCreate = MutationIdempotency.create;
  const originalUpdateOne = MutationIdempotency.updateOne;
  const committed = new Map();
  MutationIdempotency.findById = (id) => {
    let session;
    return {
      session(value) {
        session = value;
        return this;
      },
      lean: async () =>
        session?.pending.get(String(id)) || committed.get(String(id)) || null,
    };
  };
  MutationIdempotency.create = async (documents, options = {}) => {
    const record = documents[0];
    const destination = options.session?.pending || committed;
    if (destination.has(String(record._id)) || committed.has(String(record._id))) {
      const error = new Error("duplicate key");
      error.code = 11000;
      throw error;
    }
    destination.set(String(record._id), record);
    return [record];
  };
  MutationIdempotency.updateOne = async (filter, update, options = {}) => {
    const record = options.session?.pending.get(String(filter._id));
    if (!record || record.request_hash !== filter.request_hash) {
      return { matchedCount: 0 };
    }
    Object.assign(record, update.$set);
    return { matchedCount: 1 };
  };
  const barrier = async (operation) => {
    const session = { pending: new Map() };
    const result = await operation(session);
    for (const [id, record] of session.pending) committed.set(id, record);
    return result;
  };
  const request = {
    scope: "transactional-mutation",
    idempotencyKey: "rollback-key-001",
    request: { value: "write" },
    barrier,
  };
  try {
    await assert.rejects(
      runIdempotentMutation({
        ...request,
        mutate: async () => {
          throw new Error("business mutation failed");
        },
      }),
      /business mutation failed/,
    );
    assert.equal(committed.size, 0);

    const result = await runIdempotentMutation({
      ...request,
      mutate: async () => ({ response: { success: true } }),
    });
    assert.equal(result.duplicate, false);
    assert.equal(committed.size, 1);
    assert.deepEqual([...committed.values()][0].response, { success: true });
  } finally {
    MutationIdempotency.findById = originalFindById;
    MutationIdempotency.create = originalCreate;
    MutationIdempotency.updateOne = originalUpdateOne;
  }
});
