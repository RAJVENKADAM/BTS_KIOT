# BTMS Phase 1 — Lifecycle and environment separation

**Status:** Phase 1 implementation and local verification complete
**Scope:** Application import/construction, explicit runtime startup and shutdown, environment-specific backend targets, and Expo configuration discovery.
**Safety:** No production MongoDB or Redis was contacted; no GPS provider, Render endpoint, remote test, deployment, or load test was used.

## 1. Import-timeout root cause

The original isolation test used a synchronous child-process import with a
fixed five-second timeout. Cold module-load tracing showed a heavy eager
dependency path from the app's Socket.IO authentication import through the
User model and into Mongoose/bcryptjs. Load time varied; a later warm import
completed in about 2.33 seconds. This is consistent with the cold child
process exceeding an arbitrary five-second harness limit, not a proven
circular-dependency deadlock or synchronous application loop.

There was also a separate lifecycle defect: importing the old `app.js`
constructed HTTP and Socket.IO runtime objects, and Redis setup could begin
during construction when Redis mode was selected. Such import-time runtime
resources made a plain `require()` non-isolated and could keep a probe alive.
The bounded diagnostics did not establish a single permanently blocked module
or show a MongoDB connection, GPS request, or repeating worker timer as the
cause of the timeout. The code now defers runtime-only imports and all external
initialization to explicit startup.

The import-isolation test no longer relies on a five-second timeout. In final
verification, the two import/construction-health tests passed in about 2.13
seconds total; application-module import itself completed in milliseconds.

## 2. Files changed for Phase 1

Backend lifecycle and safety:

- `backend/src/app.js`
- `backend/src/runtime.js`
- `backend/server.js`
- `backend/src/config/mongodb.js`
- `backend/src/config/startup.js`
- `backend/src/config/sharedServices.js`
- `backend/src/services/startServices.js`
- `backend/package.json`
- `backend/test/bootstrap.cjs`
- `backend/test/app-import-isolation.test.js`
- `backend/test/runtime.test.js`
- `backend/test/mongodb-environment.test.js`
- `backend/test/shared-services.test.js`
- `backend/test/startServices.test.js`

Mobile and static dashboard configuration:

- `frontend/src/config/backendEnvironment.cjs`
- `frontend/src/config/backendEnvironment.test.cjs`
- `frontend/src/api/api.js`
- `frontend/src/context/BusContext.js`
- `frontend/test-bootstrap.cjs`
- `frontend/package.json`
- `docs/config.js`
- `docs/config.test.cjs`

Documentation:

- `docs/SCALABILITY/01_ENVIRONMENT_CONFIGURATION.md`
- `docs/SCALABILITY/01_PHASE1_LIFECYCLE_AND_ENVIRONMENT.md`
- `docs/SCALABILITY/00_INITIAL_AUDIT.md` (Phase 1 worktree addendum)

The repository also contains other pre-existing modified and untracked files
from prior work; they were retained and are not represented as Phase 1 edits
here.

## 3. Lifecycle changes

- `createApplication()` constructs Express middleware, routes, and health
  endpoints on explicit invocation. Importing `src/app.js` does not load its
  application dependencies or initialize an HTTP server, Socket.IO, Redis,
  MongoDB, dotenv, workers, or GPS services.
- `createRuntime()` explicitly constructs the HTTP server and Socket.IO,
  waits for configured shared-service readiness, listens, then schedules
  database-dependent services. It exposes `start()` and idempotent
  `shutdown()`.
- `server.js` is the CLI entrypoint. It loads dotenv and registers signal
  handlers only when run as the main module; it exports `startServer()` for
  explicit programmatic startup and production configuration validation.
- Shutdown stops accepting new HTTP requests, stops service retries and the
  GPS worker, closes Socket.IO and shared Redis clients, disconnects MongoDB,
  and completes the HTTP close. Startup failures trigger cleanup and remain
  visible to the caller.
- Unit and local-integration test startup disables the GPS worker. The
  regression test verifies that this path does not even load the worker
  module. Health endpoints only report health/readiness and do not start
  services or call the provider.
- MongoDB URI construction is lazy. Unit-test mode rejects DB connections;
  local integration mode accepts only loopback MongoDB and a `btms_test`
  database name.

## 4. Environment separation

- **Unit tests:** backend and frontend bootstraps select isolated test/local
  configuration. Backend test bootstrap clears DB, Redis, GPS, JWT, email, and
  superadmin credentials. MongoDB access is blocked; Socket.IO uses explicit
  single-instance mode. Mobile REST and Socket.IO share the local resolver.
- **Local backend integration:** requires `TEST_ENVIRONMENT=local-integration`,
  loopback MongoDB, and a dedicated `btms_test` database. GPS worker startup is
  disabled. Local Redis is opt-in only when testing the Redis adapter.
- **Android emulator:** defaults to `http://10.0.2.2:5000`.
- **Physical Android device:** requires an explicit private-LAN
  `EXPO_PUBLIC_API_BASE_URL` on port 5000.
- **Production:** preserves `https://bts-kiot.onrender.com`. Production
  overrides that point elsewhere are rejected. REST and Socket.IO use the
  same resolved origin.
- **Remote Render tests:** the mobile resolver requires both
  `EXPO_PUBLIC_BTMS_ENV=remote-test` and
  `EXPO_PUBLIC_ALLOW_REMOTE_TESTS=YES`; remote mode remains distinct from
  production mode while targeting the existing Render origin. The dashboard
  also requires explicit query opt-in. Use dedicated test identities/data;
  dashboard operations are mutating and must not be used with ordinary
  production accounts.
- **Static admin dashboard:** local loopback/LAN hosts resolve to the same
  host on port 5000; deployed non-local pages preserve the existing Render
  origin. Direct `file://` access fails closed. IPv6 loopback is bracketed
  correctly in the generated URL.

URL search found no other hardcoded backend Render targets in mobile/admin
application code. Map tile, map-routing, font, and library CDN URLs are
unrelated service URLs and were not changed.

## 5. Expo configuration decision

The mobile package scripts are in `frontend/package.json`; running Expo from
`frontend/` resolves `frontend/app.json` (SDK 58, Android package
`com.rajvenkadam.bustracking`, and EAS project ID
`d2b0e413-8d33-4486-b0ca-4bbc2a04a5c4`). `frontend/eas.json` contains the
matching build profiles.

Root `app.json` and `eas.json` contain different project/package identifiers.
They were not changed because no checked-in build workflow, EAS CLI
dependency, or release record proves which root/profile produced an existing
build. The existing frontend npm scripts establish `frontend/` as the
authoritative project root for those commands, but not which configuration
produced a prior released artifact. Confirm build ownership/history before
removing root files or changing any identifiers.

## 6. Tests and results

| Validation | Result |
|---|---|
| Backend `npm test` from `backend/` | **251 passed, 0 failed, 0 skipped**; exit 0; 39.9 seconds |
| Focused `app-import-isolation.test.js` with backend test bootstrap | **2 passed, 0 failed**; exit 0; 2.13 seconds |
| Frontend `npm test` from `frontend/` | **47 passed, 0 failed, 0 skipped**; exit 0; 1.03 seconds |
| `node --test docs/config.test.cjs` | **5 passed, 0 failed**; exit 0 |
| Expo `config --type public` from `frontend/` | Succeeded; resolved SDK 58 and the frontend app/EAS identifiers above |
| `git diff --check` | Passed; Git emitted only existing LF-to-CRLF conversion notices |

The frontend test run emitted Node's existing
`MODULE_TYPELESS_PACKAGE_JSON` warning for `src/utils/errorHandler.js`; no
package module type change was made. An initial test invocation from the
repository root had no root `test` script; the package suites were rerun from
their correct directories and passed. An initial multi-file targeted Node
invocation also treated the supplied paths as one invalid path and ran no
tests; the full backend suite and the import-isolation test were subsequently
rerun successfully from `backend/`.

No live MongoDB/Redis local integration was run because no dedicated local
services were started. The tests verify guards and lifecycle behavior with
fakes; they do not prove real MongoDB transaction behavior, Redis
cross-instance delivery, or deployed Render health. Unit test bootstrap and
the GPS-disabled startup regression prevent the tested path from making GPS
requests; no real provider request was made.

## 7. Remaining issues and limits

- The direct cold-load trace identified an expensive eager dependency path but
  did not attribute elapsed time to one unique module or establish a
  permanently hung import. The fixed timeout was removed rather than raised.
- Redis and MongoDB startup/shutdown are covered with fakes and target guards;
  real local-service integration remains to be run against dedicated local
  instances.
- Remote Render REST/Socket.IO checks were not run. Production URL
  preservation and remote opt-in are verified by configuration tests only.
- Actual EAS release provenance remains unverified; root and frontend Expo
  configuration duplication is intentionally left unresolved.
- Existing worktree changes include work beyond Phase 1. Nothing was staged,
  committed, reset, discarded, pushed, or deployed.
- Phase 2 authentication optimization has not been started as part of this
  Phase 1 task.

## 8. Preservation confirmation

The dirty worktree was inspected before final verification. Existing modified
and untracked work was preserved; no reset, clean, destructive checkout,
discard, staging, commit, push, or deployment command was run. The final
worktree remains dirty by design.
