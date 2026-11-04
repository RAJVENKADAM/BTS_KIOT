# Temporary Atlas audit endpoint

The endpoint is `POST /api/superadmin/atlas-readonly-audit`. It requires:

- A valid superadmin bearer token.
- An active, non-deleted superadmin account.
- The `BTMS_ATLAS_AUDIT_SECRET` Render environment variable, containing at least 32 UTF-8 bytes.
- The same value in the `X-BTMS-Audit-Secret` request header.

Generate a secret locally using a cryptographically secure random generator (for example, 32 random bytes encoded as base64url). Add it only to the Render environment settings and to an authorized HTTP client's secret/private environment store. Do not place it in a URL, source file, shared collection, or logged command.

From an authorized HTTP client, send one POST request to the deployed backend URL with these headers:

```text
Authorization: Bearer <superadmin-token>
X-BTMS-Audit-Secret: <secret-from-private-client-store>
```

Send no request body. The endpoint returns the sanitized audit report with `Cache-Control: no-store`; it permits one audit per superadmin per 15-minute window and rejects concurrent runs within the current Node.js process. This concurrency protection and rate limit are process-local and are not shared across multiple Render instances. The endpoint is intended for one manually initiated audit at a time; do not send concurrent requests or issue another audit while the first is running. Remove the route and the temporary `BTMS_ATLAS_AUDIT_SECRET` Render variable after the audit is complete.
