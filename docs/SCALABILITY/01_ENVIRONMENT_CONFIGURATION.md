# BTMS environment configuration

This configuration separates unit tests, local services, local mobile devices,
production, and explicitly opted-in remote Render checks. No application
component should select a backend host independently.

## Mobile environment selector

`frontend/src/config/backendEnvironment.cjs` resolves one backend origin;
`API_BASE_URL` and `SOCKET_BASE_URL` export that same result. REST and
Socket.IO therefore use the same environment.

| Environment | Selection | Backend |
|---|---|---|
| Unit tests / development default | `EXPO_PUBLIC_BTMS_ENV=local`, or unset outside a production build | Android emulator: `http://10.0.2.2:5000`; other platforms: `http://127.0.0.1:5000` |
| Physical Android device | `EXPO_PUBLIC_BTMS_ENV=local` and `EXPO_PUBLIC_API_BASE_URL=http://<private-LAN-IPv4>:5000` | A developer machine's private LAN address |
| Production build | `EXPO_PUBLIC_BTMS_ENV=production`, or production `NODE_ENV` | Existing `https://bts-kiot.onrender.com`; non-Render overrides are rejected |
| Remote Render test | `EXPO_PUBLIC_BTMS_ENV=remote-test` and `EXPO_PUBLIC_ALLOW_REMOTE_TESTS=YES` | Existing Render origin; this is a deliberate remote opt-in, not a local test mode |

Example local Android emulator session:

```powershell
Set-Location 'E:\My Works\College Products\BTS\frontend'
$env:EXPO_PUBLIC_BTMS_ENV = 'local'
Remove-Item Env:\EXPO_PUBLIC_API_BASE_URL -ErrorAction SilentlyContinue
npm run start
```

For a physical Android device, use the machine's private LAN IPv4 address in
`EXPO_PUBLIC_API_BASE_URL`; ensure the phone and development machine can reach
each other and the backend port is allowed by the local firewall. Do not use
the Render URL in local or unit-test configuration.

Unit tests run with `frontend/test-bootstrap.cjs`, which selects `local` and
removes remote target overrides. Tests use injected/local logic and make no
Render requests.

## Backend unit and integration environments

`npm test` uses `backend/test/bootstrap.cjs`. It sets `NODE_ENV=test` and
`TEST_ENVIRONMENT=unit`, selects explicit single-instance Socket.IO, and
removes database, Redis, GPS-provider, JWT, email, and superadmin credentials
from the test process. Unit tests do not load `.env`.

Database connection helpers refuse connections in unit-test mode. Local
integration tests may opt in only with `TEST_ENVIRONMENT=local-integration`,
a loopback MongoDB URI, and a database named `btms_test` or
`btms_test_<suffix>`. Example:

```powershell
Set-Location 'E:\My Works\College Products\BTS\backend'
$env:NODE_ENV = 'test'
$env:TEST_ENVIRONMENT = 'local-integration'
$env:MONGODB_URI = 'mongodb://127.0.0.1:27017/btms_test_phase1'
$env:DB_NAME = 'btms_test_phase1'
$env:SOCKET_IO_MODE = 'single-instance'
npm run start
```

Local integration mode never starts the GPS worker, even if a developer's
ignored `.env` contains GPS credentials. To test Redis adapter behavior, use a
local Redis service and explicitly set `SOCKET_IO_MODE=redis` plus
`SOCKET_IO_REDIS_URL=redis://127.0.0.1:<port>`. No local MongoDB or Redis
integration service was started as part of this phase.

The backend CLI loads `.env` only when `server.js` is the process entrypoint.
Importing the app, creating the Express application, or requesting health
endpoints does not load `.env`, connect to a dependency, start workers, or call
the GPS provider. When running local integration, explicitly set the dedicated
MongoDB URI before starting the CLI; the guard rejects non-loopback or
non-`btms_test` targets.

## Static admin dashboard

The static dashboard reads one configuration from `docs/config.js`. GitHub
Pages/non-local origins default to the existing Render production API.
Dashboard pages served from loopback or a private LAN address default to the
same host on port 5000. Opening a local dashboard file directly fails closed
instead of silently selecting production.

The optional `btmsEnvironment=remote-test&allowRemoteTests=YES` query flags
make Render selection explicit. The dashboard includes mutating admin
operations; do not use that mode for smoke tests unless the account and data
are explicitly test-safe. No remote dashboard request was made.

## Remote Render test controls

Remote checks are distinct from unit/local integration tests and exercise the
currently deployed Render code, not unpushed source. The mobile configuration
requires both `EXPO_PUBLIC_BTMS_ENV=remote-test` and
`EXPO_PUBLIC_ALLOW_REMOTE_TESTS=YES`; remote mode targets only the existing
Render origin. Use dedicated test identities and records, and avoid writes to
real student, bus, route, or GPS data. Production-target capacity runners
remain blocked; this setting does not authorize a load test.

No remote Render smoke, login, bus-data, or Socket.IO test was run.

## Expo configuration

The frontend package scripts run Expo with `frontend/` as the project root.
Running the installed Expo CLI from that directory resolved
`frontend/app.json` and reported SDK 58. The frontend package is the source of
the dependency set; `frontend/eas.json` is the matching EAS profile file.
There is no checked-in build workflow, `eas-cli` dependency, or recorded build
command proving which EAS profile produced a prior artifact.

The root `app.json` and root `eas.json` contain different project/package
identifiers. They were not changed because the repository does not establish
whether they are stale, used by another app, or tied to a published EAS
project. Do not switch identifiers or remove the root files until build
history/ownership is confirmed. Use `frontend/` as the project directory for
the existing `npm run start`, `npm run android`, and `npm run web` scripts.
