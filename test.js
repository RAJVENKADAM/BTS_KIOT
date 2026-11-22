/*
 * BTMS k6 capacity test — run from the repository root with `k6 run .\test.js`.
 *
 * PREPARATION
 * - Start the backend against an isolated, seeded test/staging database. Login
 *   requires JWT_SECRET and a ready MongoDB replica set with the login-attempt
 *   TTL index. Do not run this against production or shared live data.
 * - Prepare a local JSON fixture shaped as { "accounts": [
 *   { "email": "...", "password": "..." }, ... ] }. Use unique, active
 *   student accounts only; never commit credentials. Login mode needs one
 *   distinct account per BTMS_CAPACITY_VUS (maximum 50). Active mode also
 *   needs one distinct account per BTMS_CAPACITY_VUS; each must be assigned
 *   to an active bus with a route in the current plan. GPS records are
 *   optional: fresh, stale, and
 *   unavailable GPS states are handled according to the student API contract.
 * - Defaults use .\backend\load-tests\student-login-capacity-accounts.json for
 *   login mode and .\backend\load-tests\accounts.json for active mode. Override
 *   either with BTMS_CAPACITY_ACCOUNTS_FILE; paths are relative to this script.
 * - BTMS_CAPACITY_SCENARIO=login sends one simultaneous login per VU
 *   (BTMS_CAPACITY_VUS defaults to 20; maximum 50).
 *   BTMS_CAPACITY_SCENARIO=active ramps up unique, authenticated student VUs
 *   (BTMS_CAPACITY_VUS defaults to 20; maximum 500), then repeats the
 *   read-only student workflow. The eight HTTP calls in each active cycle
 *   default to every 30 seconds, below the API's 300-request/user/15-minute
 *   limit.
 * - Optional workload settings: BTMS_CAPACITY_RAMP_SECONDS (default 60,
 *   max 600), BTMS_CAPACITY_DURATION_SECONDS (default 300, max 7200), and
 *   BTMS_CAPACITY_POLL_SECONDS (default 30, minimum 30, max 600). Total
 *   ramp, hold, and ramp-down time may not exceed two hours.
 * - Default target is http://127.0.0.1:5000. For a dedicated staging target
 *   set BTMS_CAPACITY_BASE_URL=https://<approved-host>,
 *   BTMS_CAPACITY_STAGING_HOSTS=<exact-host>, and
 *   BTMS_CAPACITY_CONFIRM_STAGING=YES. Remote HTTP, unapproved hosts, URLs
 *   with paths/credentials, and the known production hostname are rejected.
 *
 * Scope: student login/profile/verification, assignment, route/location and
 * notification reads, plus authenticated Socket.IO assignment/location
 * updates. GPS is supplied by the backend worker; this script never writes
 * coordinates. Admin/import, account deletion, notification mutation, and
 * other state-changing endpoints are deliberately excluded from load runs.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import { Trend } from "k6/metrics";
import ws from "k6/ws";

const MAX_HTTP_DURATION_MS = 2000;
const MAX_LOGIN_VUS = 50;
const MAX_ACTIVE_VUS = 500;
const MAX_TEST_DURATION_SECONDS = 2 * 60 * 60;
const MAX_SOCKET_WAIT_MS = 5000;
const KNOWN_PRODUCTION_HOSTS = new Set(["bts-kiot.onrender.com"]);
const expectedForbiddenResponse = http.expectedStatuses(403);

function positiveIntegerEnv(name, fallback, maximum, minimum) {
  const raw = __ENV[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(String(raw))) {
    throw new Error(`${name} must be a positive whole number.`);
  }
  const value = Number(raw);
  const lowerBound = minimum === undefined ? 1 : minimum;
  if (!Number.isSafeInteger(value) || value < lowerBound || value > maximum) {
    throw new Error(`${name} is outside the supported range.`);
  }
  return value;
}

function normalizeHostname(hostname) {
  return String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
}

function isLoopback(hostname) {
  const host = normalizeHostname(hostname);
  if (host === "localhost" || host === "::1") return true;
  const parts = host.split(".");
  if (
    parts.length !== 4 ||
    !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  ) {
    return false;
  }
  return Number(parts[0]) === 127;
}

function validateTarget(configuredUrl) {
  const match = /^(https?):\/\/([^/?#]+)\/?$/i.exec(String(configuredUrl).trim());
  if (!match) {
    throw new Error("The target must be an HTTP(S) origin without credentials, path, query, or fragment.");
  }
  const protocol = `${match[1].toLowerCase()}:`;
  const authority = match[2];
  if (authority.indexOf("@") !== -1) {
    throw new Error("Target URLs must not contain credentials.");
  }

  let hostname;
  let port = "";
  if (authority.charAt(0) === "[") {
    const ipv6Match = /^(\[[0-9a-f:.]+\])(?::(\d+))?$/i.exec(authority);
    if (!ipv6Match) throw new Error("Target hostname or port is invalid.");
    hostname = ipv6Match[1];
    port = ipv6Match[2] || "";
  } else {
    const hostMatch = /^([^:]+)(?::(\d+))?$/.exec(authority);
    if (!hostMatch) throw new Error("Target hostname or port is invalid.");
    hostname = hostMatch[1];
    port = hostMatch[2] || "";
  }

  const host = normalizeHostname(hostname);
  if (KNOWN_PRODUCTION_HOSTS.has(host)) {
    throw new Error("The known production hostname is blocked for load testing.");
  }

  if (isLoopback(host)) {
    if (protocol !== "http:" || port !== "5000") {
      throw new Error("Local targets must use HTTP on backend port 5000.");
    }
    return `http://${host.indexOf(":") !== -1 ? `[${host}]` : host}:5000`;
  }

  const validDnsHost =
    host.length <= 253 &&
    host.split(".").every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    );
  if (!validDnsHost) {
    throw new Error("Remote test targets must use a valid DNS hostname.");
  }
  if (protocol !== "https:" || port) {
    throw new Error("Remote test targets must use HTTPS on the default port.");
  }
  const allowedHosts = String(__ENV.BTMS_CAPACITY_STAGING_HOSTS || "")
    .split(",")
    .map(normalizeHostname)
    .filter(Boolean);
  if (!allowedHosts.includes(host)) {
    throw new Error("Remote targets must exactly match BTMS_CAPACITY_STAGING_HOSTS.");
  }
  if (__ENV.BTMS_CAPACITY_CONFIRM_STAGING !== "YES") {
    throw new Error("Remote staging runs require BTMS_CAPACITY_CONFIRM_STAGING=YES.");
  }
  return `https://${host}`;
}

const scenario = String(__ENV.BTMS_CAPACITY_SCENARIO || "active").toLowerCase();
if (scenario !== "login" && scenario !== "active") {
  throw new Error("Set BTMS_CAPACITY_SCENARIO to either login or active.");
}

const vus = positiveIntegerEnv(
  "BTMS_CAPACITY_VUS",
  20,
  scenario === "login" ? MAX_LOGIN_VUS : MAX_ACTIVE_VUS,
);
const activeRampSeconds =
  scenario === "active"
    ? positiveIntegerEnv("BTMS_CAPACITY_RAMP_SECONDS", 60, 600)
    : 0;
const activeDurationSeconds =
  scenario === "active"
    ? positiveIntegerEnv(
        "BTMS_CAPACITY_DURATION_SECONDS",
        300,
        MAX_TEST_DURATION_SECONDS,
      )
    : 0;
const activePollSeconds =
  scenario === "active"
    ? positiveIntegerEnv("BTMS_CAPACITY_POLL_SECONDS", 30, 600, 30)
    : 30;

if (
  scenario === "active" &&
  activeRampSeconds * 2 + activeDurationSeconds + 10 >
    MAX_TEST_DURATION_SECONDS
) {
  throw new Error("Ramp, active hold, and ramp-down may total no more than two hours.");
}

const baseUrl = validateTarget(
  __ENV.BTMS_CAPACITY_BASE_URL || "http://127.0.0.1:5000",
);
const defaultAccountsFile =
  scenario === "login"
    ? ".\\backend\\load-tests\\student-login-capacity-accounts.json"
    : ".\\backend\\load-tests\\accounts.json";
const accountsFile =
  __ENV.BTMS_CAPACITY_ACCOUNTS_FILE || defaultAccountsFile;

const accounts = new SharedArray("btms-test-accounts", function loadAccounts() {
  let parsed;
  try {
    parsed = JSON.parse(open(accountsFile));
  } catch (_error) {
    throw new Error("Could not read the local account fixture; see the test.js preparation notes.");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray(parsed.accounts) ||
    parsed.accounts.length < vus
  ) {
    throw new Error("The account fixture must contain at least one account per virtual user.");
  }
  const seenEmails = new Set();
  for (const account of parsed.accounts) {
    if (
      typeof account.email !== "string" ||
      !account.email.trim() ||
      typeof account.password !== "string" ||
      !account.password
    ) {
      throw new Error("Every fixture account must contain an email and password.");
    }
    const email = account.email.trim().toLowerCase();
    if (seenEmails.has(email)) {
      throw new Error("Fixture account email addresses must be unique.");
    }
    seenEmails.add(email);
  }
  return parsed.accounts;
});

const socketEventDuration = new Trend("socket_event_duration");
const endpointThresholds = {
  "http_req_duration{endpoint:auth-login}": ["p(95)<2000"],
};

if (scenario === "active") {
  for (const endpoint of [
    "auth-profile",
    "auth-verify",
    "role-admin-bus-list",
    "bus-assignment",
    "bus-routes",
    "bus-location",
    "notifications-list",
    "notifications-unread-count",
  ]) {
    endpointThresholds[`http_req_duration{endpoint:${endpoint}}`] = ["p(95)<2000"];
  }
  endpointThresholds["ws_connecting{endpoint:socket-assignment-location}"] = [
    "p(95)<2000",
  ];
  endpointThresholds[
    "socket_event_duration{endpoint:socket-location-roundtrip}"
  ] = ["p(95)<2000"];
}

export const options = {
  scenarios:
    scenario === "login"
      ? {
          simultaneous_login: {
            executor: "per-vu-iterations",
            vus,
            iterations: 1,
            maxDuration: "2m",
            exec: "loginBurst",
          },
        }
      : {
          active_student_usage: {
            executor: "ramping-vus",
            startVUs: 0,
            stages: [
              { duration: `${activeRampSeconds}s`, target: vus },
              { duration: `${activeDurationSeconds}s`, target: vus },
              { duration: `${activeRampSeconds}s`, target: 0 },
            ],
            gracefulRampDown: "10s",
            exec: "activeUsage",
          },
        },
  thresholds: {
    ...endpointThresholds,
    checks: ["rate==1"],
  },
};

function requestParams(endpoint, token, body) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return {
    headers,
    tags: { endpoint },
    timeout: "5s",
  };
}

function parseResponse(response) {
  try {
    return response.json();
  } catch (_error) {
    return null;
  }
}

function checkHttpResponse(response, endpoint, data, payloadPredicate) {
  const statusOk = check(
    response,
    {
      [`${endpoint} returns HTTP 200`]: (res) => res.status === 200,
      [`${endpoint} completes under 2000ms`]: (res) =>
        Boolean(res.timings) &&
        typeof res.timings.duration === "number" &&
        res.timings.duration < MAX_HTTP_DURATION_MS,
    },
    { endpoint },
  );
  const payloadOk = check(
    data,
    {
      [`${endpoint} response payload is valid`]: (value) =>
        Boolean(value && payloadPredicate(value)),
    },
    { endpoint },
  );
  return { ok: statusOk && payloadOk, data };
}

function login(account) {
  const response = http.post(
    `${baseUrl}/api/auth/login`,
    JSON.stringify({
      email: account.email.trim(),
      password: account.password,
    }),
    requestParams("auth-login", null, true),
  );
  const data = parseResponse(response);
  const result = checkHttpResponse(
    response,
    "auth-login",
    data,
    (value) =>
      typeof value.token === "string" &&
      value.token.length > 0 &&
      String(value.user && value.user.role).toLowerCase() === "student" &&
      value.user.is_active === true,
  );
  return result.ok
    ? { token: data.token, user: data.user }
    : null;
}

function getJson(endpoint, path, token, payloadPredicate) {
  const response = http.get(
    `${baseUrl}${path}`,
    requestParams(endpoint, token),
  );
  return checkHttpResponse(
    response,
    endpoint,
    parseResponse(response),
    payloadPredicate,
  );
}

function checkStudentRoleDenied(token) {
  const endpoint = "role-admin-bus-list";
  const params = requestParams(endpoint, token);
  params.responseCallback = expectedForbiddenResponse;
  const response = http.get(
    `${baseUrl}/api/bus/get-all-buses`,
    params,
  );
  const statusOk = check(
    response,
    {
      "student is denied admin-only bus list with HTTP 403": (res) =>
        res.status === 403,
      "admin-only bus list denial completes under 2000ms": (res) =>
        Boolean(res.timings) &&
        typeof res.timings.duration === "number" &&
        res.timings.duration < MAX_HTTP_DURATION_MS,
    },
    { endpoint },
  );
  const payloadOk = check(
    parseResponse(response),
    {
      "admin-only bus list returns the role-denied response": (value) =>
        Boolean(value && value.error === "Insufficient permissions"),
    },
    { endpoint },
  );
  return statusOk && payloadOk;
}

function coordinateIsValid(value, min, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function validGpsSnapshot(snapshot) {
  if (!snapshot || !["fresh", "stale", "unavailable"].includes(snapshot.gpsStatus)) {
    return false;
  }
  if (snapshot.gpsStatus !== "fresh") {
    return snapshot.latitude === null && snapshot.longitude === null;
  }
  const providerTime = Date.parse(snapshot.providerTimestamp);
  const threshold =
    typeof snapshot.gpsOfflineThresholdMs === "number"
      ? snapshot.gpsOfflineThresholdMs
      : 3 * 60 * 1000;
  const age = Date.now() - providerTime;
  return (
    coordinateIsValid(snapshot.latitude, -90, 90) &&
    coordinateIsValid(snapshot.longitude, -180, 180) &&
    typeof snapshot.speed === "number" &&
    Number.isFinite(snapshot.speed) &&
    snapshot.speed >= 0 &&
    Number.isFinite(providerTime) &&
    age <= threshold &&
    age >= -5 * 60 * 1000
  );
}

function checkGpsSnapshot(snapshot, endpoint) {
  return check(
    snapshot,
    {
      [`${endpoint} GPS freshness and coordinates follow the API contract`]:
        validGpsSnapshot,
    },
    { endpoint },
  );
}

export function loginBurst() {
  login(accounts[__VU - 1]);
}

let activeSession = null;
let activeLoginFailed = false;

function runStudentWorkflow(session) {
  const profile = getJson(
    "auth-profile",
    "/api/auth/profile",
    session.token,
    (value) =>
      Boolean(value.user) &&
      String(value.user.role).toLowerCase() === "student",
  );
  if (!profile.ok) return;

  const verify = getJson(
    "auth-verify",
    "/api/auth/verify",
    session.token,
    (value) => value.valid === true && String(value.user && value.user.id).length > 0,
  );
  if (!verify.ok) return;
  if (!checkStudentRoleDenied(session.token)) return;

  const assignment = getJson(
    "bus-assignment",
    "/api/bus/my-assignment",
    session.token,
    (value) => value.success === true,
  );
  if (!assignment.ok) return;
  const assignedBusOk = check(
    assignment.data,
    {
      "bus-assignment status is assigned": (value) =>
        value.assignmentStatus === "assigned",
    },
    { endpoint: "bus-assignment" },
  );
  const activeRouteOk = check(
    assignment.data,
    {
      "bus-assignment has a route in the current plan": (value) =>
        value.hasActiveRoute === true,
    },
    { endpoint: "bus-assignment" },
  );
  if (!assignedBusOk || !activeRouteOk) return;
  checkGpsSnapshot(assignment.data, "bus-assignment");

  const busIdentifier =
    assignment.data.busNo ||
    assignment.data.effectivePreviewNumber ||
    assignment.data.previewNumber;
  if (busIdentifier === null || busIdentifier === undefined || String(busIdentifier).trim() === "") {
    check(
      false,
      { "bus-assignment contains a routable assigned bus": (value) => value === true },
      { endpoint: "bus-assignment" },
    );
    return;
  }
  const encodedBus = encodeURIComponent(String(busIdentifier));

  const routes = getJson(
    "bus-routes",
    `/api/bus/routes/${encodedBus}`,
    session.token,
    (value) =>
      value.success === true &&
      value.hasStops === true &&
      Array.isArray(value.stops) &&
      value.stops.length > 0,
  );
  if (!routes.ok) return;

  const location = getJson(
    "bus-location",
    `/api/bus/location/${encodedBus}`,
    session.token,
    (value) =>
      value.success === true &&
      value.assignmentStatus === "assigned" &&
      ["fresh", "stale", "unavailable"].includes(value.gpsStatus),
  );
  if (!location.ok) return;
  checkGpsSnapshot(location.data, "bus-location");

  const notifications = getJson(
    "notifications-list",
    "/api/notifications",
    session.token,
    (value) =>
      value.success === true &&
      Array.isArray(value.notifications) &&
      Number.isSafeInteger(value.unreadCount),
  );
  if (!notifications.ok) return;

  getJson(
    "notifications-unread-count",
    "/api/notifications/unread-count",
    session.token,
    (value) => value.success === true && Number.isSafeInteger(value.unreadCount),
  );

  checkStudentSocket(session.token);
}

function checkStudentSocket(token) {
  const state = {
    authenticated: false,
    initialSnapshotReceived: false,
    requestSent: false,
    responseReceived: false,
    requestStartedAt: 0,
  };
  const socketUrl = `${baseUrl.replace(/^http/, "ws")}/socket.io/?EIO=4&transport=websocket`;
  const response = ws.connect(
    socketUrl,
    {
      tags: { endpoint: "socket-assignment-location" },
    },
    function onSocket(socket) {
      socket.on("message", function onMessage(message) {
        const packet = String(message);
        if (packet === "2") {
          socket.send("3");
          return;
        }
        if (packet.charAt(0) === "0") {
          socket.send(`40${JSON.stringify({ token })}`);
          return;
        }
        if (packet.indexOf("40") === 0) {
          state.authenticated = true;
          return;
        }
        if (packet.indexOf("44") === 0) {
          socket.close();
          return;
        }
        if (packet.indexOf("42") !== 0) return;

        let event;
        try {
          event = JSON.parse(packet.slice(2));
        } catch (_error) {
          return;
        }
        if (!Array.isArray(event) || event[0] !== "assigned-bus-update") return;
        const snapshot = event[1];
        const firstPayloadOk = check(
          snapshot,
          {
            "socket assignment update is successful and assigned": (value) =>
              Boolean(value && value.success === true && value.assignmentStatus === "assigned"),
          },
          { endpoint: "socket-assignment-location" },
        );
        if (!firstPayloadOk) {
          socket.close();
          return;
        }
        checkGpsSnapshot(snapshot, "socket-assignment-location");

        if (!state.initialSnapshotReceived) {
          state.initialSnapshotReceived = true;
          state.requestSent = true;
          state.requestStartedAt = Date.now();
          socket.send('42["request-bus-location"]');
          return;
        }

        if (state.requestSent && !state.responseReceived) {
          state.responseReceived = true;
          const elapsed = Date.now() - state.requestStartedAt;
          socketEventDuration.add(elapsed, {
            endpoint: "socket-location-roundtrip",
          });
          check(
            elapsed,
            {
              "socket location update completes under 2000ms": (duration) =>
                duration < MAX_HTTP_DURATION_MS,
            },
            { endpoint: "socket-location-roundtrip" },
          );
          socket.close();
        }
      });

      socket.setTimeout(function onSocketTimeout() {
        if (!state.initialSnapshotReceived) {
          check(
            false,
            { "socket receives initial assigned-bus-update": (value) => value === true },
            { endpoint: "socket-assignment-location" },
          );
        } else if (!state.responseReceived) {
          check(
            false,
            { "socket receives requested assigned-bus-update": (value) => value === true },
            { endpoint: "socket-location-roundtrip" },
          );
        }
        socket.close();
      }, MAX_SOCKET_WAIT_MS);
    },
  );

  check(
    response,
    {
      "socket transport upgrades successfully": (res) => res.status === 101,
      "socket connection completes under 2000ms": (res) =>
        Boolean(res.timings) &&
        typeof res.timings.duration === "number" &&
        res.timings.duration < MAX_HTTP_DURATION_MS,
    },
    { endpoint: "socket-assignment-location" },
  );
  check(
    state,
    {
      "socket authenticates with the student JWT": (value) => value.authenticated,
      "socket returns the requested assigned-bus update": (value) =>
        value.responseReceived,
    },
    { endpoint: "socket-assignment-location" },
  );
}

export function activeUsage() {
  if (!activeSession && !activeLoginFailed) {
    activeSession = login(accounts[__VU - 1]);
    activeLoginFailed = activeSession === null;
  }
  if (activeSession) runStudentWorkflow(activeSession);
  sleep(activePollSeconds);
}
