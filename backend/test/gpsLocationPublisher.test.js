"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createGpsLocationPublisher } = require("../src/services/gpsLocationPublisher");

function createModel(overrides = {}) {
  const record = {
    _id: "bus-live-1",
    publicationPending: true,
    publicationRooms: ["assigned_bus_bus-live-1", "preview_4"],
    publicationPreviewNumber: "4",
    publicationClaimId: null,
    publicationClaimUntil: null,
    publicationNextAttemptAt: null,
    publicationAttempts: 0,
    publicationRetryExhausted: false,
    locationVersion: 1n,
    publishedVersion: 0n,
    latitude: 11.55,
    longitude: 78.02,
    speed: 20,
    is_online: true,
    source: "gps",
    providerTimestamp: new Date("2026-11-07T08:00:00Z"),
    lastSuccessfulGpsUpdate: new Date("2026-11-07T08:00:01Z"),
    updatedAt: new Date("2026-11-07T08:00:01Z"),
    ...overrides,
  };
  let failNextPublishedMark = false;
  const copyRecord = () => ({
    ...record,
    publicationRooms: [...record.publicationRooms],
  });

  return {
    record,
    failNextPublishedMark() {
      failNextPublishedMark = true;
    },
    async findOneAndUpdate(filter, pipeline) {
      const now = Date.now();
      if (
        filter.publicationPending !== true ||
        !record.publicationPending ||
        (filter.publicationRetryExhausted?.$ne === true &&
          record.publicationRetryExhausted) ||
        (record.publicationClaimUntil &&
          record.publicationClaimUntil.getTime() > now) ||
        (record.publicationNextAttemptAt &&
          record.publicationNextAttemptAt.getTime() > now)
      ) {
        return null;
      }

      const update = pipeline[0].$set;
      record.publicationClaimId = update.publicationClaimId;
      record.publicationClaimUntil = new Date(
        now + update.publicationClaimUntil.$dateAdd.amount,
      );
      record.publicationAttempts += 1;
      return copyRecord();
    },
    async updateOne(filter, pipeline) {
      if (
        String(filter._id) !== String(record._id) ||
        filter.publicationClaimId !== record.publicationClaimId ||
        !(record.publicationClaimUntil instanceof Date) ||
        record.publicationClaimUntil.getTime() <= Date.now()
      ) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      const update = pipeline[0].$set;
      if (Object.hasOwn(update, "publishedVersion")) {
        if (failNextPublishedMark) {
          failNextPublishedMark = false;
          throw new Error("simulated acknowledgement-state failure");
        }
        const publishedVersion = BigInt(update.publishedVersion.$max[1]);
        if (publishedVersion > record.publishedVersion) {
          record.publishedVersion = publishedVersion;
        }
        record.publicationPending = record.locationVersion > publishedVersion;
        record.publicationClaimId = null;
        record.publicationClaimUntil = null;
        record.publicationNextAttemptAt = null;
        record.publicationAttempts = 0;
        record.publicationRetryExhausted =
          update.publicationRetryExhausted;
        record.publicationLastErrorCode = null;
        return { matchedCount: 1, modifiedCount: 1 };
      }
      record.publicationPending = true;
      record.publicationClaimId = null;
      record.publicationClaimUntil = null;
      record.publicationRetryExhausted =
        update.publicationRetryExhausted;
      const delayMs = update.publicationNextAttemptAt?.$dateAdd?.amount;
      record.publicationNextAttemptAt = delayMs
        ? new Date(Date.now() + delayMs)
        : null;
      record.publicationLastErrorCode = update.publicationLastErrorCode;
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async updateMany(filter, pipeline) {
      if (
        filter.publicationPending === true &&
        record.publicationPending &&
        (filter.publicationRetryExhausted !== true ||
          record.publicationRetryExhausted)
      ) {
        record.publicationRetryExhausted =
          pipeline[0].$set.publicationRetryExhausted;
        record.publicationAttempts = 0;
        record.publicationNextAttemptAt = null;
        return { matchedCount: 1, modifiedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    },
  };
}

function createSocket(emit) {
  return {
    to() {
      return this;
    },
    emit,
  };
}

test("committed location publication retries failures with the same stable event ID", async () => {
  const model = createModel();
  const received = [];
  let shouldFail = true;
  const publisher = createGpsLocationPublisher({
    model,
    socketGetter: () =>
      createSocket((event, payload) => {
        received.push({ event, payload });
        if (shouldFail) {
          shouldFail = false;
          throw new Error("transport unavailable");
        }
      }),
    batchSize: 1,
    retryBaseMs: 0,
  });

  await publisher.drain();
  assert.equal(model.record.publicationPending, true);
  assert.equal(model.record.publishedVersion, 0n);
  assert.equal(model.record.publicationAttempts, 1);

  await publisher.drain();
  assert.equal(model.record.publicationPending, false);
  assert.equal(model.record.publishedVersion, 1n);
  assert.equal(received.length, 2);
  assert.equal(received[0].event, "locationUpdate");
  assert.equal(received[0].payload.eventId, received[1].payload.eventId);
  assert.equal(received[0].payload.locationVersion, "1");
});

test("duplicate publication after uncertain acknowledgement reuses its idempotency key", async () => {
  const model = createModel();
  model.failNextPublishedMark();
  const received = [];
  const publisher = createGpsLocationPublisher({
    model,
    socketGetter: () =>
      createSocket((event, payload) => received.push({ event, payload })),
    batchSize: 1,
    retryBaseMs: 0,
  });

  await publisher.drain();
  assert.equal(model.record.publicationPending, true);
  await publisher.drain();

  assert.equal(received.length, 2);
  assert.equal(received[0].payload.eventId, received[1].payload.eventId);
  assert.equal(model.record.publicationPending, false);
});

test("concurrent dispatchers atomically claim one pending location", async () => {
  const model = createModel();
  const received = [];
  const makePublisher = () =>
    createGpsLocationPublisher({
      model,
      socketGetter: () =>
        createSocket((event, payload) => received.push(payload.eventId)),
      batchSize: 1,
    });

  await Promise.all([makePublisher().drain(), makePublisher().drain()]);

  assert.deepEqual(received, ["bus-live-1:1"]);
  assert.equal(model.record.publishedVersion, 1n);
});

test("a newer committed location remains pending if it arrives during publication", async () => {
  const model = createModel();
  const received = [];
  const publisher = createGpsLocationPublisher({
    model,
    socketGetter: () =>
      createSocket((event, payload) => {
        received.push(payload);
        if (payload.locationVersion === "1") {
          model.record.locationVersion = 2n;
          model.record.latitude = 11.56;
          model.record.publicationPending = true;
        }
      }),
    batchSize: 2,
  });

  await publisher.drain();

  assert.deepEqual(
    received.map((payload) => payload.locationVersion),
    ["1", "2"],
  );
  assert.equal(model.record.publishedVersion, 2n);
  assert.equal(model.record.publicationPending, false);
});

test("publisher defers without claiming while the shared transport is unavailable", async () => {
  const model = createModel();
  const publisher = createGpsLocationPublisher({
    model,
    socketGetter: () => createSocket(() => assert.fail("must not publish")),
    transportReady: () => false,
  });

  const result = await publisher.drain();

  assert.equal(result.deferred, true);
  assert.equal(model.record.publicationAttempts, 0);
  assert.equal(model.record.publicationPending, true);
});

test("asynchronous Redis publication failure keeps the durable marker pending", async () => {
  const model = createModel();
  const eventIds = [];
  const publisher = createGpsLocationPublisher({
    model,
    socketGetter: () => createSocket(() => {}),
    publishEvent: async (_rooms, _event, payload) => {
      eventIds.push(payload.eventId);
      throw new Error("Redis publish failed asynchronously");
    },
    retryBaseMs: 0,
  });

  await publisher.drain();

  assert.equal(model.record.publicationPending, true);
  assert.equal(model.record.publishedVersion, 0n);
  assert.equal(model.record.publicationLastErrorCode, "Error");
  assert.equal(eventIds[0], "bus-live-1:1");
});

test("Redis disconnect during publication defers until reconnect recovery", async () => {
  const model = createModel();
  let ready = true;
  let generation = 1;
  let publicationAttempts = 0;
  const publisher = createGpsLocationPublisher({
    model,
    socketGetter: () => createSocket(() => {}),
    transportReady: () => ready,
    transportGeneration: () => generation,
    publishEvent: async () => {
      publicationAttempts += 1;
      if (publicationAttempts === 1) {
        ready = false;
        throw new Error("Redis disconnected during publish");
      }
      if (!ready) throw new Error("Redis remains disconnected");
      return { brokerAccepted: true };
    },
    retryBaseMs: 1_000,
  });

  await publisher.drain();
  const deferred = await publisher.drain();
  assert.equal(deferred.deferred, true);
  assert.equal(model.record.publicationPending, true);
  assert.equal(model.record.publishedVersion, 0n);

  ready = true;
  generation += 1;
  await publisher.drain();
  assert.equal(model.record.publicationPending, false);
  assert.equal(model.record.publicationNextAttemptAt, null);
  assert.equal(model.record.publishedVersion, 1n);
  assert.equal(publicationAttempts, 2);
});

test("a dispatcher crash after emit is recovered after its claim lease expires", async () => {
  const model = createModel();
  const eventIds = [];
  const originalUpdateOne = model.updateOne;
  let crashBeforeAcknowledgement = 2;
  model.updateOne = async (...args) => {
    if (crashBeforeAcknowledgement > 0) {
      crashBeforeAcknowledgement -= 1;
      throw new Error("simulated dispatcher crash before acknowledgement");
    }
    return originalUpdateOne(...args);
  };
  const createPublisher = () =>
    createGpsLocationPublisher({
      model,
      socketGetter: () => createSocket(() => {}),
      publishEvent: async (_rooms, _event, payload) => {
        eventIds.push(payload.eventId);
        return { brokerAccepted: true };
      },
      claimTtlMs: 30_000,
      retryBaseMs: 0,
    });

  await assert.rejects(createPublisher().drain(), /simulated dispatcher crash/);
  model.record.publicationClaimUntil = new Date(Date.now() - 1);
  await createPublisher().drain();

  assert.deepEqual(eventIds, ["bus-live-1:1", "bus-live-1:1"]);
  assert.equal(model.record.publishedVersion, 1n);
  assert.equal(model.record.publicationPending, false);
});

test("retry attempts are capped and reconnect clears the parked retry state", async () => {
  const model = createModel();
  let generation = 1;
  let publicationAttempts = 0;
  const publisher = createGpsLocationPublisher({
    model,
    socketGetter: () => createSocket(() => {}),
    transportGeneration: () => generation,
    maxRetryAttempts: 2,
    retryBaseMs: 0,
    publishEvent: async () => {
      publicationAttempts += 1;
      if (generation === 1) throw new Error("Redis unavailable");
      return { brokerAccepted: true };
    },
  });

  await publisher.drain();
  await publisher.drain();
  assert.equal(model.record.publicationRetryExhausted, true);
  const failedAttempts = model.record.publicationAttempts;
  for (let index = 0; index < 4; index += 1) {
    await publisher.drain();
  }
  assert.equal(model.record.publicationAttempts, failedAttempts);
  assert.equal(model.record.publicationPending, true);

  generation += 1;
  await publisher.drain();
  assert.equal(model.record.publicationRetryExhausted, false);
  assert.equal(model.record.publicationAttempts, 0);
  assert.equal(model.record.publishedVersion, 1n);
  assert.equal(model.record.publicationPending, false);
  assert.equal(publicationAttempts, 3);
});

test("superseded claim holders cannot acknowledge after another dispatcher takes over", async () => {
  const model = createModel();
  const firstPublishStarted = new Promise((resolve) => {
    model.signalFirstPublish = resolve;
  });
  let releaseFirstPublish;
  const firstPublishGate = new Promise((resolve) => {
    releaseFirstPublish = resolve;
  });
  let publishCount = 0;
  let claimCount = 0;
  const makePublisher = () =>
    createGpsLocationPublisher({
      model,
      socketGetter: () => createSocket(() => {}),
      claimTtlMs: 30_000,
      claimIdFactory: () => `claim-${++claimCount}`,
      publishEvent: async (_rooms, _event, payload) => {
        publishCount += 1;
        if (publishCount === 1) {
          model.signalFirstPublish(payload.eventId);
          await firstPublishGate;
        }
        return { brokerAccepted: true };
      },
    });

  const firstDrain = makePublisher().drain();
  await firstPublishStarted;
  model.record.publicationClaimUntil = new Date(Date.now() - 1);
  await makePublisher().drain();
  releaseFirstPublish();
  await firstDrain;

  assert.equal(model.record.publicationPending, false);
  assert.equal(model.record.publishedVersion, 1n);
  assert.equal(publishCount, 2);
});
