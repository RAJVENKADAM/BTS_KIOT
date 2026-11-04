# Temporary Atlas audit endpoint

The endpoint is `POST /api/superadmin/atlas-readonly-audit`. It requires:

- A valid superadmin bearer token.
- An active, non-deleted superadmin account.
- `BTMS_ATLAS_AUDIT_INSTANCE_ID` set in Render to the `RENDER_INSTANCE_ID` of exactly one designated instance.
- The `BTMS_ATLAS_AUDIT_SECRET` Render environment variable, containing at least 32 UTF-8 bytes.
- The same value in the `X-BTMS-Audit-Secret` request header.

The endpoint fails closed unless the request reaches the designated instance. Requests routed to another instance return `503`; retry manually only if needed. The in-process concurrency guard and per-user limiter then apply on the designated instance. Do not configure more than one designated instance.

Generate a secret locally using a cryptographically secure random generator (for example, 32 random bytes encoded as base64url). Add it only to the Render environment settings and to an authorized HTTP client's secret/private environment store. Do not place it in a URL, source file, shared collection, or logged command.

From an authorized HTTP client, send one POST request to the deployed backend URL with these headers:

```text
Authorization: Bearer <superadmin-token>
X-BTMS-Audit-Secret: <secret-from-private-client-store>
```

Send no request body. The endpoint returns the sanitized audit report with `Cache-Control: no-store`; it permits one audit per superadmin per 15-minute window and rejects concurrent runs on the designated instance. Remove the route and both temporary Render environment variables after the audit is complete.
