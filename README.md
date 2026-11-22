# Bus Tracking and Management System (BTMS)

BTMS is a full-stack campus bus operations platform for:

- Students tracking their assigned bus.
- Primary administrators viewing and managing the active fleet.
- Super administrators managing users, buses, routes, assignments, GPS devices, plans, and bus changes.
- GPS providers publishing live bus locations.

The repository contains an Expo/React Native client, an Express/Node.js API, MongoDB persistence, Socket.IO live events, a static super-admin web dashboard, and operational scripts for migrations and production readiness.

## 1. Repository overview

| Component | Location | Purpose |
|---|---|---|
| Mobile and web client | `frontend/` | Expo app for Android, iOS, and Expo web |
| Backend API and real-time server | `backend/` | Express REST API, JWT authentication, MongoDB models, Socket.IO |
| Super-admin dashboard | `docs/` | Static browser dashboard served separately or through GitHub Pages |
| Public product/guide page | `btms_web.html` | Static landing page describing BTMS |
| Bus route spreadsheets | `Bus Routes/` | Source Excel route workbooks |
| Root deployment metadata | `app.json`, `eas.json` | Expo/EAS application configuration |
| Load and reliability tests | `backend/load-tests/` | Login, student, and capacity test scripts |

`admin-dashboard/` exists in the repository but contains no current implementation files. The maintained super-admin dashboard is `docs/index.html`.

## 2. How the complete system works

### Login and session flow

1. The user enters an email and password in the Expo login screen.
2. `POST /api/auth/login` verifies the account and bcrypt password hash.
3. The backend rejects deleted or inactive accounts.
4. A signed JWT is returned with a 24-hour lifetime.
5. The mobile app stores the token and cached user data:
   - SecureStore is used on native platforms.
   - AsyncStorage is used as the web fallback and as cached user data.
6. On startup and every five minutes, the app verifies the JWT and account state through `GET/POST /api/auth/verify`.
7. Expired, invalid, deleted, or deactivated sessions are cleared and the app returns to the login screen.
8. Logout notifies the backend and clears local authentication storage.

Login protection is account-oriented: normalized email identities are tracked in MongoDB. The default is 10 failed or pending attempts in a 15-minute window. The window, account limit, and pending reservation lifetime can be configured with environment variables.

The backend also applies a general API limit of 300 requests per 15-minute key/window. In Redis mode, shared API and audit limits can be stored across instances.

### Role model

| Role | Mobile app access | Primary permissions |
|---|---|---|
| `student` | Live tracking of the assigned bus | View assignment, route stops, live location, notifications, and profile |
| `primary_admin` | Fleet/operator views | View all buses and plans, select a bus for tracking, and view routes |
| `superadmin` | Mobile and static web console | Manage users, buses, plans, route mappings, GPS devices, imports, changes, and system operations |

JWT middleware re-loads the current role and account state from MongoDB on protected requests. Deactivating or deleting an account therefore revokes access even before the mobile app's periodic verification.

Super-admin login from the mobile app is deliberately blocked; super-admin management is available through the web dashboard.

### Live bus assignment for students

1. After login, `BusContext` calls `/api/bus/my-assignment` for a student.
2. The backend resolves the user's bus assignment from the user's `bus_no` and current plan mappings.
3. The student receives an effective preview number and resolved route stops.
4. The app joins preview-specific Socket.IO rooms instead of relying on a broad fleet-room model.
5. Assignment changes and location changes arrive through `assigned-bus-update` and `locationUpdate` events.
6. The app validates provider timestamps and coordinates and labels GPS data as fresh, stale, or unavailable.

The main map is an OpenStreetMap/Leaflet view hosted inside a WebView. The fixed college reference point is:

- Latitude: `11.554528`
- Longitude: `78.019759`

The app calculates distance to the college, monitors GPS freshness, reconciles delayed snapshots against live events, and does not show stale coordinates as the latest position.

### Fleet tracking for administrators

Administrators can:

- Load the complete active fleet.
- Search or select buses.
- Track a bus by preview number.
- View live bus location by bus number or preview number.
- Join and leave bus-specific realtime rooms.
- Refresh bus and GPS state when the app foregrounds.
- Receive socket notifications when plans or assignments change.

Bus state is cached locally for non-student users. Cached data is presentation-only and is refreshed by backend requests and realtime events.

### Buses, plans, routes, and replacements

The backend supports four named service plans: `PLAN A`, `PLAN B`, `PLAN C`, and `PLAN D`.

Administrators can:

- Set one plan as the global active plan.
- Add, update, activate, deactivate, delete, alter, or restore buses.
- Change a bus number or preview number.
- Add details such as registration number and GPS device association.
- Store route stops and ordered stop coordinates.
- Create plan mappings made from route clusters.
- Identify a root bus, location bus, and member buses for a cluster.
- Create replacement-route behavior between buses.
- Apply temporary bus changes and roll them back.

Plan mappings are optimistic-concurrency protected. Mutations use an expected resource version and many mutations support an idempotency key. Assignment propagation is processed through MongoDB outbox/replay records, including replay handling for failed or interrupted jobs.

### GPS ingestion

The backend has a GPS service and worker responsible for polling or receiving provider data, updating bus live locations, publishing Socket.IO events, and rejecting stale or invalid coordinates.

GPS behavior includes:

- `GPS_OFFLINE_THRESHOLD_MS`, defaulting to three minutes.
- Provider timeout handling.
- GPS worker ownership leases so only one application instance owns the worker in a clustered deployment.
- Strict or legacy device-registry modes.
- A dedicated assignment propagation worker.
- Redis transport publication for clustered Socket.IO deployments.

In production, GPS credentials and worker ownership must be provisioned explicitly. The worker can be disabled for unit tests or local integration environments.

### Excel and workbook imports

Supported import workflows accept JSON spreadsheet rows or Excel uploads.

User imports can:

- Create or update users.
- Assign roles and bus numbers.
- Normalize imported values.
- Process imports in chunks.
- Track import operations and row-level results.
- Reserve import capacity to avoid concurrent overload.
- Record each import in an import ledger.

Bus-route imports can:

- Parse route spreadsheets.
- Import ordered stops.
- Update route data for buses.
- Combine/alter a bus from workbook data.
- Store coordinate-sheet data in the stop master.

Uploads are limited to Excel documents and JSON payloads have component-specific size limits.

### Notifications

The Notification model stores inbox messages for each user.

Users can:

- Load all notifications.
- Check unread count.
- Mark one notification read.
- Mark all notifications read.
- Delete one notification.
- Delete the complete inbox.

Socket events can insert or refresh notifications in realtime.

### Mobile app functions

The mobile app exposes these main screens:

- **Splash**: determines whether a persisted session can be restored.
- **Login**: email/password sign-in with password visibility and network error handling.
- **Home**: live map, assigned bus, GPS status, bus search, route details, distance, notifications, and profile navigation.
- **Profile**: account details, bus assignment, logout, and server-side profile refresh.
- **Notifications**: chronological inbox grouped by date, with read/delete controls.
- **Plan details**: active plan, bus list, ordered route stops, replacement status, and route-selection labels.
- **Plan mapping**: super-admin-only cluster and route mapping interface.
- **Organize**: user and bus administration views for applicable admins.

The app handles app foreground/background transitions by pausing or reconnecting Socket.IO and reducing stale socket activity.

## 3. Architecture

```text
Expo / React Native client
        |
        | HTTPS REST + Authorization: Bearer <JWT>
        v
Express HTTP application
        |
        +--> Authentication, role middleware, validation, imports
        +--> Bus, plan, route, notification, user, and GPS controllers
        +--> MongoDB Mongoose models
        |
        +--> Socket.IO
                  |
                  +--> Browser/mobile realtime location and notification events
                  +--> Optional Redis publisher/subscriber adapter

MongoDB
  +--> Users
  +--> Buses and live locations
  +--> Bus routes and stop master
  +--> Plan mappings and revisions/audits
  +--> Notifications
  +--> Excel/import ledgers
  +--> Login attempt buckets
  +--> GPS worker ownership
  +--> Assignment propagation outbox/replay
  +--> Mutation idempotency records
  +--> Administrative change audits
```

The backend runtime initializes:

1. Configuration validation.
2. Express middleware and REST routes.
3. HTTP server.
4. Socket.IO authentication and handlers.
5. Optional Redis/Socket.IO cluster transport.
6. MongoDB-dependent GPS and assignment workers.
7. Runtime metrics.

Health and readiness endpoints:

- `GET /health`: process-level service check.
- `GET /ready`: database, GPS worker/publisher, socket client, and Redis-cluster readiness.

Production startup requires `JWT_SECRET` and `MONGODB_URI`.

## 4. Backend REST API

All API endpoints are under `/api` unless a health route is stated otherwise.

### Authentication

| Method | Endpoint | Access | Function |
|---|---|---|---|
| `POST` | `/api/auth/login` | Public | Login and JWT creation |
| `GET/POST` | `/api/auth/verify` | Public | Verify token validity and current account state |
| `GET` | `/api/auth/profile` | Authenticated | Read profile |
| `POST` | `/api/auth/logout` | Authenticated | Logout |
| `DELETE` | `/api/auth/account` | Authenticated | Delete own account |

### Users and imports

| Method | Endpoint | Access | Function |
|---|---|---|---|
| `GET` | `/api/superadmin/users` | Super admin | List users |
| `POST` | `/api/superadmin/users/bulk-role` | Super admin | Bulk role updates |
| `PUT` | `/api/superadmin/users/:id` | Super admin | Update a user |
| `DELETE` | `/api/superadmin/users/:id` | Super admin | Delete a user |
| `DELETE` | `/api/superadmin/users` | Super admin | Bulk delete users |
| `POST` | `/api/superadmin/import-users` | Super admin | Import JSON workbook rows |
| `POST` | `/api/superadmin/import-users-excel` | Super admin | Upload and import an Excel workbook |
| `GET` | `/api/superadmin/imports/:uploadId` | Super admin | Read an import operation |

### Buses and plans

| Method | Endpoint | Access | Function |
|---|---|---|---|
| `GET` | `/api/bus/get-all-buses` | Admin | List the fleet |
| `GET` | `/api/bus/my-assignment` | Authenticated | Resolve the student's assigned bus |
| `GET` | `/api/bus/location/:busNo` | Student/Admin | Read live bus location |
| `GET` | `/api/bus/track-by-preview/:previewNumber` | Admin | Select bus by preview number |
| `GET` | `/api/bus/global-plan` | Authenticated | Read the active global plan |
| `PUT` | `/api/bus/global-plan` | Super admin | Set the active global plan |
| `GET` | `/api/bus/plan-buses/:plan` | Admin | List buses in a plan |
| `GET` | `/api/bus/routes/:busNo` | Student/Admin | Read route stops |
| `PUT/POST/DELETE` | `/api/bus/...` | Super admin | Bus number, preview, details, alteration, activation, and deletion operations |

### Mappings and operational buses

| Method | Endpoint | Access | Function |
|---|---|---|---|
| `GET/POST` | `/api/bus/plan-mappings` | Super admin | Read or save plan mappings |
| `PUT` | `/api/bus/plan-mappings/:clusterId/routes` | Super admin | Update cluster routes |
| `DELETE` | `/api/bus/plan-mappings/:clusterId` | Super admin | Delete a cluster |
| `GET` | `/api/bus/plan-mapping-audit` | Super admin | Read mapping audit history |
| `GET` | `/api/bus/assignment-propagation-jobs` | Admin/Super admin | Inspect assignment propagation |
| `POST` | `/api/bus/assignment-propagation-jobs/:jobId/replay` | Super admin | Replay a propagation job |

### Notifications, GPS, Excel management, and stops

- `/api/notifications/*`: list, unread count, mark read, and delete notifications.
- `/api/superadmin/gps-devices`: list and update configured GPS devices.
- `/api/excel-management/*`: list, inspect, list users for, and delete Excel import uploads.
- `/api/stops/coordinates`: read/import the stop-master coordinate sheet.
- `/api/bus/import-routes`: import bus-route workbook JSON.
- `/api/superadmin/atlas-readonly-audit`: run the super-admin Atlas read-only audit.

Protected mutations reject missing, invalid, or expired bearer tokens and enforce role checks before controllers execute.

## 5. Socket.IO realtime behavior

The server exposes Socket.IO at the root namespace using the `/socket.io` path.

Socket authentication requires a valid JWT in `auth.token`.

Supported client room behavior includes:

- Joining and leaving preview-specific bus rooms.
- Receiving assigned-bus assignment updates.
- Receiving live location updates.
- Receiving bus-plan updates.
- Receiving notification events.
- Reconnecting automatically after network or app-state changes.

The backend uses:

- Transport: WebSocket from the mobile client.
- Single-instance mode by default for local/development deployments.
- Redis adapter mode for production clusters when `SOCKET_IO_MODE=redis`.
- Preview/assignment filtering to prevent unrelated bus updates from being applied.

## 6. Local setup

### Prerequisites

- Node.js and npm
- MongoDB, local or hosted
- Expo CLI dependencies through `npx expo`
- Android Studio or a physical Android device for native testing
- Optional Redis instance for clustered Socket.IO mode

### Install dependencies

```powershell
cd backend
npm install

cd ..\frontend
npm install
```

### Configure MongoDB and backend

Create `backend/.env`:

```dotenv
NODE_ENV=development
PORT=5000
HOST=0.0.0.0

MONGODB_URI=mongodb://127.0.0.1:27017
DB_NAME=bts_db
JWT_SECRET=replace-with-a-long-random-secret-at-least-32-characters

SOCKET_IO_MODE=single-instance
CORS_ORIGIN=http://localhost:8765
TRUSTED_PROXY_CIDRS=

LOGIN_ATTEMPT_WINDOW_MS=900000
LOGIN_MAX_ACCOUNT_FAILURES=10
LOGIN_PENDING_RESERVATION_TTL_MS=120000
LOGIN_LIMITER_HASH_SECRET=replace-with-another-long-random-secret

GPS_OFFLINE_THRESHOLD_MS=180000
GPS_PROVIDER_TIMEOUT_MS=10000
GPS_DEVICE_REGISTRY_MODE=legacy

EMAIL_USER=
EMAIL_PASS=
GPS_TOKEN=
GPS_EMAIL=
```

Important backend variables:

| Variable | Required | Purpose |
|---|---|---|
| `MONGODB_URI` | Yes | MongoDB connection string |
| `DB_NAME` | No, default `bts_db` | Database name injected when the URI has no database |
| `JWT_SECRET` | Yes in production | Signs and verifies JWTs and shared-limit keys |
| `LOGIN_LIMITER_HASH_SECRET` | Recommended | Separates login-bucket identity hashing |
| `PORT` / `HOST` | No | HTTP listener settings |
| `CORS_ORIGIN` | No | Additional comma-separated browser origins |
| `TRUSTED_PROXY_CIDRS` | No | CIDRs allowed to provide proxy client addresses |
| `SOCKET_IO_MODE` | No | `single-instance` or `redis` |
| `SOCKET_IO_REDIS_URL` / `REDIS_URL` | Redis mode | Redis connection |
| `MONGODB_MAX_POOL_SIZE` | No, default `100` | MongoDB max pool size |
| `MONGODB_WAIT_QUEUE_TIMEOUT_MS` | No, default `10000` | MongoDB wait queue timeout |
| `GPS_*` | As configured | GPS credentials, freshness, and provider behavior |
| `EMAIL_*` | If email is used | SMTP identity credentials |
| `BTMS_ATLAS_AUDIT_SECRET` | If Atlas audit is enabled | Audit endpoint secret |

In production, `NODE_ENV=production` requires `JWT_SECRET` and `MONGODB_URI`.

### Seed the super administrator

Set `SUPERADMIN_EMAIL` and a pre-generated bcrypt cost-12 `SUPERADMIN_PASSWORD_HASH`, then run:

```powershell
cd backend
npm run db:setup
```

Do not put a plain-text password into `SUPERADMIN_PASSWORD_HASH`; the setup script inserts the bcrypt value directly.

Reset a known account through the provided script only in an authorized environment:

```powershell
cd backend
node reset-superadmin-password.js
```

### Start MongoDB and the backend

```powershell
cd backend
npm start
```

Backend default: `http://127.0.0.1:5000`.

Verify:

```text
http://127.0.0.1:5000/health
http://127.0.0.1:5000/ready
```

### Start the Expo client

```powershell
cd frontend
npx expo start
```

For Android:

```powershell
cd frontend
npm run android
```

For iOS:

```powershell
cd frontend
npm run ios
```

For browser:

```powershell
cd frontend
npm run web
```

### Mobile backend environment selection

The Expo backend resolver supports:

- `local`
- `production`
- `remote-test`

Local Expo defaults:

- Android emulator: `http://10.0.2.2:5000`
- iOS simulator, web, and local desktop: `http://127.0.0.1:5000`

For a LAN device, set a private-LAN backend origin on port 5000:

```powershell
$env:EXPO_PUBLIC_BTMS_ENV="local"
$env:EXPO_PUBLIC_API_BASE_URL="http://192.168.1.20:5000"
npx expo start
```

Production builds are constrained to `https://bts-kiot.onrender.com`.

Remote tests require:

```dotenv
EXPO_PUBLIC_BTMS_ENV=remote-test
EXPO_PUBLIC_ALLOW_REMOTE_TESTS=YES
```

### Start the static web dashboard

Serve `docs/` through any static server. It should be opened on loopback or a private LAN address for local API access.

Example using Python:

```powershell
cd docs
python -m http.server 8765
```

Open `http://127.0.0.1:8765/`. The dashboard's local configuration expects the backend at port 5000.

The public landing page can also be opened directly:

```powershell
start btms_web.html
```

## 7. Database and operational scripts

Backend package scripts:

| Command | Purpose |
|---|---|
| `npm start` | Start backend server |
| `npm run dev:watch` | Start through nodemon |
| `npm run db:setup` | Seed/update the super admin |
| `npm run db:test` | Run database test script |
| `npm run auth:test` | Run login test script |
| `npm run db:migrate:*` | Run notification, stop-master, bus-number, sample-arrival, or login-attempt migrations |
| `npm run db:init:staging` | Initialize staging database definitions |
| `npm run db:init:gps-worker-ownership` | Initialize GPS ownership records |

Additional scripts exist in `backend/scripts/` for staging readiness, production/staging GPS ownership, database verification, stop-master migration, and login-attempt migration.

Before running database scripts in a live environment, verify:

- `NODE_ENV`
- Database name
- MongoDB host/URI
- Staging/production environment flags
- Backups and approval for mutating operations

## 8. Testing

Backend:

```powershell
cd backend
npm test
```

Frontend:

```powershell
cd frontend
npm test
```

Backend tests cover authentication, route protection, login protection, app startup isolation, Socket.IO assignment propagation/revocation, MongoDB read-only readiness, GPS ownership, import chunking, and runtime behavior.

Staging GPS integration:

```powershell
cd backend
npm run test:integration:gps-worker:staging
```

Load scripts are under `backend/load-tests/` and should be run only against a controlled test environment.

## 9. Production and clustered operation

For a production or multi-instance deployment:

1. Set `NODE_ENV=production`.
2. Set a strong `JWT_SECRET` of at least 32 characters.
3. Set `MONGODB_URI` and an explicit `DB_NAME` if needed.
4. Set `SOCKET_IO_MODE=redis`.
5. Set `SOCKET_IO_REDIS_URL` or `REDIS_URL`.
6. Set `LOGIN_LIMITER_HASH_SECRET`.
7. Configure trusted proxy CIDRs if the API is behind a reverse proxy.
8. Configure GPS credentials and strict/legacy device registry behavior.
9. Configure SMTP variables if notification/import email features are enabled.
10. Initialize and verify GPS worker ownership.
11. Check `/health` and `/ready` before routing traffic.

MongoDB connection defaults:

- Max pool size: `100`
- Wait queue timeout: `10,000 ms`

Redis mode supplies:

- Socket.IO cross-instance event transport.
- Cross-instance shared API and audit rate-limit storage.
- GPS and assignment transport readiness status.

Only one database-backed GPS worker should hold the MongoDB ownership lease.

## 10. Security and operational behavior

- Passwords are stored as bcrypt hashes, with registration/password updates using bcrypt cost 12.
- JWT bearer tokens expire after 24 hours.
- Protected API middleware verifies account existence, role, active state, and deleted status on each request.
- CORS, Helmet headers, JSON limits, URL encoding limits, and API limits are enforced.
- API responses set `X-Request-Id` and disable caching for `/api`.
- Error middleware hides internal database, socket, network, and stack details.
- Account email values and login identities are hashed or redacted from diagnostic paths where applicable.
- Mutations use expected versions and idempotency handling to reduce duplicate or stale updates.
- Unit tests cannot connect to live MongoDB unless using the explicitly marked local-integration environment.

## 11. Main source folders

```text
backend/src/
  app.js                  Express middleware and route registration
  runtime.js              HTTP, Socket.IO, worker, and shutdown lifecycle
  routes/                 REST route definitions
  controllers/            Request behavior and domain operations
  models/                 Mongoose schemas
  middleware/             JWT, upload, import, and admission middleware
  services/               GPS, assignment, email, startup, and Redis services
  socket/                 Socket authentication and realtime bus handlers
  workers/                GPS and background worker logic
  utils/                  Diagnostics, readiness, concurrency, and protection helpers

frontend/src/
  api/                    REST API modules
  auth/                   Secure session and storage policy
  components/             Shared UI and map components
  config/                 Backend environment policy
  context/                Authentication and bus real-time state
  navigation/             Stack/bottom navigation wrappers
  screens/                Login, profile, home, notification, plans, and admin screens
  utils/                  Error, GPS, socket, and display policies
```
