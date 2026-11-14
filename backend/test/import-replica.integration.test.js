"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const mongoose = require("mongoose");
const { Long } = require("mongodb");
const AdministrativeChangeAudit = require("../src/models/AdministrativeChangeAudit");
const AssignmentPropagationOutbox = require("../src/models/AssignmentPropagationOutbox");
const AssignmentPropagationReplay = require("../src/models/AssignmentPropagationReplay");
const Bus = require("../src/models/Bus");
const BusChange = require("../src/models/BusChange");
const BusLiveLocation = require("../src/models/BusLiveLocation");
const BusRoute = require("../src/models/BusRoute");
const ExcelUpload = require("../src/models/ExcelUpload");
const GpsWorkerOwnership = require("../src/models/GpsWorkerOwnership");
const ImportOperation = require("../src/models/ImportOperation");
const ImportRow = require("../src/models/ImportRow");
const MutationIdempotency = require("../src/models/MutationIdempotency");
const Notification = require("../src/models/Notification");
const PlanMapping = require("../src/models/PlanMapping");
const PlanMappingAudit = require("../src/models/PlanMappingAudit");
const User = require("../src/models/User");
const { importUsers } = require("../src/controllers/importUsers.controller");
const { deleteExcelUpload } = require("../src/controllers/excelManagement.controller");
const { updateUsersRole } = require("../src/controllers/superadminUser.controller");
const importLedger = require("../src/services/importLedger");
const mutationIdempotency = require("../src/services/mutationIdempotency");
const {
  createAssignmentPropagationWorker,
} = require("../src/services/assignmentPropagation");

const replicaUri = process.env.BTS_REPLICA_TEST_URI;

function testResponse() {
  return {
    statusCode: null,
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

function importRequest({ actorId, key, rows }) {
  return {
    user: { id: actorId },
    body: { users: rows },
    headers: { "idempotency-key": key },
  };
}

function deleteUploadRequest({ actorId, uploadId, key, expectedVersion = 0 }) {
  const headers = { "idempotency-key": key };
  return {
    params: { id: String(uploadId) },
    user: { id: String(actorId) },
    body: { expectedVersion },
    headers,
    get(name) {
      return headers[name.toLowerCase()];
    },
  };
}

function makeUserRow(email, busno) {
  return {
    name: "Synthetic Replica Test",
    email,
    role: "student",
    busno,
    mobile_no: "5550000000",
    date_of_year: 2005,
  };
}

async function transactionBarrier(operation) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction({
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
      readPreference: "primary",
    });
    const result = await operation(session);
    await session.commitTransaction();
    return result;
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }
}

async function seedGpsOwnership() {
  await GpsWorkerOwnership.collection.insertOne({
    _id: "gps-worker",
    token: Long.fromInt(0),
    ownerId: null,
    state: "inactive",
    leaseExpiresAt: new Date(0),
    writeVersion: Long.fromInt(0),
    configVersion: Long.fromInt(0),
    updatedAt: new Date(),
  });
}

test("isolated MongoDB replica-set import and recovery integration", async (t) => {
  if (!replicaUri) {
    t.skip("Set BTS_REPLICA_TEST_URI to run the isolated local replica-set suite.");
    return;
  }
  const parsedUri = new URL(replicaUri);
  assert.ok(
    ["127.0.0.1", "localhost", "::1"].includes(parsedUri.hostname),
    "Replica integration URI must be loopback-only.",
  );
  assert.equal(parsedUri.port, "27018", "Use the dedicated test replica port.");
  assert.equal(parsedUri.searchParams.get("replicaSet"), "bts-import-test");
  assert.match(parsedUri.pathname, /^\/bts_release_gate_[a-f0-9-]+$/);

  await mongoose.connect(replicaUri, { autoIndex: false, serverSelectionTimeoutMS: 5000 });
  const db = mongoose.connection.db;
  try {
    const hello = await db.admin().command({ hello: 1 });
    assert.equal(hello.setName, "bts-import-test");
    assert.equal(hello.isWritablePrimary, true);

    await seedGpsOwnership();

    await t.test("transaction commit, rollback, and revision CAS", async () => {
      const collection = db.collection("release_gate_mutations");
      const committedId = `committed-${randomUUID()}`;
      await transactionBarrier(async (session) => {
        await collection.insertOne({ _id: committedId, value: "committed" }, { session });
      });
      assert.equal(await collection.countDocuments({ _id: committedId }), 1);

      const rolledBackId = `rollback-${randomUUID()}`;
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        await collection.insertOne({ _id: rolledBackId }, { session });
        await session.abortTransaction();
      } finally {
        await session.endSession();
      }
      assert.equal(await collection.countDocuments({ _id: rolledBackId }), 0);

      const revisionId = `revision-${randomUUID()}`;
      await collection.insertOne({ _id: revisionId, revision: 0 });
      const writes = await Promise.all([
        collection.updateOne(
          { _id: revisionId, revision: 0 },
          { $inc: { revision: 1 } },
        ),
        collection.updateOne(
          { _id: revisionId, revision: 0 },
          { $inc: { revision: 1 } },
        ),
      ]);
      assert.equal(writes.reduce((sum, result) => sum + result.matchedCount, 0), 1);
      assert.equal((await collection.findOne({ _id: revisionId })).revision, 1);
    });

    await t.test("unique import indexes, idempotency conflict, and concurrent row claims", async () => {
      const indexedModels = [
        User,
        Bus,
        BusRoute,
        PlanMapping,
        BusChange,
        BusLiveLocation,
        Notification,
        ExcelUpload,
        AssignmentPropagationOutbox,
        AssignmentPropagationReplay,
        AdministrativeChangeAudit,
        PlanMappingAudit,
        ImportOperation,
        ImportRow,
      ];
      let expectedIndexes = 0;
      for (const model of indexedModels) {
        for (const [keys, options] of model.schema.indexes()) {
          await model.collection.createIndex(keys, options);
          expectedIndexes += 1;
        }
      }
      let verifiedIndexes = 0;
      for (const model of indexedModels) {
        const installed = await model.collection.listIndexes().toArray();
        for (const [keys, options] of model.schema.indexes()) {
          assert.ok(
            installed.some((index) =>
              JSON.stringify(index.key) === JSON.stringify(keys) &&
              Boolean(index.unique) === Boolean(options.unique) &&
              Boolean(index.sparse) === Boolean(options.sparse)),
            `Missing index on ${model.collection.collectionName}: ${JSON.stringify(keys)}`,
          );
          verifiedIndexes += 1;
        }
      }
      assert.equal(verifiedIndexes, expectedIndexes);
      await ImportOperation.collection.createIndex(
        { actor_id: 1, import_type: 1, idempotency_key: 1 },
        { unique: true, name: "import_actor_type_key_unique" },
      );
      await ImportOperation.collection.createIndex(
        { status: 1, updatedAt: 1 },
        { name: "status_1_updatedAt_1" },
      );
      await ImportRow.collection.createIndex(
        { operation_id: 1, row_number: 1 },
        { unique: true, name: "import_row_number_unique" },
      );
      await ImportRow.collection.createIndex(
        { operation_id: 1, status: 1, claim_until: 1, row_number: 1 },
        { name: "import_row_claim" },
      );
      const operationIndexes = await ImportOperation.collection.listIndexes().toArray();
      const rowIndexes = await ImportRow.collection.listIndexes().toArray();
      assert.ok(operationIndexes.some((index) => index.name === "import_actor_type_key_unique"));
      assert.ok(rowIndexes.some((index) => index.name === "import_row_number_unique"));

      const actorId = new mongoose.Types.ObjectId();
      const key = `integration-${randomUUID()}`;
      const input = {
        email: `replica-${randomUUID()}@example.test`,
        bus_no: "BUS-TEST",
      };
      const staged = await importLedger.createOrResumeImport({
        actorId,
        importType: "users",
        idempotencyKey: key,
        content: { rows: [input] },
        rows: [{
          rowNumber: 1,
          identity: input.email,
          expectedVersion: null,
          expectedVersionCaptured: true,
          input,
        }],
      });
      await assert.rejects(
        ImportOperation.collection.insertOne({
          _id: `duplicate-${randomUUID()}`,
          actor_id: actorId,
          import_type: "users",
          idempotency_key: key,
          content_hash: "different",
          status: "processing",
        }),
        { code: 11000 },
      );
      const replay = await importLedger.createOrResumeImport({
        actorId,
        importType: "users",
        idempotencyKey: key,
        content: { rows: [input] },
        rows: [{
          rowNumber: 1,
          identity: input.email,
          expectedVersion: null,
          expectedVersionCaptured: true,
          input,
        }],
      });
      assert.equal(replay.uploadId, staged.uploadId);
      await assert.rejects(
        importLedger.createOrResumeImport({
          actorId,
          importType: "users",
          idempotencyKey: key,
          content: { rows: [{ ...input, bus_no: "BUS-CHANGED" }] },
          rows: [],
        }),
        { statusCode: 409 },
      );

      const claimResults = await Promise.all([
        importLedger.claimNextRow(staged.uploadId, "replica-worker-a"),
        importLedger.claimNextRow(staged.uploadId, "replica-worker-b"),
      ]);
      assert.equal(claimResults.filter(Boolean).length, 1);
      const claim = claimResults.find(Boolean);
      const rowDocument = await ImportRow.findById(claim._id).lean();
      assert.equal(rowDocument.status, "processing");
      await importLedger.failClaimedRow({
        uploadId: staged.uploadId,
        claimedRowId: claim._id,
        owner: claim.claim_owner,
        category: "simulated-interruption",
        message: "Synthetic failure before transaction commit.",
        retryable: true,
      });
      const retryClaim = await importLedger.claimNextRow(
        staged.uploadId,
        "replica-worker-restart",
      );
      assert.ok(retryClaim);
      assert.equal(retryClaim.attempt_count, 2);

      const transaction = await mongoose.startSession();
      const businessId = `import-row-${randomUUID()}`;
      try {
        transaction.startTransaction();
        await db.collection("release_gate_import_business").insertOne(
          { _id: businessId },
          { session: transaction },
        );
        await importLedger.completeClaimedRow({
          uploadId: staged.uploadId,
          rowId: retryClaim._id,
          owner: "replica-worker-restart",
          session: transaction,
          resultResourceId: businessId,
          result: { status: "done" },
        });
        await transaction.abortTransaction();
      } finally {
        await transaction.endSession();
      }
      assert.equal(
        await db.collection("release_gate_import_business").countDocuments({ _id: businessId }),
        0,
      );
      assert.equal(
        (await ImportRow.findById(retryClaim._id).lean()).status,
        "processing",
      );
      assert.equal(
        (await ImportOperation.findById(staged.uploadId).lean()).completed_rows,
        0,
      );

      await ImportRow.updateOne(
        { _id: retryClaim._id, status: "processing" },
        { $set: { claim_until: new Date(0) } },
      );
      const recoveredClaim = await importLedger.claimNextRow(
        staged.uploadId,
        "replica-worker-recovery",
      );
      assert.ok(recoveredClaim);
      const recoverySession = await mongoose.startSession();
      try {
        recoverySession.startTransaction();
        await db.collection("release_gate_import_business").insertOne(
          { _id: businessId },
          { session: recoverySession },
        );
        await importLedger.completeClaimedRow({
          uploadId: staged.uploadId,
          rowId: recoveredClaim._id,
          owner: "replica-worker-recovery",
          session: recoverySession,
          resultResourceId: businessId,
          result: { status: "done" },
        });
        await recoverySession.commitTransaction();
      } catch (error) {
        if (recoverySession.inTransaction()) await recoverySession.abortTransaction();
        throw error;
      } finally {
        await recoverySession.endSession();
      }
      await importLedger.finalizeImport(staged.uploadId, { success: true });
      assert.equal(
        (await ImportRow.findById(recoveredClaim._id).lean()).status,
        "completed",
      );
      assert.equal(
        (await ImportOperation.findById(staged.uploadId).lean()).completed_rows,
        1,
      );
    });

    await t.test("real user assignment import commits once and key replay is durable", async () => {
      await User.collection.createIndex(
        { email: 1 },
        { unique: true, name: "email_1" },
      );
      const actorId = new mongoose.Types.ObjectId().toString();
      const key = `user-import-${randomUUID()}`;
      const email = `assignment-${randomUUID()}@example.test`;
      const row = makeUserRow(email, "BUS-REAL-TEST");
      const first = testResponse();
      await importUsers(importRequest({ actorId, key, rows: [row] }), first);
      assert.equal(first.statusCode, 200);
      assert.equal(first.payload.summary.insertedRows, 1);
      const user = await User.findOne({ email }).lean();
      assert.ok(user);
      assert.equal(user.assignmentRevision, 0);
      const userCount = await User.countDocuments({ email });
      const auditCount = await AdministrativeChangeAudit.countDocuments({
        action: "spreadsheet-user-created",
        resource_id: String(user._id),
      });
      const outboxCount = await AssignmentPropagationOutbox.countDocuments({
        operation: "spreadsheet-user-created",
      });

      const replay = testResponse();
      await importUsers(importRequest({ actorId, key, rows: [row] }), replay);
      assert.equal(replay.statusCode, 200);
      assert.equal(replay.payload.duplicate, true);
      assert.equal(await User.countDocuments({ email }), userCount);
      assert.equal(
        await AdministrativeChangeAudit.countDocuments({
          action: "spreadsheet-user-created",
          resource_id: String(user._id),
        }),
        auditCount,
      );
      assert.equal(
        await AssignmentPropagationOutbox.countDocuments({
          operation: "spreadsheet-user-created",
        }),
        outboxCount,
      );
      await assert.rejects(
        importLedger.createOrResumeImport({
          actorId,
          importType: "users",
          idempotencyKey: key,
          content: { rows: [{ ...row, busno: "BUS-CHANGED" }] },
          rows: [],
        }),
        { statusCode: 409 },
      );
    });

    await t.test("Excel upload deactivation commits transactionally and rejects stale repeats", async () => {
      const actorId = new mongoose.Types.ObjectId();
      const upload = await ExcelUpload.create({
        file_name: "synthetic-users.xlsx",
        uploaded_by: actorId,
        is_active: true,
        revision: 0,
      });
      const userId = new mongoose.Types.ObjectId();
      await User.collection.insertOne({
        _id: userId,
        name: "Synthetic Upload Student",
        email: `upload-${randomUUID()}@example.test`,
        password_hash: "synthetic-hash",
        role: "student",
        bus_no: "BUS-UPLOAD",
        resourceVersion: 3,
        assignmentRevision: 4,
        is_active: true,
        deleted_by_user: false,
        excel_upload_id: upload._id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const key = `delete-upload-${randomUUID()}`;
      const first = testResponse();
      await deleteExcelUpload(
        deleteUploadRequest({ actorId, uploadId: upload._id, key }),
        first,
      );
      assert.equal(first.statusCode, 200);
      assert.equal(first.payload.deactivatedUsers, 1);
      const deactivatedUpload = await ExcelUpload.findById(upload._id).lean();
      assert.equal(deactivatedUpload.is_active, false);
      assert.equal(deactivatedUpload.revision, 1);
      const user = await User.findById(userId).lean();
      assert.equal(user.is_active, false);
      assert.equal(user.deleted_by_user, true);
      assert.equal(user.resourceVersion, 4);
      assert.equal(user.assignmentRevision, 5);
      assert.equal(
        await AdministrativeChangeAudit.countDocuments({
          action: "spreadsheet-users-deactivated",
          resource_id: String(upload._id),
        }),
        1,
      );
      assert.equal(
        await AssignmentPropagationOutbox.countDocuments({
          operation: "spreadsheet-users-deactivated",
          recipients: { $elemMatch: { user_id: userId } },
        }),
        1,
      );

      const replay = testResponse();
      await deleteExcelUpload(
        deleteUploadRequest({ actorId, uploadId: upload._id, key }),
        replay,
      );
      assert.equal(replay.statusCode, 200);
      assert.equal(replay.payload.duplicate, true);
      assert.equal(
        await AdministrativeChangeAudit.countDocuments({
          action: "spreadsheet-users-deactivated",
          resource_id: String(upload._id),
        }),
        1,
      );
      const conflict = testResponse();
      await deleteExcelUpload(
        deleteUploadRequest({
          actorId,
          uploadId: upload._id,
          key: `delete-upload-conflict-${randomUUID()}`,
        }),
        conflict,
      );
      assert.equal(conflict.statusCode, 409);
    });

    await t.test("Excel upload deactivation preserves the last active superadmin", async () => {
      const actorId = new mongoose.Types.ObjectId();
      const upload = await ExcelUpload.create({
        file_name: "synthetic-superadmin.xlsx",
        uploaded_by: actorId,
        is_active: true,
        revision: 0,
      });
      const linkedSuperadminId = new mongoose.Types.ObjectId();
      await User.collection.insertOne({
        _id: linkedSuperadminId,
        name: "Synthetic Sole Superadmin",
        email: `superadmin-${randomUUID()}@example.test`,
        password_hash: "synthetic-hash",
        role: "superadmin",
        is_active: true,
        deleted_by_user: false,
        excel_upload_id: upload._id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const response = testResponse();
      await deleteExcelUpload(
        deleteUploadRequest({
          actorId,
          uploadId: upload._id,
          key: `protect-superadmin-${randomUUID()}`,
        }),
        response,
      );
      assert.equal(response.statusCode, 409);
      assert.equal(response.payload.code, "SUPERADMIN_ACCESS_PROTECTED");
      assert.equal((await ExcelUpload.findById(upload._id).lean()).is_active, true);
      assert.equal((await User.findById(linkedSuperadminId).lean()).is_active, true);
      assert.equal(
        await AdministrativeChangeAudit.countDocuments({
          action: "spreadsheet-users-deactivated",
          resource_id: String(upload._id),
        }),
        0,
      );
    });

    await t.test("concurrent role changes cannot remove the last active superadmin", async () => {
      let activeAdmins = await User.find({
        role: "superadmin",
        is_active: { $ne: false },
      }).select("_id").lean();
      const additionalAdmins = Math.max(0, 2 - activeAdmins.length);
      if (additionalAdmins) {
        await User.collection.insertMany(
          Array.from({ length: additionalAdmins }, (_, index) => ({
            _id: new mongoose.Types.ObjectId(),
            name: `Synthetic Concurrent Superadmin ${index + 1}`,
            email: `concurrent-superadmin-${randomUUID()}@example.test`,
            password_hash: "synthetic-hash",
            role: "superadmin",
            is_active: true,
            resourceVersion: 0,
            assignmentRevision: 0,
          })),
        );
        activeAdmins = await User.find({
          role: "superadmin",
          is_active: { $ne: false },
        }).select("_id").lean();
      }
      const actorId = new mongoose.Types.ObjectId().toString();
      const changeRole = async (targetId) => {
        const headers = { "idempotency-key": `role-change-${randomUUID()}` };
        const response = testResponse();
        await updateUsersRole(
          {
            headers,
            body: {
              ids: [String(targetId)],
              role: "primary_admin",
              expectedVersions: { [String(targetId)]: 0 },
              expectedAssignmentRevisions: { [String(targetId)]: 0 },
            },
            user: { id: actorId },
            get(name) {
              return headers[name.toLowerCase()];
            },
          },
          response,
        );
        return response;
      };

      const results = await Promise.all(
        activeAdmins.map((admin) => changeRole(admin._id)),
      );
      assert.deepEqual(
        results.map((response) => response.statusCode).sort(),
        [...Array(activeAdmins.length - 1).fill(200), 409].sort(),
      );
      assert.equal(
        await User.countDocuments({
          role: "superadmin",
          is_active: { $ne: false },
        }),
        1,
      );
    });

    await t.test("existing assignment changes are revision-guarded and transactionally audited", async () => {
      const actorId = new mongoose.Types.ObjectId().toString();
      const key = `assignment-update-${randomUUID()}`;
      const email = `existing-${randomUUID()}@example.test`;
      const existingId = new mongoose.Types.ObjectId();
      await User.collection.insertOne({
        _id: existingId,
        name: "Synthetic Existing Student",
        email,
        password_hash: "synthetic-hash",
        role: "student",
        bus_no: "BUS-OLD",
        resourceVersion: 4,
        assignmentRevision: 7,
        is_active: true,
        deleted_by_user: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const response = testResponse();
      await importUsers(
        importRequest({
          actorId,
          key,
          rows: [makeUserRow(email, "BUS-NEW")],
        }),
        response,
      );
      assert.equal(response.statusCode, 200);
      const updated = await User.findById(existingId).lean();
      assert.equal(updated.bus_no, "BUS-NEW");
      assert.equal(updated.resourceVersion, 5);
      assert.equal(updated.assignmentRevision, 8);
      assert.equal(
        await AdministrativeChangeAudit.countDocuments({
          action: "spreadsheet-assignment-updated",
          resource_id: String(existingId),
          "previous_state.assignment_revision": 7,
          "new_state.assignment_revision": 8,
        }),
        1,
      );
      assert.equal(
        await AssignmentPropagationOutbox.countDocuments({
          operation: "spreadsheet-assignment-updated",
          recipients: { $elemMatch: { user_id: String(existingId) } },
        }),
        1,
      );
    });

    await t.test("failed import transaction rolls back and the same key recovers", async () => {
      const assignmentPropagation = require("../src/services/assignmentPropagation");
      const originalRecordMutation = assignmentPropagation.recordAssignmentMutation;
      const actorId = new mongoose.Types.ObjectId().toString();
      const key = `recover-import-${randomUUID()}`;
      const email = `recover-${randomUUID()}@example.test`;
      const rows = [makeUserRow(email, "BUS-RECOVERY")];
      const priorAuditCount = await AdministrativeChangeAudit.countDocuments({
        action: "spreadsheet-user-created",
      });
      const configBefore = await GpsWorkerOwnership.collection.findOne(
        { _id: "gps-worker" },
        { promoteLongs: false },
      );
      assignmentPropagation.recordAssignmentMutation = async (input) => {
        await originalRecordMutation(input);
        throw new Error("Synthetic process interruption before transaction commit.");
      };
      try {
        const interrupted = testResponse();
        await importUsers(importRequest({ actorId, key, rows }), interrupted);
        assert.equal(interrupted.statusCode, 500);
        assert.equal(await User.countDocuments({ email }), 0);
        assert.equal(
          await AdministrativeChangeAudit.countDocuments({
            action: "spreadsheet-user-created",
          }),
          priorAuditCount,
        );
        const configAfterAbort = await GpsWorkerOwnership.collection.findOne(
          { _id: "gps-worker" },
          { promoteLongs: false },
        );
        assert.equal(
          configAfterAbort.configVersion.toString(),
          configBefore.configVersion.toString(),
        );
      } finally {
        assignmentPropagation.recordAssignmentMutation = originalRecordMutation;
      }

      const recovered = testResponse();
      await importUsers(importRequest({ actorId, key, rows }), recovered);
      assert.equal(recovered.statusCode, 200);
      assert.equal(await User.countDocuments({ email }), 1);
      assert.equal(
        (await ImportRow.findOne({
          operation_id: recovered.payload.uploadId,
          row_number: 1,
        }).lean()).status,
        "completed",
      );
      const configAfterCommit = await GpsWorkerOwnership.collection.findOne(
        { _id: "gps-worker" },
        { promoteLongs: false },
      );
      assert.ok(
        configAfterCommit.configVersion.greaterThan(configBefore.configVersion),
      );
    });

    await t.test("outbox checkpoint retry is idempotent and expired leases can be reacquired", async () => {
      const userId = new mongoose.Types.ObjectId();
      const notifyId = `outbox-duplicate-${randomUUID()}`;
      await AssignmentPropagationOutbox.create({
        _id: notifyId,
        operation: "integration-notification",
        recipients: [{
          user_id: userId,
          notification: {
            type: "bus_reassigned",
            message: "Synthetic assignment update.",
            new_bus_no: "BUS-OUTBOX",
          },
        }],
        cursor: 0,
        status: "pending",
        attempts: 0,
        max_attempts: 10,
        next_attempt_at: new Date(0),
      });
      let failedCheckpoint = false;
      let activeJobId = notifyId;
      const outboxModel = {
        findOneAndUpdate: (filter, ...args) =>
          AssignmentPropagationOutbox.findOneAndUpdate(
            { ...filter, _id: activeJobId },
            ...args,
          ),
        updateOne: async (filter, update) => {
          if (Object.hasOwn(filter, "cursor") && !failedCheckpoint) {
            failedCheckpoint = true;
            throw new Error("Synthetic crash after notification persistence.");
          }
          return AssignmentPropagationOutbox.updateOne(filter, update);
        },
      };
      const worker = createAssignmentPropagationWorker({
        workerId: `worker-${randomUUID()}`,
        outboxModel,
        notificationModel: Notification,
        replayModel: require("../src/models/AssignmentPropagationReplay"),
        reconcile: async () => {},
        resolveAssignments: async (ids) =>
          new Map(ids.map((id) => [id, {
            assignmentStatus: "assigned",
            effectiveBus: { bus_no: "BUS-OUTBOX" },
          }])),
        logger: { error() {}, warn() {} },
      });
      assert.equal(await worker.processOne(), true);
      let job = await AssignmentPropagationOutbox.findById(notifyId).lean();
      assert.equal(job.status, "pending");
      await AssignmentPropagationOutbox.updateOne(
        { _id: notifyId },
        { $set: { next_attempt_at: new Date(0) } },
      );
      assert.equal(await worker.processOne(), true);
      job = await AssignmentPropagationOutbox.findById(notifyId).lean();
      assert.equal(job.status, "completed");
      assert.equal(
        await Notification.countDocuments({
          user_id: userId,
          message: "Synthetic assignment update.",
        }),
        1,
      );

      const leaseId = `outbox-lease-${randomUUID()}`;
      activeJobId = leaseId;
      await AssignmentPropagationOutbox.create({
        _id: leaseId,
        operation: "integration-lease",
        recipients: [{ user_id: userId, notification: null }],
        cursor: 0,
        status: "pending",
        attempts: 0,
        max_attempts: 10,
        next_attempt_at: new Date(0),
      });
      let enterReconcile;
      let releaseReconcile;
      const entered = new Promise((resolve) => { enterReconcile = resolve; });
      const blocked = new Promise((resolve) => { releaseReconcile = resolve; });
      const intervalCallbacks = [];
      const firstWorker = createAssignmentPropagationWorker({
        workerId: "lease-worker-one",
        outboxModel: {
          findOneAndUpdate: (filter, ...args) =>
            AssignmentPropagationOutbox.findOneAndUpdate(
              { ...filter, _id: leaseId },
              ...args,
            ),
          updateOne: (...args) => AssignmentPropagationOutbox.updateOne(...args),
        },
        reconcile: async () => {
          enterReconcile();
          await blocked;
        },
        resolveAssignments: async () => new Map(),
        leaseMs: 10000,
        leaseRenewIntervalMs: 5000,
        setIntervalFn: (callback) => {
          intervalCallbacks.push(callback);
          return { unref() {} };
        },
        clearIntervalFn() {},
        logger: { error() {}, warn() {} },
      });
      const firstRun = firstWorker.processOne();
      await entered;
      await AssignmentPropagationOutbox.updateOne(
        { _id: leaseId, status: "processing", lease_owner: "lease-worker-one" },
        {
          $set: {
            lease_owner: "lease-worker-two",
            lease_expires_at: new Date(Date.now() - 1),
          },
        },
      );
      intervalCallbacks[0]();
      await new Promise((resolve) => setTimeout(resolve, 20));
      releaseReconcile();
      await firstRun;
      job = await AssignmentPropagationOutbox.findById(leaseId).lean();
      assert.equal(job.status, "processing");
      assert.equal(job.lease_owner, "lease-worker-two");

      const secondWorker = createAssignmentPropagationWorker({
        workerId: "lease-worker-two",
        outboxModel: {
          findOneAndUpdate: (filter, ...args) =>
            AssignmentPropagationOutbox.findOneAndUpdate(
              { ...filter, _id: leaseId },
              ...args,
            ),
          updateOne: (...args) => AssignmentPropagationOutbox.updateOne(...args),
        },
        reconcile: async () => {},
        resolveAssignments: async () => new Map(),
        logger: { error() {}, warn() {} },
      });
      assert.equal(await secondWorker.processOne(), true);
      job = await AssignmentPropagationOutbox.findById(leaseId).lean();
      assert.equal(job.status, "completed");
    });

    await t.test("mutation idempotency stores results and rejects a changed request", async () => {
      const scope = `replica-mutation-${randomUUID()}`;
      const key = `mutation-key-${randomUUID()}`;
      let calls = 0;
      const first = await mutationIdempotency.runIdempotentMutation({
        scope,
        idempotencyKey: key,
        actorId: new mongoose.Types.ObjectId(),
        request: { value: 1 },
        expectedVersion: 0,
        barrier: transactionBarrier,
        mutate: async (session) => {
          calls += 1;
          await MutationIdempotency.collection.insertOne(
            { _id: `mutation-side-effect-${randomUUID()}`, value: 1 },
            { session },
          );
          return {
            response: { success: true, value: 1 },
            resourceVersion: 1,
          };
        },
      });
      const replay = await mutationIdempotency.runIdempotentMutation({
        scope,
        idempotencyKey: key,
        actorId: new mongoose.Types.ObjectId(),
        request: { value: 1 },
        expectedVersion: 0,
        barrier: transactionBarrier,
        mutate: async () => {
          calls += 1;
        },
      });
      assert.equal(first.duplicate, false);
      assert.equal(replay.duplicate, true);
      assert.equal(calls, 1);
      await assert.rejects(
        mutationIdempotency.runIdempotentMutation({
          scope,
          idempotencyKey: key,
          request: { value: 2 },
          expectedVersion: 0,
          barrier: transactionBarrier,
          mutate: async () => {},
        }),
        { statusCode: 409 },
      );
    });
  } finally {
    await mongoose.disconnect();
  }
});
