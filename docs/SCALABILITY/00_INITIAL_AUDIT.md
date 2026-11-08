# BTMS Phase 0 — Initial Repository and Environment Audit

**Audit date:** 2026-11-07
**Scope:** Repository structure, current uncommitted state, application configuration and source-level architecture. No production service, database, Redis instance, GitHub deployment, or GPS provider was contacted during this audit. Local environment-file values were not read or recorded.

## 1. Repository and worktree

- Repository root: `E:\My Works\College Products\BTS`.
- Current branch: `main`.
- `HEAD` and `origin/main` both point to `f77c1f4` (`socket`). The following worktree changes are not committed or pushed.
- At audit start Git reported **16 modified tracked paths and 22 untracked paths/directories**. All were preserved. The audit file itself was an empty untracked file and is now populated by this Phase 0.
- Tracked file inventory at audit time: 130 under `backend/`, 67 under `frontend/`, six under `docs/`, and root/config/assets in addition. `Bus Routes/` contains 18 spreadsheet files. The `admin-dashboard/` directory has no files; the static admin dashboard is under `docs/`.
- No tracked Render, Railway, Fly.io, Docker, Procfile, or other backend deployment manifest was found. There are GitHub workflow files, but no Render service specification or deployment history in this checkout.

### Existing uncommitted paths and purpose

The backend changes were already present before this audit. They cover authentication/limiting, proxy trust, Redis Socket.IO configuration and readiness, bus query/index work, bounded load-test runners, tests, and documentation. No Phase 0 code changes were made.

Modified tracked paths:

- `backend/.tsupgrader/runtime-validation/eval-plan.json`
- `backend/.tsupgrader/runtime-validation/standalone-result.json`
- `backend/load-tests/.gitignore`
- `backend/load-tests/README.md`
- `backend/load-tests/student-load-test.js`
- `backend/package-lock.json`
- `backend/package.json`
- `backend/server.js`
- `backend/src/app.js`
- `backend/src/controllers/auth.controller.js`
- `backend/src/controllers/bus.controller.js`
- `backend/src/models/BusRoute.js`
- `backend/src/utils/authProtection.js`
- `backend/src/utils/readiness.js`
- `backend/test/auth-login.test.js`
- `backend/test/bus-read-context.test.js`

Untracked paths:

- `backend/docs/login-limiter.md`
- `backend/docs/phase-2-index-review.md`
- `backend/docs/proxy-trust.md`
- `backend/docs/socket-io-clustering.md`
- `backend/load-tests/capacity-test-core.cjs`
- `backend/load-tests/student-capacity-test.js`
- `backend/load-tests/student-login-capacity-test.js`
- `backend/scripts/migrate-login-attempts.js`
- `backend/src/config/proxyTrust.js`
- `backend/src/config/sharedServices.js`
- `backend/src/models/LoginAttemptBucket.js`
- `backend/src/utils/loginAttemptLimiter.js`
- `backend/test/app-import-isolation.test.js`
- `backend/test/auth-protection-queue.test.js`
- `backend/test/bus-assignment-query.test.js`
- `backend/test/login-attempt-limiter.test.js`
- `backend/test/proxy-trust.test.js`
- `backend/test/shared-services.test.js`
- `backend/test/student-capacity-test.test.js`
- `backend/test/student-load-test.test.js`
- `backend/test/student-login-capacity-test.test.js`
- `docs/SCALABILITY/00_INITIAL_AUDIT.md`

This list records existing work; it does not imply these changes are committed, deployed, or all independently verified.

## 2. Current stack and configuration

- Backend: Node.js/Express, Mongoose/MongoDB, JWT, bcryptjs, Socket.IO. Backend dependencies now include `redis`, `@socket.io/redis-adapter`, and `proxy-addr`. No Node engine range is specified in the backend manifest.
- Mobile: `frontend/` is the Expo/React Native application, using React Native 0.88.1, Expo `~58.0.21`, Socket.IO client, and secure storage. The supplied project context says Expo SDK 56; the checked-in dependency manifest currently says SDK 58.
- Admin: a static browser dashboard is served from `docs/`; `docs/config.js` selects the Render API origin directly. `admin-dashboard/` is empty.
- Runtime observed locally: Node `v24.18.0`, npm `11.16.0`.
- Local ignored files `backend/.env` and `frontend/.env` exist. Only environment-variable **names** were inspected. Backend names include `GPS_TOKEN`, `GPS_EMAIL`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `JWT_SECRET`, email/superadmin settings, and `MONGODB_URI`; frontend `.env` contains `NODE_ENV`. No tracked `.env.example`/sample was found.
- There are duplicate Expo/EAS configurations at the repository root and under `frontend/`. The two app configs contain different EAS project IDs and Android package identifiers. The intended build root/identity needs to be established before changing build configuration.
- `frontend/src/api/api.js` uses `EXPO_PUBLIC_API_BASE_URL` when set, but otherwise defaults to `https://bts-kiot.onrender.com`. REST and the mobile Socket.IO client both use this same value. The static admin dashboard has its own hardcoded Render URL in `docs/config.js`. No distinct `SOCKET_BASE_URL` exists.
- Capacity runners default to local loopback and use the fail-closed validator/explicit staging allowlist introduced in the current worktree. There is not yet a unified application-wide environment policy shared by mobile, admin, local integration tests, and remote smoke tests.
- Production API and Socket.IO behavior should remain on the existing Render URL in production builds; no global URL replacement was made.

## 3. Backend startup and lifecycle (source-confirmed)

1. `backend/server.js` imports `src/app.js`, waits for the Socket.IO shared-service readiness promise, then starts listening.
2. `src/app.js` loads dotenv, constructs Express, HTTP and Socket.IO objects, attaches middleware/routes/health endpoints, registers socket authentication and tracking handlers, and calls `configureSocketCluster`.
3. In Redis mode, `configureSocketCluster` constructs publisher/subscriber clients and begins asynchronous connection as part of application construction/import. In explicit single-instance mode it keeps Socket.IO's in-memory adapter.
4. After the HTTP listener starts, `server.js` calls `startDbDependentServices`. That service waits/retries MongoDB connection and starts the singleton GPS worker after database readiness. The worker immediately runs a cycle and then schedules 35-second ticks; overlapping cycles are skipped.
5. `/health` is a liveness-style response and does not check dependencies. `/ready` reports database, socket-cluster, worker, provider-cycle, and socket-client state; it does not itself call the GPS provider.
6. Signal shutdown stops DB-dependent service retries and the worker, closes Socket.IO/shared Redis clients, and disconnects Mongoose. The sequence does not first explicitly stop accepting HTTP requests before waiting for worker/service shutdown; graceful-drain ordering needs review.

**Import-isolation test finding:** the newly present `backend/test/app-import-isolation.test.js` fails locally with exit code 1 because its child process hits its hard-coded 5-second `spawnSync` timeout (`ETIMEDOUT`). A direct app-import probe also did not finish during a 30-second bounded run. The cause was not established in Phase 0, so application-import isolation is **unverified** and is a blocker for the lifecycle phase. No code was changed to suppress this result.

## 4. Authentication and session flow

- Login validates input, normalizes email, reserves a shared MongoDB-backed limiter slot, runs bounded auth/password-check queues, loads the user, checks account status, verifies the password through the model's bcrypt comparison, records failure or completes the reservation, signs a 24-hour JWT, and resolves a bus preview for the login response.
- User password hashing uses bcryptjs cost 12. Queue caps are process-local; shared account limiter state uses MongoDB transactions and requires the TTL-index migration plus a transaction-capable MongoDB deployment.
- The custom login limiter distinguishes account failures/reservations from per-observed-IP pending concurrency. Separately, the Express API rate limiter is process-local, has a 300-per-window limit keyed by JWT subject or IP, and skips login. Its state is not shared across instances.
- Protected HTTP requests and socket handshakes verify the JWT and query current user state from MongoDB. This preserves current account deactivation checks, but adds database work per request/connection.
- Mobile session restore verifies with `/api/auth/verify`; periodic verification runs every five minutes with a randomized initial delay. Transient errors are generally retained for student sessions, but `restoreCachedSession` does not restore a cached superadmin session when verification throws. This behavior needs a role-specific compatibility/security decision and tests.
- Socket handlers authenticate the user, automatically join a user room, and validate active preview buses before joining preview rooms. Existing authorization and event contracts must be retained during scale changes.

## 5. Database and bus read patterns

- MongoDB URI is required by backend configuration; `mongoose.connect` is used without explicit pool sizing in the inspected connection helper. Actual URI, database plan, replica-set state, connection limits, storage, and deployed index definitions were not inspected.
- `User` declares role/active/bus and Excel-upload indexes. `BusLiveLocation` has a unique bus reference. The current Phase 2 index review retains the `BusRoute` `(bus_id, plan_name, stop_order)` declaration provisionally; no physical database index or query plan is proven by that declaration.
- The GPS cycle reads active buses and all active students with non-empty assignments, reads matching existing locations in a batch, then performs sequential per-bus writes/emissions. The all-assigned-student read recurs every cycle. There is no live MongoDB `explain("executionStats")` evidence.
- Bus read helpers include batched context/query work and pagination utilities exist, but this audit did not establish that every externally accessible list/export endpoint is bounded. Complete endpoint/query inventory belongs to later database/API phases.
- No migration or database operation was executed during this audit.

## 6. GPS and real-time behavior

- The provider client calls the fixed GPS Track endpoint only when `getAllCurrentLocations` is invoked; importing the service alone does not issue the provider request. The worker calls the provider once per fleet cycle, immediately on start and then on its fixed cadence.
- Provider normalization accepts multiple response shapes and matches device/reg-number aliases. The worker reads buses/users/locations, writes each bus sequentially, and emits `locationUpdate` only after a successful persistence call.
- The source schema is a free-form string defaulting to `"gps"`; normalization also labels provider entries `"gps"`. There is no enforced `REAL`/`SIMULATED` classification, managed physical-device registry, assignment history, distributed worker lease, or fencing mechanism in the inspected code. Missing-provider-record/staleness handling exists, but an older provider timestamp is not used as a write guard in the inspected worker path.
- The requirement states one physical unit and five simulated bus records, but this audit did not inspect production database records and cannot verify their source assignments. The current code does not establish that the five are distinguishable from genuine provider data.
- Worker coordination is process-local. Multiple server processes could run fleet polling independently unless external coordination is added.
- Mobile Socket.IO currently uses WebSocket-only transport and disconnects in background; server Socket.IO retains its default polling support. Polling clients behind a multi-instance load balancer require sticky sessions.
- Redis lifecycle tests use fake clients. No real Redis instance, two-process adapter test, lease test, or cross-instance event-delivery result is available.

## 7. Repository findings and risks to carry into phase gates

### Confirmed from checked-in source/configuration

1. Mobile and static admin development/test use can fall back to the production Render URL; REST and mobile Socket.IO share one base URL. Android emulator (`10.0.2.2`) and physical-device LAN targets are not configured as explicit profiles.
2. Expo build identity is duplicated between root and `frontend/`, with different project/package identifiers; the authoritative build configuration is unresolved.
3. No checked-in Render service config or deployment history establishes auto-deploy branch, running commit, or current paid/free service configuration.
4. Socket.IO Redis adapter/lifecycle exists in uncommitted source, but actual cross-instance behavior is unverified.
5. GPS source classification and distributed worker ownership do not meet the stated `REAL`/`SIMULATED` and single-fleet-owner requirements.
6. Per-request authentication performs a user lookup; mobile verification adds periodic API traffic. Neither has a production capacity baseline.
7. Process-local API rate-limit state is not horizontally shared. The Mongo login limiter's real transaction/TTL behavior remains unverified against a non-production replica set.
8. No deployed index inventory, representative data explain plan, production-like dataset, or controlled capacity measurement is available.
9. A new app-import regression test currently times out locally; do not treat prior green backend results as the current complete suite.

### Not established / assumptions not accepted as facts

- Current Render deployment commit, auto-deploy configuration, service plan, region, health state, and whether it serves live students.
- Current MongoDB provider/tier, data volume, latency, transaction support, replica-set topology, backups, and actual indexes.
- Redis URL/configuration in deployment, service availability, memory/latency, or multi-instance message delivery.
- Real/simulated source of any live GPS record, GPS provider account/device mapping, and behavior as physical devices are added.
- Current number of unique students, authenticated sessions, connected devices, requests per second, active sockets, or peak concurrent users.
- Capacity at 20 through 10,000 users. No load or remote smoke test was run as part of this phase.

## 8. Test evidence at audit time

- Backend package test command: `npm test` (`node --test "test/**/*.test.js"`). The repository currently has 49 backend test files and 10 frontend source test files.
- The latest recorded full backend run before this audit reported **242/242 passed, 0 failed, 0 skipped, exit code 0**. That run predates this audit's check of the newly present import-isolation test and must not be reported as a current full-suite pass.
- The recorded focused run reported **67/67 passed, 0 failed, 0 skipped, exit code 0** for auth/limiter/proxy/Redis/capacity/bus-query coverage.
- Current targeted command `node --test test/app-import-isolation.test.js` reports **1 failed, exit code 1** (`ETIMEDOUT` at 5 seconds). The complete suite was not rerun in Phase 0.
- Existing tests predominantly use fake Redis/Mongo limiter stores and injected HTTP/socket clients. They do not prove real Mongo transactions, Redis adapter delivery, Render behavior, or capacity.
- A previous local validation attempt recorded in the preceding engineering report unintentionally reached the configured GPS provider after local `.env` credentials were loaded. No provider call was made in this Phase 0 audit. Future test plans must explicitly prevent `.env` credential loading and inject provider clients.

## 9. Phase 0 outcome and next gates

**Phase 0 status: COMPLETE WITH BLOCKERS RECORDED.** This is a source/worktree audit, not a production-readiness certification.

The gates below record the state at the time Phase 0 was completed. Section 10
is the later Phase 1 worktree/status update and supersedes its Phase 1 items.

Before declaring later phases complete:

1. Phase 1 must define fail-safe local, test, remote-test, and production URL selection without changing the existing production URL.
2. Phase 2 must resolve the app-import timeout and lifecycle ordering; prove imports do not connect to MongoDB/Redis or start timers/provider work.
3. Authentication, database, GPS, socket, mobile, API, security, and observability phases need evidence appropriate to each dependency; mocked tests alone are insufficient for distributed claims.
4. Do not start a Render deployment or remote capacity test until the deployed branch/commit and impact are established. No production load test is authorized by this audit.

This audit makes no 10,000-user capacity claim and does not mark the application production-ready.

## 10. Phase 1 worktree and gate update

**Update:** 2026-11-07. Phase 1 lifecycle and environment changes were made in
the existing dirty worktree. The Phase 0 inventory above is historical; it
was not used as a reason to discard or overwrite user changes.

Phase 1 added or changed the following worktree paths:

- Backend lifecycle/configuration: `backend/src/app.js`,
  `backend/src/runtime.js`, `backend/server.js`,
  `backend/src/config/mongodb.js`, `backend/src/config/startup.js`,
  `backend/src/config/sharedServices.js`, and
  `backend/src/services/startServices.js`.
- Backend test isolation and lifecycle coverage:
  `backend/test/bootstrap.cjs`, `backend/test/app-import-isolation.test.js`,
  `backend/test/runtime.test.js`, `backend/test/mongodb-environment.test.js`,
  `backend/test/shared-services.test.js`, and
  `backend/test/startServices.test.js`.
- Mobile/admin environment selection: `frontend/src/config/`,
  `frontend/src/api/api.js`, `frontend/src/context/BusContext.js`,
  `frontend/test-bootstrap.cjs`, `frontend/package.json`,
  `docs/config.js`, and `docs/config.test.cjs`.
- Phase 1 records:
  `docs/SCALABILITY/01_ENVIRONMENT_CONFIGURATION.md` and
  `docs/SCALABILITY/01_PHASE1_LIFECYCLE_AND_ENVIRONMENT.md`.

The app import and external-service startup are now separated. The required
backend, frontend, import-isolation, and admin configuration tests passed;
detailed results and limits are in the Phase 1 report. No real MongoDB, Redis,
GPS provider, Render URL, deployment, or load-test target was accessed.
`git diff --check` passed. The repository remains dirty and all pre-existing
modified/untracked paths remain present. Phase 1 is complete on local/mocked
evidence; it is not a production-readiness or capacity certification. Phase 2
has not been started as part of this Phase 1 task.