# Read-only staging database readiness verification

Run this check only against an explicitly identified staging MongoDB database.
It reads server build/topology metadata, collection names, and index metadata
for `loginattemptbuckets` and `gpsdevices`. It does not create collections or
indexes, run migrations, or modify documents. Use the least-privileged staging
account available; index visibility depends on its effective privileges.

The verifier requires all of these conditions before constructing a client:

- `NODE_ENV` is not `production`.
- `BTMS_DATABASE_ENVIRONMENT=staging`.
- `MONGODB_URI` resolves to the exact `BTMS_STAGING_DB_NAME`.
- `BTMS_STAGING_MONGODB_HOST` exactly matches the hostname in `MONGODB_URI`.
- The known production database name `bts_db` is explicitly refused even if
  the staging marker is set incorrectly.

The verifier never prints `MONGODB_URI`, usernames, passwords, or connection
errors' message text. It loads the existing `backend/.env` configuration and
requires explicit staging identity to be supplied by the environment:

```powershell
Set-Location 'E:\My Works\College Products\BTS\backend'
$env:BTMS_DATABASE_ENVIRONMENT = 'staging'
$env:BTMS_STAGING_DB_NAME = '<exact staging database name>'
$env:BTMS_STAGING_MONGODB_HOST = '<exact staging MongoDB hostname>'
$env:BTMS_STAGING_DNS_SERVERS = '8.8.8.8'
node scripts\verify-staging-readiness.js
```

The selected database must match both the explicit staging database name and
hostname. If either does not match, verification stops before connecting.

The check reports MongoDB version, topology, session availability, whether
transactions are supported by topology and server version, target database,
the presence and indexes of the login limiter and GPS registry collections,
and whether required indexes match the application declarations. A missing
collection or index is reported only; nothing is provisioned automatically.

Collection discovery uses
`listCollections({}, { authorizedCollections: true, nameOnly: true })`,
allowing a database-scoped read-only user to enumerate collections it can
access. Atlas error `8000` on `listIndexes` means the current principal is not
authorized to inspect that collection's index metadata. The observed denial
means the effective Atlas permissions do not authorize index inspection for
that collection; it does not by itself establish that every Atlas `readWrite`
assignment behaves the same way. In that case the verifier reports index
status `NOT_VERIFIED`, preserves the numeric error code, and does not ask for
broader privileges. It does not call `listIndexes` for a collection that is
not visible.
