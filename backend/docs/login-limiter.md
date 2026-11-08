# Shared login attempt limiting

The login controller uses MongoDB-backed per-account reservations; it does not
throttle by `req.ip`. Account buckets count pending reservations and completed
failures together against the account limit. Reservations and failures are
distinct states: pending reservations expire quickly, failed attempts use the
configured failure window, and a successful login clears failures for that
account while preserving other pending requests.

Not applying a concurrent-login cap to IP addresses is intentional: many
students can share one campus NAT or reverse-proxy address. A shared IP must
not serialize otherwise independent accounts or cause a campus-wide burst to
receive 429 responses. Brute-force protection remains account-scoped, while
bounded local authentication/password queues cap CPU and database work.
Account reservations are shared transactionally across instances. Existing
legacy `ip:` buckets are no longer read or written and expire through the
existing TTL index.

Reservations update shared MongoDB buckets in a transaction, so replicas do
not bypass account limits. The limiter intentionally fails closed with HTTP
503 when MongoDB is unavailable, the TTL index is missing, or the MongoDB
deployment does not support transactions. There is no process-local fallback.

## Database prerequisite

Before enabling login traffic, configure the exact staging database and Atlas
host. The migration does not use the backend's implicit MongoDB configuration
fallback. It requires `BTMS_DATABASE_ENVIRONMENT=staging`,
`BTMS_STAGING_DB_NAME=bts_staging_db`, `BTMS_STAGING_MONGODB_HOST` set to the
approved staging host, and a URI selecting that exact host and database.
Production `NODE_ENV` and `authSource=bts_db` are rejected. The explicit
confirmation repeats the operation and target:

```powershell
npm run db:migrate:login-attempts -- up --confirm=up:bts_staging_db@rajvenkadam.hm6bni0.mongodb.net
```

The migration creates `loginattemptbuckets` and its `expiresAt` TTL index. It
does not delete existing data. To roll back the index only, confirm the
`down` operation and the same target:

```powershell
npm run db:migrate:login-attempts -- down --confirm=down:bts_staging_db@rajvenkadam.hm6bni0.mongodb.net
```

Rollback verifies the exact index name, key, and options before dropping only
that index; a mismatch is refused. It intentionally leaves the collection and records intact. Login
requests fail closed after the cached index check expires (within five seconds)
until the index is restored. The MongoDB deployment must
be a replica set or sharded cluster with transaction and index-management
permissions. The migration and transaction behavior were not verified against
a live MongoDB deployment in this phase.

## Optional limits and queue bounds

Defaults use a 15-minute failure window, 10 account reservations/failures,
and a 2-minute pending reservation lifetime. Optional environment variables:

| Variable | Default | Allowed range |
|---|---:|---:|
| `LOGIN_ATTEMPT_WINDOW_MS` | `900000` | 1–86400000 |
| `LOGIN_MAX_ACCOUNT_FAILURES` | `10` | 1–100 |
| `LOGIN_PENDING_RESERVATION_TTL_MS` | `120000` | 1–300000 |
| `LOGIN_LIMITER_HASH_SECRET` | `JWT_SECRET` | non-empty secret |
| `AUTH_MAX_CONCURRENT_OPERATIONS` | `8` | 1–64 |
| `AUTH_MAX_QUEUED_OPERATIONS` | `64` | 0–512 |
| `AUTH_MAX_CONCURRENT_PASSWORD_CHECKS` | `4` | 1–64 |
| `AUTH_MAX_QUEUED_PASSWORD_CHECKS` | `64` | 0–512 |
| `AUTH_QUEUE_WAIT_MS` | `30000` | 1–120000 |
| `AUTH_PASSWORD_QUEUE_WAIT_MS` | `AUTH_QUEUE_WAIT_MS` | 1–120000 |

Invalid numeric values stop backend startup rather than silently changing
limits. Keep `LOGIN_LIMITER_HASH_SECRET` stable across replicas and restarts;
if it is not set, `JWT_SECRET` is used. Rotating the effective HMAC secret
changes bucket identifiers and resets the active rate-limit history.

Login admission does not depend on forwarded or direct IP identity. Other
API rate limits still use authenticated user identity when available and
otherwise use `req.ip`. By default the app trusts no forwarded addresses. Set
`TRUSTED_PROXY_CIDRS` only after verifying the ingress addresses and ensuring
direct access to the backend is blocked. See [proxy-trust.md](./proxy-trust.md);
the production ingress topology is not established by this repository.

## Safe local verification

`npm test` runs only files under `backend/test/`; standalone load-test scripts
are excluded. No load test or remote request is part of this verification.
