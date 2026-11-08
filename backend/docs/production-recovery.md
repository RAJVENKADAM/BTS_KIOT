# Production recovery: GPS ownership and login limiting

These are two independent MongoDB recovery procedures for the intended
single-instance backend. They do not require Redis. Neither procedure was
executed or verified against a live database. Use an approved operator
environment and the production database identity confirmed from trusted
deployment configuration. Never reuse staging credentials or staging scripts.

## GPS worker ownership

### Read-only target and state inspection

Before any write, confirm the production database name is exactly `bts_db` and
compare the MongoDB hostname to the value in the trusted production secret or
deployment configuration. Do not copy a URI into a command, terminal history,
ticket, or log. Connect with an approved operator tool that reads the URI from
its protected environment.

Run these read-only checks in the verified database:

```javascript
db.getName()
db.getCollectionInfos({ name: "gpsworkerownerships" })
db.gpsworkerownerships.findOne({ _id: "gps-worker" })
```

An absent collection and an existing empty collection both result in no
ownership record. The production provisioner handles either case. If the record
exists, do not proceed unless it is valid and inactive; an active or malformed
record requires investigation, not reset or deletion.

### Provisioning write

Review
[`initialize-production-gps-worker-ownership.js`](../scripts/initialize-production-gps-worker-ownership.js)
and its offline mock tests before use. It never loads `.env`. Run it only once
from an approved execution environment after setting these values there, without
echoing or exposing the URI:

- `NODE_ENV=production`
- `BTMS_PRODUCTION_DB_NAME=bts_db`
- `BTMS_PRODUCTION_MONGODB_HOST`: exact production hostname independently
  copied from trusted deployment configuration (not staging configuration)
- `BTMS_PRODUCTION_AUTH_DB`: the explicitly verified production authentication
  database selected by the URI; the URI must contain exactly one canonical
  `authSource` option matching this value and it must not be a staging database
- `MONGODB_URI`: the protected production MongoDB URI
- `BTMS_PRODUCTION_GPS_OWNERSHIP_CONFIRMATION`:
  `initialize:bts_db@<exact-production-hostname>`

The script validates every target and confirmation before constructing a
MongoDB client. It creates the collection only when absent, inserts only when
`_id: "gps-worker"` is absent, uses BSON `Long` values and majority write
concern, and verifies the inserted record. Valid inactive state is a no-op;
active or malformed state is refused. It never overwrites, releases, or resets
an existing owner. The hostname placeholder must be replaced with the exact
trusted hostname in the protected execution environment.

From the backend directory, run the reviewed script once:

```powershell
node scripts\initialize-production-gps-worker-ownership.js
```

This is a write operation, not a readiness check. After a successful report,
repeat the read-only `findOne` and confirm `_id`, BSON Int64 fields, `inactive`
state, null owner, and date fields. Then check Render logs for successful GPS
ownership acquisition followed by worker start and successful polling. If an
active/malformed record or any provisioning error is reported, stop and
investigate; do not retry by changing the record manually.

## Login limiter

The login limiter is MongoDB-backed in single-instance mode; it intentionally
fails closed with HTTP 503 and has no process-local account-attempt fallback.
Its exact required index comes from the model and migration definitions:

```text
collection: loginattemptbuckets
name: ttl_expires_at
key: { expiresAt: 1 }
expireAfterSeconds: 0
```

### Read-only checks

Using the same independently verified production target, inspect:

```javascript
db.getName()
db.getCollectionInfos({ name: "loginattemptbuckets" })
db.loginattemptbuckets.getIndexes()
db.adminCommand({ hello: 1 })
db.adminCommand({ buildInfo: 1 })
```

The topology must be a replica set or sharded cluster with sessions available
and a server version that supports transactions. A standalone server is not
sufficient. These metadata checks do not prove transaction authorization.

Verify the application's MongoDB principal can inspect the required index and
perform the bucket read/upsert/replace/delete operations. Also verify its
database role permits transactions on this database. Use the sanitized
`LOGIN_LIMITER_*` stage, MongoDB code/codeName, and safe message in application
logs to separate failures:

- `LOGIN_LIMITER_INDEX_CHECK_FAILED`: missing/misconfigured index, collection
  discovery, or `listIndexes` permission/operation failure.
- `LOGIN_LIMITER_BUCKET_UPSERT_FAILED`: bucket creation/upsert or corresponding
  write permission failure.
- `LOGIN_LIMITER_TRANSACTION_FAILED`: session/transaction startup, topology, or
  transaction operation/authorization failure.
- `LOGIN_LIMITER_TRANSACTION_TIMEOUT`: the limiter's bounded transaction
  duration elapsed; inspect MongoDB latency and transaction diagnostics.

Connected MongoDB state alone does not establish index availability, write
permissions, transaction-capable topology, or transaction authorization.

### Conditional index repair (write operation)

Do not run `migrate-login-attempts.js` against production; it is staging-only.
After independently verifying the production database identity:

1. If `loginattemptbuckets` is absent, create it only if the production change
   has been approved. Otherwise preserve the existing collection and records.
2. If `ttl_expires_at` is absent, create exactly the required index:

   ```javascript
   db.loginattemptbuckets.createIndex(
     { expiresAt: 1 },
     { name: "ttl_expires_at", expireAfterSeconds: 0 }
   )
   ```

3. If an index with that name exists but its key or TTL option differs, stop.
   Do not drop or replace it without a separate reviewed change.
4. Read `getIndexes()` again and verify the exact name, single-field key, and
   expiration option.

Index repair does not fix a standalone topology or missing transaction
permissions. For those cases, correct the production MongoDB configuration or
principal through the approved database change process; do not bypass the
limiter's transaction or fail-closed requirements. Confirm login admission
returns normal rate-limit outcomes after the correction, and confirm storage
failures still return generic HTTP 503 without account lookup/password checks.

See [`login-limiter.md`](./login-limiter.md) for account lockout policy and
bounded authentication queues. The staging migration and readiness tools are
not production procedures.
