# BTMS student load test

This manual runner models exactly 20 existing student accounts. It uses the
backend's current contracts:

- `POST /api/auth/login`
- `GET /api/bus/get-all-buses`
- `GET /api/bus/routes/:busNo`
- `GET /api/bus/location/:busNo`
- Socket.IO authentication with `auth: { token }`, `join-bus`,
  `request-bus-location`, `locationUpdate`, and `leave-bus`
- `POST /api/auth/logout`

The read-only API calls are GET requests. Login issues JWTs, and logout is a
stateless POST that returns success without revoking those JWTs. The runner
disconnects its local sockets and stops using the tokens, but server-side token
validity continues until expiry. It does not create, update, or delete
accounts, and does not issue administrative requests. The five-minute socket
window includes one controlled reconnect per connected client. No test starts
automatically.

## Prepare accounts safely

`backend/load-tests/accounts.json` must contain exactly 20 distinct, active
student test accounts in the shape `{ "accounts": [{ "email": "...",
"password": "..." }] }`. Keep the file local; it is excluded by this folder's
`.gitignore`. Use dedicated non-personal test identities, unique credentials,
and valid bus assignments where possible. Never use real student passwords or
commit/share this file. The runner validates the account count and entry shape
without printing credentials, emails, tokens, response bodies, or names. Do not
replace or regenerate an already populated accounts file for this test.

## Target safety and Render production confirmation

The default target is `http://127.0.0.1:5000`. The known production host and
other hosts containing `prod` / `production` are blocked. The exact Render
origin `https://bts-kiot.onrender.com` is permitted only with the dedicated
`BTMS_LOAD_TEST_PRODUCTION_CONFIRMATION` value shown below; the staging
confirmation flag alone cannot authorize production. Other remote URLs require
`BTMS_LOAD_TEST_CONFIRM_STAGING=YES`.

The script cannot verify which database the deployed backend uses or whether
Render's configured service is currently production. Confirm the URL and
deployment identity independently. Running this test creates load on the
deployed service: 20 concurrent password checks, read queries, sockets, and
location requests can affect real users and may trigger service limits. Choose
a low-traffic window and monitor Render. Do not run during incidents or peak
usage.

The runner limits itself to 20 accounts, 20 simultaneous login attempts, no
more than 20 concurrent API requests, and 20 socket clients. It makes no
retries for HTTP requests. Summary timings include average and nearest-rank
p50/p95/p99 per API operation. Failure details identify clients only by
`Client 01` through `Client 20`. Socket lifecycle diagnostics use temporary
Socket.IO IDs and sanitized reasons/descriptions; they do not include account
data, JWTs, or location payloads.

## Run manually in PowerShell

```powershell
Set-Location 'E:\My Works\College Products\BTS\backend'

# This explicitly authorizes the known Render production origin.
# Do not execute until you have reviewed the risks and approved the production test.
$env:BTMS_LOAD_TEST_BASE_URL = 'https://bts-kiot.onrender.com'
$env:BTMS_LOAD_TEST_PRODUCTION_CONFIRMATION = 'I_APPROVE_20_STUDENT_LOAD_TEST_ON_PRODUCTION'

try {
    node --check .\load-tests\student-load-test.js
    if ($LASTEXITCODE -ne 0) { throw 'Syntax check failed; load test was not started.' }

    node .\load-tests\student-load-test.js
    $testExitCode = $LASTEXITCODE
}
finally {
    Remove-Item Env:\BTMS_LOAD_TEST_BASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:\BTMS_LOAD_TEST_PRODUCTION_CONFIRMATION -ErrorAction SilentlyContinue
}

if ($testExitCode -ne 0) { exit $testExitCode }
```

The runner uses Node's built-in `fetch` and the existing `socket.io-client`
dependency from `frontend/package.json`; no new package installation is needed
when frontend dependencies are already installed. It takes at least five
minutes plus connection, API, and logout time.
