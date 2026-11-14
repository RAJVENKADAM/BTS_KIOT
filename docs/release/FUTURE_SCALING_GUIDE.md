# BTS Future Scaling Guide

## Purpose and guardrails

This guide prepares the existing BTS design for staged infrastructure upgrades without claiming a capacity that has not been measured. No load test or production deployment was performed for this release. Do not represent the system as supporting 10,000 concurrent users unless a representative, approved load test demonstrates that result.

## Stage 1 — Current infrastructure

### Operating shape

- One backend instance is the supported current operating shape. Run one instance when using `SOCKET_IO_MODE=single-instance`; process-local coordination is not a distributed lock.
- MongoDB remains the application store. The backend reuses the Mongoose connection and validates `MONGODB_MAX_POOL_SIZE` (default 100, range 1–500) and `MONGODB_WAIT_QUEUE_TIMEOUT_MS` (default 10,000 ms, range 1–120,000 ms).
- Existing GPS provider integration is retained. The GPS worker polls every 35 seconds, has a 10-second provider timeout by default, and uses MongoDB lease/fencing and configuration revisions. Its timestamps/freshness rules must not be weakened to improve apparent availability.
- GPS polling and assignment propagation are bounded background workers. The assignment outbox is durable; event publication and a client's successful receipt remain separate outcomes.
- The app can run without Docker or a new paid dependency. Do not add Redis, an extra worker service, or a cache solely for anticipated scale.
- Keep current role/assignment checks, idempotency, revision checks, rate limits, payload limits, and graceful shutdown behavior.

### Known single-instance limitations

- One application process is a single compute and failure domain. A process restart interrupts live socket connections; clients must reconnect and reconcile authorized snapshots.
- Socket.IO rooms, default rate limiting, and in-process lifecycle state are not shared across multiple app instances unless the Redis mode is explicitly configured.
- The GPS ownership lease fences the GPS worker but is not a replacement for distributed Socket.IO room state or globally coordinated API rate limits.
- A larger MongoDB pool can increase database connection pressure rather than improve throughput. Request concurrency, transaction work, indexes, query shape, and server-side capacity must be measured together.
- The GPS provider and one inactive real device limit freshness independently of backend health. Do not simulate provider activity.

### Stage 1 operating checklist

1. Keep one backend instance and use the explicitly selected socket mode for that deployment.
2. Set only validated environment-variable names documented by the application; keep credentials in the deployment secret store, not source control.
3. Keep production `autoIndex` behavior unchanged. Review [MONGODB_INDEX_DEPLOYMENT.md](./MONGODB_INDEX_DEPLOYMENT.md), preflight duplicates, and deploy indexes through an approved staging/maintenance procedure.
4. Observe API latency/error rates, MongoDB pool wait time, query plans, GPS freshness/lease health, and outbox age before changing resource sizes.
5. Exercise the controlled pilot checklist before increasing user count.

## Stage 2 — Future paid infrastructure

### Upgrade sequence

1. **Measure a baseline.** Use representative synthetic workloads and record request mix, concurrent sockets, payload sizes, MongoDB reads/writes, transaction duration, query plans, pool wait, event-loop lag, GPS cycle duration, and outbox backlog.
2. **Right-size the backend resource.** Increase Render CPU/memory only when measurements show resource saturation. Re-run the same workload and compare p50/p95/p99 latency, error rate, restart behavior, and cost.
3. **Right-size MongoDB Atlas.** Evaluate tier, connection capacity, storage, IOPS/throughput, working-set fit, and transaction limits from measured utilization. Confirm backup/restore and point-in-time recovery requirements before a tier or topology change.
4. **Tune connection pools deliberately.** Validate `MONGODB_MAX_POOL_SIZE` and `MONGODB_WAIT_QUEUE_TIMEOUT_MS` against the selected Atlas connection limit and total backend instance count. Estimate worst-case application connections as the sum of pool maxima across processes, then leave headroom for administration, monitoring, and failover. Do not raise pool size as a substitute for finding slow or unindexed queries.
5. **Add backend instances only with shared-state readiness.** Set `SOCKET_IO_MODE=redis` and configure `SOCKET_IO_REDIS_URL` or `REDIS_URL` through secret management, then verify the Redis Socket.IO adapter is ready, shared rate limiting works, load-balancer WebSocket behavior is correct, and reconnect snapshots reauthorize current assignments.
6. **Keep one GPS owner unless separation is justified.** If the GPS worker is moved to a separate process/service, preserve its MongoDB lease, fencing token, freshness checks, durable publication markers, shutdown/release behavior, and operational observability. Do not provision multiple independent pollers without a tested ownership design.
7. **Add alerting and recovery evidence.** Test MongoDB failover, Redis interruption, backend restart, stale GPS, lease loss, outbox retry/dead-letter, and backup restoration in staging before production rollout.
8. **Load test each planned step.** Define arrival rates, concurrent sockets, realistic API mix, GPS event cadence, test data scale, duration, and pass/fail SLOs in advance. Increase traffic gradually; stop on error, saturation, data-isolation, or stale-location regressions.

### Configuration and migration risks

| Area | Configuration or decision | Risks and required evidence |
|---|---|---|
| Render backend | Instance count and CPU/memory are deployment choices, not source-code constants. | Multiple instances require shared socket transport and rate-limit state; verify sticky/WebSocket behavior and graceful drain. |
| MongoDB Atlas | Select tier, connection limits, storage, IOPS, and backup/restore objectives from observed demand. | Connection multiplication, transaction contention, storage/index growth, failover latency, and cost. Verify with a staging replica set and load test. |
| MongoDB pool | `MONGODB_MAX_POOL_SIZE`, `MONGODB_WAIT_QUEUE_TIMEOUT_MS` | A per-process pool limit multiplies by process count; compare with Atlas limits and headroom. |
| Socket.IO scale-out | `SOCKET_IO_MODE=redis`, `SOCKET_IO_REDIS_URL` or `REDIS_URL` | Redis outage affects cross-instance publication and shared rate limits. Confirm failure is surfaced, reconnect snapshots recover, and assignment revocation remains authoritative. |
| GPS worker placement | Existing lease/fencing settings, including `GPS_WORKER_LEASE_TTL_MS` | Lease expiry, clock/timeouts, worker drain, and provider rate limits. Verify no duplicate owner and no timestamp-watermark regression. |
| Background processing | Decide only from measured queue age and worker utilization whether to separate workers. | Preserve transactional outbox creation, idempotent delivery, ordering/version guards, retries, and dead-letter repair. |
| API protection | Keep current request limits and input-size bounds unless a measured, reviewed change is approved. | Do not increase limits to hide saturation; keep rate-limit state shared in multi-instance mode. |

### Monitoring and alerting

Before any scale-out, collect and alert on:

- API request volume, p50/p95/p99 latency, 4xx/5xx rates, timeout rate, and rate-limit outcomes, segmented by route without logging credentials or personal data.
- Process CPU/memory, event-loop lag, restarts, graceful-shutdown duration, active sockets, reconnect rates, and WebSocket upgrade failures.
- MongoDB operation latency, query keys/documents examined, pool checked-out/waiting connections, transaction retries/aborts, connection failures, storage, IOPS, and replication/failover health.
- GPS cycle duration and outcome, provider timeout/error counts, timestamp age/rejections, last accepted sample per configured real device, ownership renewals/fencing failures, and durable publication backlog. Do not log provider secrets or coordinates unnecessarily.
- Assignment outbox oldest age, pending/processing/dead-letter counts, lease losses, retries, and delivery acknowledgements available at each boundary.
- Redis connection/readiness, adapter publication acceptance, shared limiter errors, and recovery generation.
- Backup completion, restore-test results, and time to meet approved recovery point/time objectives.

Use synthetic identifiers in dashboards. Restrict access to operational telemetry and set retention based on policy.

### Load-test and rollout acceptance

- Build a workload from observed pilot/API behavior, including authorized student snapshots, map/socket updates, administrator mutations, imports, reconnects, and GPS cadence.
- Verify assignment isolation and room revocation under concurrent reassignment, not just aggregate throughput.
- Track database connection use and query plans while testing; include warm-up, steady-state, spike, soak, and recovery phases.
- Define target SLOs and abort thresholds with the KIOT owner before the test. Record test scripts, environment sizing, data volume, test duration, run IDs, and results.
- Do not infer a production capacity from a local MongoDB replica-set test or a single successful smoke test.

## Release-state evidence

For this engineering pass, a loopback-only MongoDB replica set was used for transaction and index checks. No external service, Atlas deployment, Render resource, production data, or production index migration was used. Automated verification does not establish real-device GPS freshness, pilot success, production stability, or a concurrent-user capacity.
