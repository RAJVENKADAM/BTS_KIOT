# BTMS — Complete Scalability Implementation

## Executive status

Application-level implementation is in place, with deployment prerequisites and validation boundaries listed below. This is **not** a capacity certification and does not establish support for 10,000 concurrent users.

## Implemented

- **Lifecycle and readiness:** Runtime startup is deduplicated and cancellable; shutdown drains HTTP before closing MongoDB, awaits background work, and stops GPS before closing shared services. Unit-test startup does not initiate MongoDB, Redis, or GPS connections. Mongo readiness remains false until connected.
- **Authentication and request handling:** Login admission is account-scoped rather than IP-scoped, so a shared campus NAT does not serialize independent students. Account failure protection, bounded authentication/password queues, bcrypt cost, token semantics, and authorization checks remain. Redis mode uses shared API and audit-rate-limit counters; Redis loss fails closed with `503`, not process-local fallback.
- **MongoDB and API:** Added bounded `MONGODB_MAX_POOL_SIZE` configuration (default 100, maximum 500) and a bounded connection-pool wait (`MONGODB_WAIT_QUEUE_TIMEOUT_MS`, default 10 seconds). Existing bus reads use batch location lookups and projections; superadmin users, Excel-upload users, and temporary bus changes use bounded cursor pages; notification reads are capped. Bus-list online status now reflects the persisted online flag.
- **GPS device registry:** Added `GpsDevice` records with `REAL`/`SIMULATED` classification, unique identity, bus assignment, active state, attempt/success timestamps, provider timestamp, last coordinates, and health. Superadmins can list and configure mappings at `/api/superadmin/gps-devices`; active bus assignments are unique. Reassignment/deactivation marks affected live locations offline without deleting coordinates.
- **GPS worker:** Preserved immediate first cycle, 35-second cadence, overlap prevention, and provider request shape. Provider timestamps are validated and used as the ordering key; missing, invalid, stale, future-skewed, duplicate, and out-of-order updates cannot replace a newer persisted location. Among duplicate provider rows, the newest timestamp wins, identical equal-time rows coalesce, and conflicting equal-time rows are excluded. Accepted location writes increment a monotonic version and atomically create a coalescing publication marker. GPS-device reassignment/deactivation resets device and bus provider watermarks, increments the live-location version, and queues an offline update. Registered simulated devices do not receive provider coordinates; strict registry mode does not poll unregistered buses.
- **MongoDB GPS ownership and fencing:** MongoDB is authoritative for the GPS worker owner, monotonically increasing fencing token, lease, and configuration version in both `single-instance` and `redis` Socket.IO modes. GPS data writes and GPS-affecting runtime mutations update the same singleton in majority-committed transactions. Socket.IO mode controls broadcast and shared rate-limit services only; it does not select worker ownership. Graceful shutdown waits for active GPS work before conditional ownership release.
- **Single-instance Redis boundary:** `single-instance` uses the local Socket.IO adapter and does not initialize Redis clients or the Redis adapter. MongoDB ownership is still required; an unavailable or unacquired lease prevents GPS polling rather than falling back to process-local ownership.
- **Socket.IO:** Redis adapter readiness is required in Redis mode; readiness degrades with Redis. Production must explicitly select `SOCKET_IO_MODE=redis` or `single-instance`; no implicit production fallback is introduced.
- **Redis mode boundaries:** Redis is used only when `SOCKET_IO_MODE=redis` is selected, for shared Socket.IO broadcasts and shared API/audit rate-limit counters. GPS write authority remains in MongoDB. Single-instance mode uses none of these Redis services and does not attempt a Redis connection.
- **Mobile and environments:** Production builds cannot select the local/remote-test backend. IPv4 loopback handling covers all of `127.0.0.0/8`. Mobile Socket.IO manager and engine listeners are explicitly removed on cleanup; foreground reconnect requests a fresh location snapshot. Snapshots and live events carry a decimal-string location version, and the client rejects duplicate or older versions without JavaScript number precision loss.
- **GPS publication:** A bounded Mongo-backed dispatcher claims pending publication markers and emits the latest committed location with a stable event ID and version. Redis mode requires the awaited Socket.IO publication boundary at startup and awaits the adapter's underlying Redis publish command result; that confirms broker acceptance only, not delivery to any specific client. Successful broker acceptance is the publication acknowledgement boundary; failed or uncertain commands keep the marker durable and retry with capped exponential backoff, parking after a bounded number of attempts until service restart or Redis reconnect resets the retry state. Mobile snapshot recovery repairs missed events when clients reconnect; it is not proof of individual client delivery. Single-instance mode retains the local adapter invocation boundary and snapshot recovery.
- **Observability:** Structured HTTP request logs omit URLs and payloads; periodic runtime metrics cover event-loop delay, CPU, memory, Mongo readiness, Redis, socket clients, GPS worker/lease/restart state, and location-publisher drain status. Ownership transaction retries are logged without owner secrets or tokens.

## Important decisions and compatibility

- **Single-instance backend configuration:** Set `SOCKET_IO_MODE=single-instance`, `NODE_ENV=production`, `JWT_SECRET` (32+ characters recommended), and `MONGODB_URI`. Do not set `REDIS_URL` or `SOCKET_IO_REDIS_URL`; Redis is not initialized in this mode. Configure the GPS credentials and CORS origins as required by the existing deployment. `MONGODB_MAX_POOL_SIZE` and `MONGODB_WAIT_QUEUE_TIMEOUT_MS` are optional and have bounded defaults.
- `GPS_DEVICE_REGISTRY_MODE` accepts `legacy` or `strict` and defaults to `legacy` to preserve current tracking until real device IDs and bus assignments are confirmed. In legacy mode, pre-existing bus-ID matching remains active. **Do not claim source-classification guarantees until the actual physical device and simulated bus records are mapped and strict mode is enabled.**
- Root and frontend Expo identities remain unchanged. Repository configuration shows different EAS project IDs and Android package IDs: root `7bdcbf36-68e3-44bc-8060-fc6e4e889648` / `com.rajvenkadam.bts`; frontend `d2b0e413-8d33-4486-b0ca-4bbc2a04a5c4` / `com.rajvenkadam.bustracking`. Which identity has shipped cannot be determined without EAS build, release, and store history.
- The mobile client uses WebSocket-only Socket.IO transport. Any external client retaining HTTP long-polling requires load-balancer session affinity.
- New GPS-device indexes are declared in the model; no production database index build or migration was executed.
- Login attempt limiting now uses account buckets only. It still requires the MongoDB TTL index and transaction support described in [login-limiter.md](../../backend/docs/login-limiter.md). Legacy IP buckets are ignored and expire under the TTL index.

## Remaining deployment and validation requirements

| Severity | Risk / prerequisite |
|---|---|
| High | No real or controlled 10,000-client load test was run. Capacity remains unverified. |
| High | The real-versus-simulated device-to-bus mapping was not provided. Populate and verify the registry before enabling `GPS_DEVICE_REGISTRY_MODE=strict`; the default remains `legacy` to preserve current matching. |
| High | Apply the login-attempt TTL index and GPS-device unique indexes through the approved database change process in a non-production test environment before integration/load testing. No production index build or migration was run. |
| High | Redis and multi-instance behavior were not integration-tested. Configure shared Redis and explicitly select Redis mode before running multiple backend instances. |
| High | MongoDB replica-set transaction serialization and majority-write behavior for ownership activation, worker writes, and configuration mutations have not yet been verified by integration tests. Do not claim production-safe distributed fencing until those tests pass. |
| Medium | Confirm load-balancer behavior for WebSocket upgrades; external polling clients require session affinity. |
| Medium | Tune `MONGODB_MAX_POOL_SIZE` and `MONGODB_WAIT_QUEUE_TIMEOUT_MS` against the deployment's MongoDB budget and measured workload. |
| Medium | Publication is coalescing rather than a per-sample event log; clients may skip intermediate GPS samples. Socket.IO/Redis does not provide end-recipient acknowledgement here. Correctness after disconnect relies on the location snapshot requested during reconnection; durable proof of remote receipt would require an acknowledged delivery protocol. |

## Files changed in this implementation

Backend: `src/runtime.js`, `src/app.js`, `src/config/mongodb.js`, `src/config/startup.js`, `src/config/sharedServices.js`, `src/controllers/auth.controller.js`, `src/controllers/bus.controller.js`, `src/controllers/excelManagement.controller.js`, `src/controllers/gpsDevice.controller.js`, `src/controllers/importBusRoutes.controller.js`, `src/controllers/importUsers.controller.js`, `src/controllers/superadminUser.controller.js`, `src/models/BusLiveLocation.js`, `src/models/GpsDevice.js`, `src/models/GpsWorkerOwnership.js`, `src/routes/gpsDevice.routes.js`, `src/routes/superadminUsers.routes.js`, `src/services/excelUserService.js`, `src/services/gpsConfigurationBarrier.js`, `src/services/gpsService.js`, `src/services/gpsWorkerOwnership.js`, `src/services/runtimeMetrics.js`, `src/services/startServices.js`, `src/utils/loginAttemptLimiter.js`, `src/utils/readiness.js`, and `src/workers/gpsSyncWorker.js`.

Frontend/admin configuration: `frontend/src/config/backendEnvironment.cjs`, `frontend/src/context/BusContext.js`, and `docs/config.js`.

Tests and operational documentation: backend lifecycle/auth/GPS/config tests, `backend/docs/login-limiter.md`, and this scalability report. Other pre-existing dirty files were preserved and not reverted.

## Validation executed

| Validation | Result |
|---|---|
| Backend `npm test` | **252 passed, 0 failed** |
| Frontend `npm test` | **47 passed, 0 failed** |
| `node --test docs/config.test.cjs` | **5 passed, 0 failed** |
| Targeted runtime, worker, Redis, GPS, and login-limiter tests | **Passed** |
| `node --check` on edited backend JavaScript | **Passed** |
| `git diff --check` | **Passed**; Git reported only existing LF-to-CRLF notices |

No capacity/load test, remote request, live GPS provider request, Redis integration, MongoDB integration, or production migration was run. These checks are unit/static evidence only, not behavioral integration or capacity evidence. Proceed with controlled staging integration and capacity tests only after the required staging indexes and GPS mapping are prepared. Do not claim 10,000-user readiness before measured evidence exists.

## Safety and worktree confirmation

No production MongoDB, Redis, Render, or GPS provider was contacted. No deployment, staging, commit, or push was performed. The pre-existing modified and untracked worktree files were preserved.
