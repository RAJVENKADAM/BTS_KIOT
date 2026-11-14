# BTS Final Engineering Release Report

**Generated:** 2026-11-14
**Project:** `RAJVENKADAM/BTS_KIOT`
**Release verdict:** **READY FOR CONTROLLED MANUAL USER TESTING** — automated and isolated replica-set gates passed. This is not a production deployment, a real-GPS confirmation, or a load/capacity certification.
**Git status:** release commit pushed to `main` and verified against `origin/main`; this report was finalized in a follow-up documentation-only commit.

## Summary

The final pass retires two unsafe legacy import paths, preserves the supported durable user/route import flows, hardens Excel-upload deactivation, closes a concurrent last-superadmin mutation race, verifies transaction and index behavior against a disposable local MongoDB replica set, and documents index deployment, scaling, and the controlled pilot.

No production or staging database, provider, Render service, or external integration was contacted. The known real GPS device remains inactive. Manual KIOT testing, deployment, and representative load testing have not been performed.

## Work completed and files changed

The reviewed release change set contains **91 files**: 67 backend, 20 frontend, and 4 release-documentation files. It includes import ledgers and mutation guards, assignment propagation and socket authorization changes, regression/integration tests, frontend retry/state handling, and release guidance.

Key implementation and verification files:

- [importUsers.controller.js](../../backend/src/controllers/importUsers.controller.js), [importBusRoutes.controller.js](../../backend/src/controllers/importBusRoutes.controller.js), [importLedger.js](../../backend/src/services/importLedger.js), [ImportOperation.js](../../backend/src/models/ImportOperation.js), [ImportRow.js](../../backend/src/models/ImportRow.js)
- [excelManagement.controller.js](../../backend/src/controllers/excelManagement.controller.js), [superadminAccess.js](../../backend/src/services/superadminAccess.js), [superadminUser.controller.js](../../backend/src/controllers/superadminUser.controller.js)
- [trackSocket.js](../../backend/src/socket/trackSocket.js), [studentBusAssignment.js](../../backend/src/services/studentBusAssignment.js), [gpsSyncWorker.js](../../backend/src/workers/gpsSyncWorker.js)
- [import-replica.integration.test.js](../../backend/test/import-replica.integration.test.js), [superadminUser.controller.test.js](../../backend/test/superadminUser.controller.test.js)
- [MONGODB_INDEX_DEPLOYMENT.md](./MONGODB_INDEX_DEPLOYMENT.md), [FUTURE_SCALING_GUIDE.md](./FUTURE_SCALING_GUIDE.md), [KIOT_CONTROLLED_MANUAL_TEST_CHECKLIST.md](./KIOT_CONTROLLED_MANUAL_TEST_CHECKLIST.md)

The modified production GPS ownership provisioner and its test, plus their `.bak` backups, were preserved but excluded from the release change set. The production provisioner was not run. No dependency manifest was changed.

## Import endpoint and bulk-mutation inventory

| Operation | Status and controls |
|---|---|
| `POST /api/superadmin/import-users` | Supported JSON user import; superadmin-only, durable upload/row identity, content-hash idempotency, conditional row claims and resource/assignment revision checks, transactional user/audit/outbox/row completion, owner-restricted status. |
| `POST /api/superadmin/import-users-excel` | Supported workbook user import through the same durable user import path; superadmin-only. |
| `POST /api/bus/import-routes` | Supported bus-route workbook import; superadmin-only, idempotent, revision-checked, transactional route and assignment propagation. |
| `POST /api/stops/coordinates/import` | Retired with HTTP 410 (`STOP_COORDINATE_IMPORT_RETIRED`); no coordinate writes occur. Download remains available. |
| `PUT /api/excel-management/:id` | Retired with HTTP 410; the metadata-only re-upload path and corresponding frontend action were removed. |
| Legacy `POST /api/superadmin/upload-excel-users` and `POST /api/bus/upload-bus-routes` | Retired with HTTP 410; callers are directed to supported import endpoints. |
| `POST /api/bus/combine-bus/:busNo` | Workbook-backed bus alteration, not a bulk import-ledger endpoint; guarded by the bus mutation revision/idempotency and transactional assignment-propagation path. |
| Excel-upload `DELETE /api/excel-management/:id` | Soft-deactivation only; requires idempotency key and expected revision; conditionally deactivates the upload and active linked users, records audit/outbox state transactionally, protects the acting/last active superadmin, and revokes sessions after commit. Repeats and stale revisions are handled safely. |
| Other bulk user/plan/route changes | Superadmin/admin role checks are route-scoped; supported mutations use revision checks and the applicable idempotency, transaction, audit/outbox, and socket-reconciliation behavior. |

Focused tests cover retired paths, repeated/stale deactivation, idempotency, and last-superadmin preservation. The transactional superadmin recheck is serialized through the shared MongoDB configuration transaction barrier, preventing concurrent conflicting demotions/deletions from each relying on an earlier count.

## Security and authorization

- Student bus REST reads and socket rooms are constrained to the authoritative assignment; assignment changes reconcile rooms and clear prior-bus location state before presenting the new assignment.
- Admin and superadmin actions remain role-restricted. Import status is restricted to its authorized owner.
- Mutation idempotency, stable content hashes, expected resource/assignment revisions, conditional database writes, and transaction boundaries protect supported bulk updates.
- Errors are normalized for clients; changed code avoids exposing raw database/stack details. Logs use safe error summaries.
- A scan of staged paths found no `.env`, private-key, or credential-named files. A high-confidence credential-pattern scan of the staged diff had zero matches. Two existing `.bak` files remain unstaged and uncommitted.

## MongoDB indexes and replica-set evidence

- MongoDB Server **8.3.7**, local replica set `bts-import-test`, loopback-only `127.0.0.1:27018`, disposable database `bts_release_gate_f17a6c2d`.
- The isolated integration command exited **0**: **11 passed, 0 failed, 0 skipped**. It covered transaction commit/rollback, conditional revision conflicts, unique-index duplicate rejection, concurrent row claims, durable idempotency/content conflict, user assignment import, upload deactivation/last-admin protection, concurrent superadmin role changes, controlled interruption/recovery, GPS configuration fencing, notification retry, and outbox lease loss/reacquisition.
- **28 model-declared indexes across 14 collections** were created/checked only in the disposable test database. Unique-index duplicate behavior was tested. The deployment guide documents names/keys, purpose, uniqueness, preflight, reviewed `createIndex`, `getIndexes()`, `explain("executionStats")`, and rollback guidance.
- `autoIndex` behavior is unchanged. No Atlas, staging, or production index migration was attempted. The recovery test uses a controlled pre-commit fault; it is not an operating-system process-kill test.

See [MONGODB_INDEX_DEPLOYMENT.md](./MONGODB_INDEX_DEPLOYMENT.md) for the exact isolated setup and safe deployment procedure.

## Automated validation evidence

| Check | Result |
|---|---|
| Backend `npm test` | Exit **0**; **502 tests, 501 passed, 0 failed, 1 skipped**. The replica-set-only test is skipped by the default command and was run separately above. |
| Targeted superadmin user mutation tests | Exit **0**; **11 passed, 0 failed, 0 skipped**. Includes regression coverage for transactional last-superadmin rechecks. |
| Frontend `npm test` | Exit **0**; **74 passed, 0 failed, 0 skipped**. |
| Expo Android production JS export | Exit **0**; Android bundle and metadata exported successfully. Export output was removed after verification. |
| Staged backend/frontend JavaScript syntax | **81 existing staged `.js` files** checked; **0 syntax failures**. |
| Git hygiene | Staged and unstaged `git diff --check` both exit **0**. No dependency manifest changes. |
| Replica-set transaction/index gate | Exit **0**; details above. |

No application-level performance benchmark or capacity claim is made. Structural optimizations include bounded/projected reads and pagination where relevant, indexed query paths, chunked durable imports, duplicate request suppression, selective frontend state updates, bounded snapshot retry/polling, listener cleanup, and reuse of the configured MongoDB connection. The effect on production latency has not been measured.

## GPS safety verification

The existing worker/provider safeguards were preserved: approximately 35-second polling, 10-second provider timeout, three-minute default stale threshold, five-minute future-timestamp rejection, duplicate/out-of-order rejection, provider timestamp preservation, ownership lease/fencing, durable publication markers, retry/coalescing, and shutdown/ownership checks.

Controlled automated tests cover freshness/order, worker ownership, configuration fencing, and publication/outbox recovery. No provider request was made and no real device was activated. The known device is inactive; therefore this release does not establish live GPS operation.

## Infrastructure and future scaling

**Stage 1:** one backend instance, existing MongoDB/provider, no Docker or new paid service requirement, bounded workers, validated environment configuration, reused database connection, graceful failure and shutdown. A single instance remains a single compute/failure domain.

**Stage 2:** measure baseline first; then right-size Render resources, Atlas tier/storage/IOPS/connection capacity and per-process pool limits. Add instances only after shared Socket.IO transport and rate-limit state are configured and tested. Redis is not needed for the current single-instance mode; it becomes necessary for cross-instance Socket.IO room/event coordination and shared rate limiting. Separate GPS/background workers only when measurement and an ownership/fencing design justify it. Add monitoring, alerting, backup/restore drills, and representative staged load tests before rollout.

No 10,000-user capacity is claimed. See [FUTURE_SCALING_GUIDE.md](./FUTURE_SCALING_GUIDE.md).

## Controlled manual testing and release boundaries

The checklist is prepared for an initial controlled pilot of **2–3 administrators and 10–20 opted-in students**, with synthetic/staging data, assignment and bus changes, mapping, socket reconnect/revocation, unavailable GPS, imports/retries, low-network behavior, login/session stability, and Android responsiveness.

- Automated tests: **completed**, with counts above.
- Isolated replica-set integration: **completed**, 11/11 passed.
- Manual KIOT/admin/student pilot: **not performed**.
- Real-device GPS verification: **not performed; device remains inactive**.
- Staging/production deployment or production database/index verification: **not performed**.
- Representative load/capacity test, OS-level process-kill recovery test, and browser/device end-to-end pilot: **not performed**.

Do not treat this report as manual sign-off or production readiness. Complete [KIOT_CONTROLLED_MANUAL_TEST_CHECKLIST.md](./KIOT_CONTROLLED_MANUAL_TEST_CHECKLIST.md) before the pilot.

## GitHub release record

- Branch: `main`.
- Configured remote: `https://github.com/RAJVENKADAM/BTS_KIOT.git` (confirmed as the intended repository).
- Before commit, local `main` and `origin/main` were equal at `58ab1162ca89b9eafd62f034fe5fcf59dde0ecde`.
- Release commit: `480c15bec85ab395ebf9b765faf09db4ba9b7dc8`.
- Push result: **success**; GitHub `origin/main` was fetched and confirmed at the release commit hash before this report-only follow-up.

The release payload was committed and pushed without force. The follow-up documentation commit records this verified result; excluded user changes remain outside both commits.
