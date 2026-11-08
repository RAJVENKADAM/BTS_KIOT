# BTMS Phase 1.5 — Independent lifecycle and environment verification

**Review date:** 2026-11-07
**Verdict: FAIL** — the Phase 1 separation is substantially present and all
requested local suites pass, but source-level safety and lifecycle gaps remain.
Do not treat Phase 1 as verified for the stated isolation guarantees, and do
not proceed to Phase 2 until the high-severity corrections below are resolved
and covered by regression tests.

## 1. Scope and safety

Reviewed the Phase 0 audit, both Phase 1 reports, backend runtime/configuration
and worker code, mobile/admin URL selection, test bootstraps, tests, and Expo
configuration. Findings below are based on current source, not on the Phase 1
report's claims alone.

No implementation or configuration files were changed. The only file created
for this request is this verification report. No production service, Render,
MongoDB, Redis, or GPS provider was contacted. No remote or load tests were
run. No Git commands or operations were performed.

## 2. Executive findings

The refactoring does defer normal runtime initialization to explicit
functions: importing `app.js` is side-effect-free, `createRuntime()` creates
the app and HTTP server without initializing Socket.IO/Redis, and the worker
has process-local start/overlap guards. The MongoDB test-target guard works
for its two connection entrypoints, and production Render URL selection is
preserved when the production environment is selected.

However:

1. A local-integration database retry drops `startGpsWorker: false`, so a
   later successful retry can load the worker and make a real GPS request.
2. `runtime.shutdown()` does not coordinate with an in-progress `start()`;
   startup can continue to listen after shutdown has begun.
3. Locally served admin pages on IPv4 loopback addresses other than
   `127.0.0.1` are classified as production and select Render. For example,
   `http://127.0.0.2` can silently target the live admin API.
4. Shutdown disconnects MongoDB before awaiting completion of the HTTP server
   close/drain, so active API requests can lose their database connection.
5. Test bootstrap defaults Redis to single-instance and clears Redis URLs,
   but Redis mode has no test-environment prohibition. Runtime status and
   shutdown also load the GPS worker module even when its startup is disabled.

These are not exposed by the passing suite. The lifecycle tests do not cover
shutdown during startup or an in-flight HTTP request; environment tests do not
cover the admin 127/8 loopback range or retries after GPS has been disabled.

## 3. Lifecycle review

### Construction, startup, and shutdown sequence

1. `require(".../src/app")` exports `createApplication` without requiring
   application dependencies until that factory is invoked.
2. `createRuntime()` calls `createApplication()` and creates an HTTP server.
   Socket.IO and shared Redis are initialized only when `start()` runs.
3. `start()` initializes Socket.IO, awaits Redis readiness, listens, and
   schedules database-dependent service startup.
4. The service startup waits for MongoDB readiness, then starts the GPS worker
   unless passed `startGpsWorker: false`.
5. `shutdown()` calls `server.close()` to stop admission, stops DB-dependent
   services and the worker, closes Socket.IO/Redis, disconnects MongoDB, and
   only then awaits the HTTP close callback.

Source: [`createApplication()`](../../backend/src/app.js#L3),
[`createRuntime()` and `start()`](../../backend/src/runtime.js#L5),
[`shutdown()`](../../backend/src/runtime.js#L150),
[`startDbDependentServices()`](../../backend/src/services/startServices.js#L92).

### Verified lifecycle properties

- **Import isolation — PASS.** `app.js` has no top-level `require()` for its
  application modules. The existing import-isolation tests pass. Importing
  `server.js` also does not load dotenv or call `main()` unless it is the CLI
  entrypoint.
- **Runtime construction — PASS with qualification.** It constructs Express
  and HTTP objects but does not initialize Socket.IO/Redis or start services
  until `start()`. The readiness status closure can load the worker module
  when `/ready` is requested; see GPS findings.
- **Duplicate runtime start — PASS by inspection.** One runtime instance
  returns the same `startPromise` to concurrent/repeated `start()` calls and
  rejects after shutdown begins. Existing tests do not assert concurrent or
  repeated calls.
- **Duplicate worker start — PASS for the singleton instance.** The worker
  sets `started` synchronously and ignores subsequent `start()` calls; the
  service module also has `starting`/`started` guards. Separate service
  callers while startup is pending return immediately rather than await the
  existing `startupPromise`; they do not start a second worker, but the
  function does not provide completion synchronization to those callers.
- **Shutdown idempotency — PASS by inspection.** Repeated shutdown calls
  return the same `shutdownPromise`. Existing runtime tests invoke shutdown
  once and do not verify concurrent/repeated shutdown.
- **Startup-failure cleanup — PARTIAL PASS.** A rejected Redis readiness
  promise invokes shutdown and the existing fake test verifies cleanup.
  Synchronous partial Socket.IO initialization also enters the same cleanup
  path. A listener failure is not separately covered.
- **Database readiness — PASS for `/ready`.** `buildReadiness()` requires
  MongoDB ready state 1, plus Redis readiness when Redis mode is selected.
  Mongo connection failure does not produce a false `READY`. `/health` is
  intentionally liveness-only and can return 200 when dependencies are down.
- **Unhandled promise review — no confirmed unhandled rejection in the normal
  path.** Worker cycles attach rejection handlers; Redis readiness is awaited;
  background-start failure is logged; CLI startup and signal-shutdown
  failures are caught. Shutdown can reject on HTTP-close failure, so callers
  still need to handle the returned promise.

### High risks

**HIGH — Shutdown can race startup and allow a listener to open after
shutdown.** In [`start()`](../../backend/src/runtime.js#L103), the runtime
awaits `socketCluster.ready` and then calls `listen()` without checking
whether `shutdownPromise` was created while it was awaiting. `shutdown()`
does not await/cancel `startPromise` before closing resources. If shutdown
begins while Redis readiness is pending and that readiness later succeeds,
the original start path can continue into `listen()` after shutdown has
closed the server. No existing test covers this interleaving.

Required regression test: hold `socketCluster.ready` unresolved; call
`start()`; call and await `shutdown()`; then resolve readiness. Assert the
server never begins listening, no background startup occurs, and both
promises settle to a documented terminal result. Also cover shutdown while
the listen callback is pending.

**HIGH — HTTP requests are not drained before MongoDB disconnect.**
[`shutdown()`](../../backend/src/runtime.js#L150) starts `server.close()` and
retains its completion promise, but disconnects MongoDB at line 219 before
awaiting that promise at line 223. Existing in-flight API handlers may still
need MongoDB during this interval. Socket closure may end some connections,
but does not guarantee that all active HTTP handlers have completed.

Required regression test: hold an in-flight handler until a deferred signal;
initiate shutdown; verify MongoDB disconnect is not called until the request
has drained and the server close promise has completed.

**MEDIUM — Shutdown can wait indefinitely for an active GPS cycle.**
`GpsSyncWorker.stop()` clears the interval and awaits `inFlightCycle`, which
is the right ordering for normal completion. Provider calls have a timeout,
but database work/cursor operations have no worker-level cancellation or
shutdown deadline here. A stuck operation can therefore keep shutdown
pending. Required test: hold a provider or database operation indefinitely
and establish the intended shutdown policy (wait, abort, or bounded failure).

## 4. Environment isolation review

### MongoDB

- `assertSafeDatabaseTarget()` rejects unit-test connections and constrains
  explicit local integration to the `btms_test` / `btms_test_*` database
  pattern on `localhost`, `127.0.0.1`, or `::1`. Both
  `connectDB()` and `testMongoConnection()` call the guard before connecting.
- This is a strong guard for those code paths. Source search found no other
  `mongoose.connect()` calls under backend `src/`.
- The test bootstrap sets `NODE_ENV=test`, `TEST_ENVIRONMENT=unit`, and
  deletes Mongo URI/credential variables. `NODE_TEST_CONTEXT` adds another
  unit-test rejection path.
- Local integration accepts IPv6 loopback and uses the actual database path
  embedded in the URI for its name check. No local MongoDB was contacted.

### Redis and GPS

- Backend test bootstrap deletes Redis URLs and sets
  `SOCKET_IO_MODE=single-instance`, so the normal `npm test` setup avoids a
  real Redis connection.
- **The guarantee is not enforced by the Redis resolver itself.**
  `getSharedServiceConfig()` accepts `SOCKET_IO_MODE=redis` in
  `NODE_ENV=test` if a Redis URL is present. `createSocketCluster()` then
  creates real clients unless dependencies are injected. Existing Redis tests
  inject fakes, but there is no hard unit-test guard comparable to MongoDB.
  Required regression: prove test mode rejects Redis mode before loading the
  Redis package/client, even if a test supplies a URL.
- GPS worker startup is disabled by the runtime for `NODE_ENV=test`,
  `TEST_ENVIRONMENT=unit`, and `TEST_ENVIRONMENT=local-integration`; however,
  this is not a guard in the worker itself. The retry defect below can bypass
  the flag.
- `startDbDependentServices()` still performs Mongo readiness attempts in
  unit mode before honoring `startGpsWorker: false`. MongoDB is blocked by
  the guard, so this does not connect, but it does retry/log and schedule an
  unref'ed retry rather than short-circuiting unit startup.

### URL selection and API surfaces

- Mobile REST and Socket.IO both use `API_BASE_URL`/`SOCKET_BASE_URL`
  exported by the shared mobile resolver. Repository search found no
  additional hardcoded Render API target in frontend application code.
- The static dashboard uses its own `docs/config.js` resolver, and
  `docs/app.js` consumes `window.BTMS_CONFIG.API_BASE_URL` for HTTP requests.
  Its exported socket origin is the same value.
- Mobile production selection preserves the configured Render origin and
  rejects a different `EXPO_PUBLIC_API_BASE_URL` **when**
  `EXPO_PUBLIC_BTMS_ENV=production` is selected. Remote-test mode requires
  both `EXPO_PUBLIC_BTMS_ENV=remote-test` and
  `EXPO_PUBLIC_ALLOW_REMOTE_TESTS=YES`.
- **Qualification:** an explicit `EXPO_PUBLIC_BTMS_ENV=local` takes
  precedence over `NODE_ENV=production`; the resolver then accepts a local
  endpoint. Thus the production fallback is safe by default, but a production
  build whose EAS environment explicitly supplies `local` is not rejected.
  EAS environment values are not in the checked-in repository.
- Mobile `parseOrigin()` rejects invalid, credential-bearing, path/query/
  fragment URLs and local mode rejects non-loopback/non-private targets.
  IPv6 `::1` is supported. It recognizes only `127.0.0.1`, not the complete
  IPv4 loopback range.

**HIGH — Local admin on 127/8 other than 127.0.0.1 silently selects Render.**
`docs/config.js` classifies only `127.0.0.1` as loopback. A dashboard served
from `http://127.0.0.2` is not recognized as local; absent an explicit
environment override, the default branch selects `production` and the
existing Render origin. Since the dashboard includes mutating admin
operations, this violates the no-silent-Render-fallback requirement.
The existing IPv4 tests cover a private LAN address but not other 127/8
addresses.

Required regression test: load dashboard config with hostname `127.0.0.2`
and verify it selects local (or fails closed), never Render. Also cover
127/8 handling in the mobile resolver so that a valid loopback address is
accepted or explicitly rejected without any production fallback.

### Logging and invalid/missing configuration

- `safeErrorLog.logSafeError()` emits only an operation label, sanitized error
  name/code, and validated request ID; it does not print raw error messages,
  URLs, or credentials.
- GPS startup logs only whether credentials are configured. GPS service
  failure logs a generic message, and worker errors are reduced to safe
  name/code fields. No credential value is logged in the inspected paths.
- Missing production JWT/Mongo configuration throws in
  `validateProductionConfiguration()`. Missing/invalid Socket.IO mode or
  Redis URL fails during cluster setup before listen. A missing Mongo URI in
  non-production is retried and leaves `/ready` not ready rather than
  producing a false healthy readiness response.

### Severity summary

| Severity | Finding |
|---|---|
| Critical | None identified in the reviewed scope. |
| High | Local-integration retry can re-enable GPS; shutdown/start race can listen after shutdown; admin loopback `127.0.0.2` defaults to Render. |
| Medium | MongoDB is disconnected before HTTP drain; unit mode has no hard Redis guard; test/readiness/shutdown can load the worker module despite disabled worker startup; shutdown can wait indefinitely for an active cycle; explicit `local` selector overrides production `NODE_ENV`. |
| Low | Service-start duplicate callers return before the in-flight startup completes; complete lifecycle synchronization is not tested. |

## 5. GPS worker safety review

- **35-second polling — PASS.** `GPS_SYNC_INTERVAL_MS` remains `35_000`;
  `start()` immediately runs one cycle and schedules subsequent interval
  cycles at that duration.
- **Overlap prevention — PASS for one worker instance.** `runCycle()` uses
  `syncLock`; timer ticks while a cycle is running are skipped. `start()`
  does not create a second interval on the same instance.
- **Active work shutdown — PARTIAL PASS.** `stop()` clears the timer and
  awaits `inFlightCycle`, so the normal shutdown path does not intentionally
  disconnect MongoDB before the worker cycle ends. The wait is unbounded, and
  runtime does not protect against a hung cycle.
- **Provider failure and coordinate preservation — PASS.** A thrown provider
  error or unusable `null` response returns before writes. An explicit empty
  provider map updates liveness/poll status but not latitude/longitude.
  Existing fake-provider tests assert this behavior.
- **Health/readiness do not start work — PASS, with module-load
  qualification.** `/health` performs no runtime status lookup. `/ready`
  reads worker status but does not start it or call GPS. Runtime status
  obtains that status by requiring `gpsSyncWorker`; `shutdown()` also
  unconditionally requires the worker to call `stop()`. Therefore the
  stronger claim that unit/local test modes never *load* the worker is false,
  although these paths do not by themselves make a provider request.

**HIGH — Local-integration retry loses the GPS-disabled option.**
`performStartup({ startGpsWorker: false })` schedules a retry on database
readiness failure. `scheduleStartupRetry()` invokes
`startDbDependentServices()` with no options, whose default is
`startGpsWorker: true`. If MongoDB becomes ready on a later retry, this
process loads and starts the GPS worker. The CLI loads `.env` before startup,
so existing GPS credentials can then cause a real provider request. This
directly contradicts the local-integration safety guarantee.

Required regression test: invoke startup with GPS disabled and a deferred
database readiness sequence; fail the initial readiness, fire the scheduled
retry, then succeed readiness. Assert the GPS worker module is never required
and `start()` is never called. Keep tests hermetic with fake readiness/timers.

Other GPS-focused startup test gaps:

- The existing local-integration startup test covers only an immediately
  successful DB readiness; it does not cover the retry path.
- Runtime `/ready` and `shutdown()` worker-module loads are not asserted in
  test/local-integration mode.
- No distributed worker lock is present; this was explicitly out of scope and
  is not proposed here.

## 6. Expo project identity

Repository evidence establishes:

- `frontend/package.json` owns the current Expo scripts (`start`, `android`,
  `ios`, `web`) and declares Expo `~58.0.21`. Running those scripts from
  `frontend/` makes `frontend/` the effective project root for those
  commands.
- `frontend/app.json` declares Android package and iOS bundle identifier
  `com.rajvenkadam.bustracking` and EAS project ID
  `d2b0e413-8d33-4486-b0ca-4bbc2a04a5c4`.
- `frontend/eas.json` contains CLI version `>=18.8.1` and development,
  preview, and production profiles.
- Root `app.json` declares Android package `com.rajvenkadam.bts` and EAS
  project ID `7bdcbf36-68e3-44bc-8060-fc6e4e889648`; root `eas.json` declares
  CLI version `>=21.3.0` and different profile details.
- No Expo/EAS identifiers or files were changed.

Repository evidence cannot establish which project ID/package is registered
to the currently distributed application, which EAS project/profile produced
the latest store artifact, which EAS environment variables were used, or
whether the root configuration is still used by a separate workflow. These
require actual EAS build/submission and app-store release history. Do not
change/delete either identity based only on this checkout.

## 7. Existing regression tests

Commands were run from the correct package directories. Initial `npm test`
attempts from the repository root failed because there is no root test
script; they did not run suites and were rerun correctly.

| Command | Result |
|---|---|
| `Set-Location 'E:\My Works\College Products\BTS\backend'; npm test` | **251 passed, 0 failed, 0 skipped**, exit code 0; 54.2 seconds |
| `Set-Location 'E:\My Works\College Products\BTS\frontend'; npm test` | **47 passed, 0 failed, 0 skipped**, exit code 0; 4.8 seconds |
| `node --test docs/config.test.cjs` from repository root | **5 passed, 0 failed**, exit code 0 |

The frontend suite emitted an existing Node
`MODULE_TYPELESS_PACKAGE_JSON` warning for `src/utils/errorHandler.js`.

The tests cover fake Redis lifecycle, import isolation, MongoDB guard behavior,
worker idempotency/overlap and fake provider failures. They do not prove
real-service behavior, and passing tests do not cover the specific races and
environment cases identified above.

## 8. Required corrections before Phase 2

No implementation correction was made during this review. Before Phase 2:

1. Preserve the GPS-disabled setting across every DB/service retry and add the
   deferred retry regression test.
2. Coordinate `start()` and `shutdown()` so shutdown cancels or waits for
   in-progress initialization and a listener cannot start afterward. Add
   tests for shutdown during Redis readiness and listener binding.
3. Drain active HTTP requests before disconnecting MongoDB; test ordering with
   a deferred request.
4. Make local admin selection recognize the entire IPv4 loopback range or
   fail closed for unrecognized loopback hosts; add `127.0.0.2` regression
   coverage.
5. Enforce that unit mode cannot instantiate a real Redis client and cannot
   start a real GPS worker, rather than relying solely on cleared bootstrap
   variables. Add tests that provide explicit Redis/GPS configuration and
   assert rejection before external client/provider initialization.
6. Avoid loading the GPS worker merely to report `/ready` or to shut down a
   runtime in which the worker was never initialized, or explicitly narrow
   the guarantee/documentation to “never start or call GPS.”
7. Decide and test the intended mobile production build policy when
   `NODE_ENV=production` conflicts with an explicit `EXPO_PUBLIC_BTMS_ENV`.
8. Re-run the existing backend, frontend, and admin suites after corrections.

## 9. Final safety confirmation

No production services, remote tests, load tests, deployment, or Git
operations were performed. No implementation/configuration corrections were
made; this report is the only file created for Phase 1.5. No 10,000-user
readiness claim is made.
