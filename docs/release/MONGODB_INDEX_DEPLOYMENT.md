# BTS MongoDB Index Deployment Notes

**Status:** model indexes have been created and verified in a disposable local MongoDB 8.3.7 replica-set database for this release. This is not evidence that staging or production indexes exist. `autoIndex` behavior is unchanged; do not run deployment commands against production until reviewed and tested on a recent staging copy.

## Important constraints

- Never enable automatic index creation in production as a shortcut.
- First record `db.getCollection("<collection>").getIndexes()` for every collection and compare it with this inventory.
- Run index creation in an approved maintenance window on an isolated staging deployment first; measure build duration, disk use, write impact, and query plans.
- Existing duplicate data can prevent unique index creation. The checks below report duplicates; do not delete, merge, or rewrite records automatically.
- Import-operation and import-row indexes are declared with `autoIndex: false`; their presence in an environment must be verified explicitly.
- User and Bus revision comparisons are by `_id` plus revision, so MongoDB's built-in unique `_id` index serves the conditional write filter. Creating separate indexes on revision fields alone is not useful for those single-resource writes.

## Declared model indexes

Confirm each index is present, including names/options, rather than assuming schema declarations were built.

| Collection | Exact key(s) / option | Main query |
|---|---|---|
| `users` | `{ email: 1 }`, unique (schema field) | Login, import lookup by normalized email |
| `users` | `{ role: 1, is_active: 1, bus_no: 1 }` | Active role/bus assignment lookups |
| `users` | `{ excel_upload_id: 1, is_active: 1, _id: 1 }` | Paginated users for an Excel upload |
| `buses` | `{ bus_no: 1 }`, unique (schema field) | Bus identity lookup |
| `buses` | `{ gps_device_id: 1 }`, unique (schema field) | Provider-device identity lookup |
| `buses` | `{ preview_number: 1 }`, unique and sparse | Preview identifier lookup |
| `buses` | `{ altered_to_bus_id: 1, alteration_type: 1 }` | Incoming alteration/combination links |
| `buses` | `{ alteration_type: 1, altered_at: -1, _id: -1 }` | Alteration history |
| `busroutes` | `{ bus_id: 1, plan_name: 1, stop_order: 1 }` | Ordered routes by bus and plan |
| `planmappings` | `{ plan_name: 1, root_bus_id: 1 }` | Mapping root lookup |
| `planmappings` | `{ plan_name: 1, member_bus_ids: 1 }` | Mapping membership lookup |
| `buschanges` | `{ status: 1, createdAt: -1, _id: -1 }` | Active/recent change lookup |
| `buschanges` | `{ type: 1 }` | Bus-change type filtering |
| `buslivelocations` | `{ bus_id: 1 }`, unique (schema field) | Current location by bus |
| `buslivelocations` | `{ publicationPending: 1, publicationRetryExhausted: 1, publicationNextAttemptAt: 1, publicationClaimUntil: 1, updatedAt: 1 }` | Pending publication claim/retry |
| `notifications` | `{ user_id: 1 }` (schema field index) | User notification lookup |
| `notifications` | `{ user_id: 1, createdAt: -1 }` | User notifications, newest first |
| `notifications` | `{ user_id: 1, read_at: 1, createdAt: -1 }` | Read/unread notification listing |
| `exceluploads` | `{ uploaded_by: 1, createdAt: -1 }` | Administrator upload history |
| `assignmentpropagationoutboxes` | `{ status: 1, next_attempt_at: 1, lease_expires_at: 1, createdAt: 1 }` | Pending jobs and expired leases |
| `assignmentpropagationoutboxes` | `{ replay_of: 1, status: 1 }` | Replay state |
| `assignmentpropagationreplays` | `{ original_job_id: 1, createdAt: -1 }` | Replay history |
| `administrativechangeaudits` | `{ createdAt: -1, action: 1 }` | Audit history |
| `planmappingaudits` | `{ createdAt: -1, _id: -1 }` | Mapping audit history |
| `importoperations` | `{ actor_id: 1, import_type: 1, idempotency_key: 1 }`, unique | One upload operation per actor/type/key |
| `importoperations` | `{ status: 1, updatedAt: 1 }` | Import status/recovery inspection |
| `importrows` | `{ operation_id: 1, row_number: 1 }`, unique | Stable row identity and row lookup |
| `importrows` | `{ operation_id: 1, status: 1, claim_until: 1, row_number: 1 }` | Ordered pending/expired row claims |

`MutationIdempotency` uses a deterministic string `_id`; MongoDB's mandatory `_id_` index provides unique mutation identity. There is no TTL or retention policy. Do not add a TTL index until a documented retention period and replay-support requirements are approved.

Mongoose's standard collection pluralization is shown above; verify actual collection names using `db.getCollectionNames()` before running commands.

## Preflight duplicate checks

Run read-only checks in staging first. A non-empty result blocks the corresponding unique index until the data owner resolves the duplicates under an approved procedure.

```javascript
db.users.aggregate([
  { $group: { _id: "$email", count: { $sum: 1 }, ids: { $push: "$_id" } } },
  { $match: { count: { $gt: 1 } } }
])

db.buses.aggregate([
  { $group: { _id: "$bus_no", count: { $sum: 1 }, ids: { $push: "$_id" } } },
  { $match: { count: { $gt: 1 } } }
])

db.buses.aggregate([
  { $group: { _id: "$gps_device_id", count: { $sum: 1 }, ids: { $push: "$_id" } } },
  { $match: { count: { $gt: 1 } } }
])

db.buses.aggregate([
  { $match: { preview_number: { $type: "string" } } },
  { $group: { _id: "$preview_number", count: { $sum: 1 }, ids: { $push: "$_id" } } },
  { $match: { count: { $gt: 1 } } }
])

db.buslivelocations.aggregate([
  { $group: { _id: "$bus_id", count: { $sum: 1 }, ids: { $push: "$_id" } } },
  { $match: { count: { $gt: 1 } } }
])

db.importoperations.aggregate([
  { $group: { _id: { actor_id: "$actor_id", import_type: "$import_type", idempotency_key: "$idempotency_key" }, count: { $sum: 1 }, ids: { $push: "$_id" } } },
  { $match: { count: { $gt: 1 } } }
])

db.importrows.aggregate([
  { $group: { _id: { operation_id: "$operation_id", row_number: "$row_number" }, count: { $sum: 1 }, ids: { $push: "$_id" } } },
  { $match: { count: { $gt: 1 } } }
])
```

Also check for missing/null values before unique-index creation. Existing schema-required constraints do not prove historical documents satisfy them.

## Reviewed staging creation commands

After confirming collection names and duplicate checks, these idempotent commands create missing declared indexes. `createIndex` does not replace a differently configured index; compare `getIndexes()` and resolve drift explicitly before applying.

```javascript
db.users.createIndex({ role: 1, is_active: 1, bus_no: 1 }, { name: "role_1_is_active_1_bus_no_1" })
db.users.createIndex({ excel_upload_id: 1, is_active: 1, _id: 1 }, { name: "excel_upload_id_1_is_active_1__id_1" })
db.buses.createIndex({ altered_to_bus_id: 1, alteration_type: 1 }, { name: "altered_to_bus_id_1_alteration_type_1" })
db.buses.createIndex({ alteration_type: 1, altered_at: -1, _id: -1 }, { name: "alteration_type_1_altered_at_-1__id_-1" })
db.busroutes.createIndex({ bus_id: 1, plan_name: 1, stop_order: 1 }, { name: "bus_id_1_plan_name_1_stop_order_1" })
db.planmappings.createIndex({ plan_name: 1, root_bus_id: 1 }, { name: "plan_name_1_root_bus_id_1" })
db.planmappings.createIndex({ plan_name: 1, member_bus_ids: 1 }, { name: "plan_name_1_member_bus_ids_1" })
db.buschanges.createIndex({ status: 1, createdAt: -1, _id: -1 }, { name: "status_1_createdAt_-1__id_-1" })
db.buschanges.createIndex({ type: 1 }, { name: "type_1" })
db.buslivelocations.createIndex({ publicationPending: 1, publicationRetryExhausted: 1, publicationNextAttemptAt: 1, publicationClaimUntil: 1, updatedAt: 1 }, { name: "publication_pending_retry_claim" })
db.notifications.createIndex({ user_id: 1, createdAt: -1 }, { name: "user_id_1_createdAt_-1" })
db.notifications.createIndex({ user_id: 1, read_at: 1, createdAt: -1 }, { name: "user_id_1_read_at_1_createdAt_-1" })
db.exceluploads.createIndex({ uploaded_by: 1, createdAt: -1 }, { name: "uploaded_by_1_createdAt_-1" })
db.assignmentpropagationoutboxes.createIndex({ status: 1, next_attempt_at: 1, lease_expires_at: 1, createdAt: 1 }, { name: "status_retry_lease_created" })
db.assignmentpropagationoutboxes.createIndex({ replay_of: 1, status: 1 }, { name: "replay_of_1_status_1" })
db.assignmentpropagationreplays.createIndex({ original_job_id: 1, createdAt: -1 }, { name: "original_job_id_1_createdAt_-1" })
db.administrativechangeaudits.createIndex({ createdAt: -1, action: 1 }, { name: "createdAt_-1_action_1" })
db.planmappingaudits.createIndex({ createdAt: -1, _id: -1 }, { name: "createdAt_-1__id_-1" })
db.importoperations.createIndex({ actor_id: 1, import_type: 1, idempotency_key: 1 }, { unique: true, name: "import_actor_type_key_unique" })
db.importoperations.createIndex({ status: 1, updatedAt: 1 }, { name: "status_1_updatedAt_1" })
db.importrows.createIndex({ operation_id: 1, row_number: 1 }, { unique: true, name: "import_row_number_unique" })
db.importrows.createIndex({ operation_id: 1, status: 1, claim_until: 1, row_number: 1 }, { name: "import_row_claim" })
```

Create schema-declared unique indexes only after preflight and review. For example:

```javascript
db.users.createIndex({ email: 1 }, { unique: true, name: "email_1" })
db.buses.createIndex({ bus_no: 1 }, { unique: true, name: "bus_no_1" })
db.buses.createIndex({ gps_device_id: 1 }, { unique: true, name: "gps_device_id_1" })
db.buses.createIndex({ preview_number: 1 }, { unique: true, sparse: true, name: "preview_number_1" })
db.buslivelocations.createIndex({ bus_id: 1 }, { unique: true, name: "bus_id_1" })
```

Do not blindly run the sample commands if a semantically equivalent index already exists under a different name/options. In particular, check for duplicate equivalent indexes before creating.

## Verification, rollback, and unresolved index work

1. Save a pre-change `getIndexes()` inventory and staging query-plan baselines.
2. Apply one collection at a time in staging; inspect build output and `getIndexes()`.
3. Use representative synthetic-data `explain("executionStats")` on route reads, assigned-user lookups, upload pagination, outbox claim, notification listing, and GPS publication claim.
4. Compare latency, examined keys/documents, write latency, disk use, and index size.
5. Obtain explicit deployment approval before production change. Have a tested backup/restore plan and maintenance window.
6. Roll back only a newly added index whose removal is approved and whose query impact is understood:

```javascript
db.getCollection("<collection>").dropIndex("<exact-index-name>")
```

Never drop or rebuild a unique index during rollback without verifying application behavior and duplicate exposure.

## Isolated replica-set verification setup (Windows, no Docker)

Import transactions require a MongoDB replica set. This setup is for a disposable local database only; never substitute an application, staging, or production connection string.

1. A local MongoDB Community Server 8.3.7 binary was available. A dedicated `mongod` process was started on loopback only (`127.0.0.1:27018`) with replica-set name `bts-import-test` and a fresh temporary data directory. The running Windows MongoDB service was not contacted.

   ```powershell
   New-Item -ItemType Directory -Force C:\bts-import-repl-test\data | Out-Null
   mongod.exe --replSet bts-import-test --dbpath C:\bts-import-repl-test\data --bind_ip 127.0.0.1 --port 27018
   ```

2. In a second PowerShell window, initialize the single-node replica set:

   ```powershell
   mongosh "mongodb://127.0.0.1:27018/admin" --eval "rs.initiate({_id:'bts-import-test',members:[{_id:0,host:'127.0.0.1:27018'}]})"
   ```

3. Use a disposable database name and an isolated test-only configuration. Confirm `hello` reports `setName: "bts-import-test"` before running any transaction integration test. Do not copy secrets or production configuration into this process.

4. Run the dedicated suite against a new database name matching `bts_release_gate_<hex>`; the suite rejects non-loopback hosts, ports other than `27018`, and any replica-set name other than `bts-import-test`:

   ```powershell
   Set-Location backend
   $env:BTS_REPLICA_TEST_URI = "mongodb://127.0.0.1:27018/bts_release_gate_<unique-hex>?replicaSet=bts-import-test"
   node --import ./test/bootstrap.cjs --test ./test/import-replica.integration.test.js
   ```

   The test uses synthetic data and creates the model-declared indexes only in that isolated database. It verifies commit/rollback, conditional revision conflicts, unique-index duplicate rejection, concurrent row claims, same-key replay and changed-content conflicts, user assignment import and revision advance, transactional Excel-upload deactivation and last-superadmin protection, import recovery after a controlled pre-commit exception, GPS configuration rollback/commit fencing, outbox retry after notification persistence, and lease loss/reacquisition. This is controlled fault injection, not an operating-system process kill.

   Evidence for this release: MongoDB 8.3.7, `setName: bts-import-test`, `isWritablePrimary: true`; integration suite exit code 0, 10 tests passed, 0 failed, 0 skipped. The suite applied and checked all 28 declared indexes across its model inventory, including import unique/query indexes. The suite did not connect to staging or production. The main backend unit suite run does not replace this replica-set-specific command.

5. To verify an index deployment in a target environment, use the preflight, `createIndex`, `getIndexes()`, and `explain("executionStats")` commands above only after explicit approval and backup planning. Never use the local verification as evidence of remote index state.

The only index creation and verification for this release occurred in the disposable loopback-only replica-set database described above. No staging, Atlas, or production index migration was run.
