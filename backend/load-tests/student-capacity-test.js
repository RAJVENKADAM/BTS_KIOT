"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const {
  SOCKET_RECONNECTION_ATTEMPTS,
  SOCKET_RECONNECTION_DELAY_MS,
  SOCKET_RECONNECTION_MAX_DELAY_MS,
  SOCKET_RECONNECTION_RANDOMIZATION_FACTOR,
} = require("../../frontend/src/utils/socketConnectionPolicy.cjs");
const {
  MAX_RECONNECTION_ATTEMPTS,
  MAX_REQUEST_TIMEOUT_MS,
  validateCapacityLimits,
  validatePositiveSafeInteger,
  validateTarget,
} = require("./capacity-test-core.cjs");
const {
  safeDescription,
  safeDisconnectReason,
  safeSocketId,
  safeTransportType,
} = require("../src/utils/socketDiagnostics");
const {
  STAGES,
  assignVirtualClients,
  cleanupSockets,
  getStopReasons,
  summarizeLatencies,
  validateAccounts,
} = require("./capacity-test-core.cjs");

const ACCOUNT_FILE = path.join(__dirname, "accounts.json");
const REPORTS_DIR = path.join(__dirname, "reports");
const REQUEST_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 30_000;
const READINESS_INTERVAL_MS = 30_000;
const LOCATION_EVENT_TIMEOUT_MS = 120_000;
const DEFAULT_HOLD_MS = {
  active: 5 * 60 * 1000,
  endurance: 60 * 60 * 1000,
  recovery: 60 * 1000,
};
const SOCKET_POLICY = {
  attempts: Math.min(SOCKET_RECONNECTION_ATTEMPTS, MAX_RECONNECTION_ATTEMPTS),
  delayMs: SOCKET_RECONNECTION_DELAY_MS,
  maxDelayMs: SOCKET_RECONNECTION_MAX_DELAY_MS,
  randomizationFactor: SOCKET_RECONNECTION_RANDOMIZATION_FACTOR,
};

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const key = argument.slice(2);
    if (key === "help") {
      options.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}.`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

function usage() {
  return [
    "Usage: node .\\load-tests\\student-capacity-test.js --scenario <login|active|endurance|recovery> --clients <20|50|100|250|500> [options]",
    "Options: --ramp-ms <milliseconds> --hold-ms <milliseconds> --accounts <path>",
    "Scenarios must be run separately; the script never advances to another stage.",
  ].join("\n");
}

function parsePositiveInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value))) {
    throw new Error(`--${name} must be a safe integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`--${name} must be a safe integer.`);
  }
  return parsed;
}

function loadConfiguration(options, env = process.env) {
  const scenario = options.scenario;
  if (!["login", "active", "endurance", "recovery"].includes(scenario)) {
    throw new Error("Choose --scenario login, active, endurance, or recovery.");
  }
  const clients = parsePositiveInteger(options.clients, "clients");
  if (!STAGES.includes(clients)) {
    throw new Error(`Choose a client stage: ${STAGES.join(", ")}.`);
  }

  const defaultRampMs = scenario === "login" ? 0 : 60_000;
  const defaultHoldMs = scenario === "login" ? 0 : DEFAULT_HOLD_MS[scenario];
  const rampMs = parsePositiveInteger(options["ramp-ms"], "ramp-ms", defaultRampMs);
  const holdMs = parsePositiveInteger(options["hold-ms"], "hold-ms", defaultHoldMs);
  if (scenario === "login" && (rampMs !== 0 || holdMs !== 0)) {
    throw new Error("The login scenario starts all requests together and has no hold period.");
  }
  if (scenario !== "login" && holdMs === 0) {
    throw new Error("Socket scenarios require a positive --hold-ms value.");
  }
  if (scenario === "endurance" && holdMs < 60 * 60 * 1000) {
    throw new Error("The endurance scenario requires a hold of at least 60 minutes.");
  }

  const configuredUrl = env.BTMS_CAPACITY_BASE_URL || "http://127.0.0.1:5000";
  const baseUrl = validateTarget(configuredUrl, env);
  const totalDurationMs =
    rampMs +
    holdMs +
    REQUEST_TIMEOUT_MS +
    SOCKET_TIMEOUT_MS +
    LOCATION_EVENT_TIMEOUT_MS +
    SOCKET_POLICY.attempts * SOCKET_POLICY.maxDelayMs;
  validatePositiveSafeInteger(
    SOCKET_TIMEOUT_MS,
    "Socket timeout",
    MAX_REQUEST_TIMEOUT_MS,
  );
  validatePositiveSafeInteger(
    LOCATION_EVENT_TIMEOUT_MS,
    "Location event timeout",
    MAX_REQUEST_TIMEOUT_MS,
  );
  validateCapacityLimits({
    clients,
    rampMs,
    holdMs,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    reconnectionAttempts: SOCKET_POLICY.attempts,
    totalDurationMs,
  });

  return {
    scenario,
    clients,
    rampMs,
    holdMs,
    baseUrl,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    reconnectionAttempts: SOCKET_POLICY.attempts,
    accountFile: path.resolve(options.accounts || ACCOUNT_FILE),
  };
}

function readAccounts(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error("Could not read the local account fixture. No credentials were displayed.");
  }
  return validateAccounts(parsed?.accounts);
}

function plannedHttpRequests(config, accounts) {
  const loginCalls =
    config.scenario === "login"
      ? config.clients
      : Math.min(config.clients, accounts.length);
  if (config.scenario === "login") return loginCalls;
  const initialCalls = config.clients * 3;
  const recoveryCalls = config.scenario === "recovery" ? config.clients * 4 : 0;
  const readinessCalls = 1 + Math.ceil(config.holdMs / READINESS_INTERVAL_MS);
  return loginCalls + initialCalls + recoveryCalls + readinessCalls;
}

function plannedLoginAttempts(config, accounts) {
  return config.scenario === "login"
    ? config.clients
    : Math.min(config.clients, accounts.length);
}

function createMetrics(config, uniqueAccountCount) {
  return {
    plannedClients: config.clients,
    uniqueAccounts: uniqueAccountCount,
    accountReuseCount: config.clients - uniqueAccountCount,
    authenticationAttempts: 0,
    authenticationFailures: 0,
    apiAuthenticationFailures: 0,
    sessionVerifications: 0,
    sessionVerificationFailures: 0,
    successfulLogins: 0,
    failedLogins: 0,
    successfulSocketConnections: 0,
    totalSocketConnections: 0,
    connectionFailures: 0,
    unexpectedDisconnections: 0,
    controlledInterruptions: 0,
    reconnectAttempts: 0,
    reconnectionFailures: 0,
    reconnectSuccesses: 0,
    apiRequests: 0,
    api5xxErrors: 0,
    apiErrors: 0,
    functionalErrors: 0,
    locationUpdates: 0,
    locationUpdateErrors: 0,
    zeroUpdateClients: 0,
    staleUpdateClients: 0,
    maxLoginInFlight: 0,
    loginInFlight: 0,
    maxApiInFlight: 0,
    apiInFlight: 0,
    statuses: {},
    failureCategories: {},
    requests: [],
    clientResults: [],
    socketDiagnostics: [],
    readinessSnapshots: [],
    stopReasons: [],
    backendMetrics: {
      cpu: "unavailable from the public readiness endpoint",
      rss: "unavailable from the public readiness endpoint",
      heap: "unavailable from the public readiness endpoint",
      eventLoopLag: "unavailable from the public readiness endpoint",
      mongodbPoolPressure: "unavailable from the public readiness endpoint",
      processRestarts: "unavailable from the public readiness endpoint",
      gpsWorkerCycleDuration: "unavailable from the public readiness endpoint",
      gpsWorkerSkippedTimerTicks: "unavailable from the public readiness endpoint",
      gpsProviderRequestCount: "unavailable; not queried or modified by this test",
    },
  };
}

function increment(record, key) {
  record[key] = (record[key] || 0) + 1;
}

function accountClientLabel(index) {
  return `account-group-${String(index + 1).padStart(3, "0")}`;
}

function recordStatus(metrics, status) {
  increment(metrics.statuses, status === null ? "NETWORK" : String(status));
}

function categorizeStatus(status) {
  if (status === 401) return "HTTP_401";
  if (status === 403) return "HTTP_403";
  if (status === 429) return "HTTP_429";
  if (status >= 500) return "HTTP_5XX";
  if (status >= 400) return `HTTP_${status}`;
  return null;
}

function recordRequest(metrics, record) {
  metrics.requests.push({
    client: record.client,
    endpoint: record.endpoint,
    method: record.method,
    status: record.status,
    durationMs: record.durationMs,
    category: record.category,
    kind: record.kind,
  });
  recordStatus(metrics, record.status);
  if (record.kind === "api") {
    metrics.apiRequests += 1;
    if (record.status >= 500) metrics.api5xxErrors += 1;
    if ([401, 403, 429].includes(record.status)) {
      metrics.apiAuthenticationFailures += 1;
    }
    if (record.category) metrics.apiErrors += 1;
  }
  if (record.category) increment(metrics.failureCategories, record.category);
}

function markPayloadFailure(metrics, client, endpoint, category) {
  const request = [...metrics.requests]
    .reverse()
    .find((item) => item.client === client && item.endpoint === endpoint);
  if (request && !request.category) request.category = category;
  increment(metrics.failureCategories, category);
}

async function requestJson({
  metrics,
  client,
  endpoint,
  url,
  token,
  method = "GET",
  body,
  kind = "api",
  timeoutMs = REQUEST_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  validatePositiveSafeInteger(
    timeoutMs,
    "Request timeout",
    MAX_REQUEST_TIMEOUT_MS,
  );
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  if (kind === "login") {
    metrics.loginInFlight += 1;
    metrics.maxLoginInFlight = Math.max(metrics.maxLoginInFlight, metrics.loginInFlight);
  } else if (kind === "api") {
    metrics.apiInFlight += 1;
    metrics.maxApiInFlight = Math.max(metrics.maxApiInFlight, metrics.apiInFlight);
  }

  try {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      // The response body is intentionally discarded when it is not JSON.
    }
    const durationMs = Number((performance.now() - startedAt).toFixed(2));
    const category = categorizeStatus(response.status);
    recordRequest(metrics, {
      client,
      endpoint,
      method,
      status: response.status,
      durationMs,
      category,
      kind,
    });
    return { ok: response.ok, status: response.status, data, durationMs, category };
  } catch (error) {
    const durationMs = Number((performance.now() - startedAt).toFixed(2));
    const category = controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR";
    recordRequest(metrics, {
      client,
      endpoint,
      method,
      status: null,
      durationMs,
      category,
      kind,
    });
    return { ok: false, status: null, data: null, durationMs, category };
  } finally {
    clearTimeout(timeoutId);
    if (kind === "login") metrics.loginInFlight -= 1;
    else if (kind === "api") metrics.apiInFlight -= 1;
  }
}

async function loginAccount({ metrics, config, account, client, fetchImpl }) {
  metrics.authenticationAttempts += 1;
  const response = await requestJson({
    metrics,
    client,
    endpoint: "POST /api/auth/login",
    url: `${config.baseUrl}/api/auth/login`,
    method: "POST",
    body: { email: account.email.trim(), password: account.password },
    kind: "login",
    fetchImpl,
  });
  const user = response.data?.user;
  const validStudent =
    response.ok &&
    typeof response.data?.token === "string" &&
    typeof user?.role === "string" &&
    user.role.toLowerCase() === "student" &&
    user.is_active === true;
  if (validStudent) {
    metrics.successfulLogins += 1;
    return { success: true, token: response.data.token, user };
  }
  metrics.failedLogins += 1;
  metrics.authenticationFailures += 1;
  increment(metrics.failureCategories, response.ok ? "INVALID_STUDENT_LOGIN_RESPONSE" : "LOGIN_FAILED");
  return { success: false, token: null, user: null };
}

function apiUrl(baseUrl, route, identifier) {
  return `${baseUrl}${route}${encodeURIComponent(String(identifier))}`;
}

async function fetchStudentApis({
  metrics,
  config,
  client,
  token,
  busIdentifier,
  fetchImpl,
  stopCheck,
}) {
  const busesCall = requestJson({
    metrics,
    client,
    endpoint: "GET /api/bus/get-all-buses",
    url: `${config.baseUrl}/api/bus/get-all-buses`,
    token,
    fetchImpl,
  });
  if (!busIdentifier) {
    const busesResult = await busesCall;
    if (busesResult.ok && !Array.isArray(busesResult.data?.buses)) {
      metrics.apiErrors += 1;
      markPayloadFailure(
        metrics,
        client,
        "GET /api/bus/get-all-buses",
        "INVALID_BUS_LIST_RESPONSE",
      );
    }
    increment(metrics.failureCategories, "NO_BUS_ASSIGNMENT");
    metrics.functionalErrors += 1;
    stopCheck?.();
    return { location: null, previewRoomIds: [] };
  }

  const calls = [
    busesCall,
    requestJson({
      metrics,
      client,
      endpoint: "GET /api/bus/location/:busNo",
      url: apiUrl(config.baseUrl, "/api/bus/location/", busIdentifier),
      token,
      fetchImpl,
    }),
    requestJson({
      metrics,
      client,
      endpoint: "GET /api/bus/routes/:busNo",
      url: apiUrl(config.baseUrl, "/api/bus/routes/", busIdentifier),
      token,
      fetchImpl,
    }),
  ];
  const [busesResult, locationResult, routesResult] = await Promise.all(calls);
  const apiResults = [
    { endpoint: "bus-list", result: busesResult, valid: Array.isArray(busesResult.data?.buses) },
    { endpoint: "bus-location", result: locationResult, valid: locationResult.data?.success !== false },
    { endpoint: "bus-routes", result: routesResult, valid: routesResult.data?.success === true },
  ];
  for (const { endpoint, result, valid } of apiResults) {
    if (result.ok && (result.data === null || !valid)) {
      metrics.apiErrors += 1;
      const requestEndpoint = {
        "bus-list": "GET /api/bus/get-all-buses",
        "bus-location": "GET /api/bus/location/:busNo",
        "bus-routes": "GET /api/bus/routes/:busNo",
      }[endpoint];
      markPayloadFailure(
        metrics,
        client,
        requestEndpoint,
        `INVALID_${endpoint.toUpperCase()}_RESPONSE`,
      );
    }
  }
  stopCheck?.();
  const location = locationResult.data;
  const previewRoomIds = [
    location?.previewNumber,
    location?.preview_number,
    location?.effectivePreviewNumber,
  ]
    .filter((value) => value !== null && value !== undefined && String(value).trim())
    .map((value) => String(value).trim())
    .filter((value, index, list) => list.indexOf(value) === index);
  return { location, previewRoomIds };
}

function loadSocketIo() {
  const frontendPackageRoot = path.resolve(__dirname, "..", "..", "frontend");
  try {
    const resolved = require.resolve("socket.io-client", {
      paths: [frontendPackageRoot],
    });
    return require(resolved);
  } catch {
    throw new Error(
      "socket.io-client is unavailable. Install the existing frontend dependencies with npm ci in frontend.",
    );
  }
}

function addSocketDiagnostic(metrics, session, event, details = {}) {
  const socket = session.socket;
  metrics.socketDiagnostics.push({
    timestamp: new Date().toISOString(),
    event,
    client: session.clientLabel,
    socketId: safeSocketId(socket?.id || session.lastSocketId),
    reason: safeDisconnectReason(details.reason),
    description: safeDescription(details.description),
    transport: safeTransportType(details.transport || socket?.io?.engine?.transport?.name),
    reconnectionAttempt: details.attempt ?? null,
    result: details.result || null,
  });
}

function createSocketSession({ io, baseUrl, token, clientLabel, metrics, stopCheck }) {
  const socket = io(baseUrl, {
    autoConnect: false,
    path: "/socket.io",
    transports: ["websocket"],
    auth: { token },
    reconnection: true,
    reconnectionAttempts: SOCKET_POLICY.attempts,
    reconnectionDelay: SOCKET_POLICY.delayMs,
    reconnectionDelayMax: SOCKET_POLICY.maxDelayMs,
    randomizationFactor: SOCKET_POLICY.randomizationFactor,
  });
  const session = {
    socket,
    clientLabel,
    token,
    previewRoomIds: [],
    locationUpdates: 0,
    locationUpdateErrors: 0,
    lastLocationEventAt: null,
    lastLocationAgeMs: null,
    intentionalDisconnect: false,
    controlledInterruption: false,
    reconnectionCount: 0,
    connectCount: 0,
    connectedAt: null,
  };
  socket.on("locationUpdate", (payload) => {
    session.lastLocationEventAt = Date.now();
    session.locationUpdates += 1;
    metrics.locationUpdates += 1;
    if (payload?.error) {
      session.locationUpdateErrors += 1;
      metrics.locationUpdateErrors += 1;
      return;
    }
    const gpsTimestamp = Date.parse(
      payload?.lastSuccessfulGpsUpdate || payload?.lastUpdated || "",
    );
    session.lastLocationAgeMs = Number.isFinite(gpsTimestamp)
      ? Math.max(0, session.lastLocationEventAt - gpsTimestamp)
      : null;
  });
  socket.on("connect", () => {
    session.lastSocketId = socket.id;
    session.connectCount += 1;
    if (!session.connectedAt) session.connectedAt = Date.now();
    metrics.totalSocketConnections += 1;
    if (session.connectCount === 1) metrics.successfulSocketConnections += 1;
    else metrics.reconnectSuccesses += 1;
    addSocketDiagnostic(metrics, session, "connected", {
      result: session.reconnectionCount > 0 ? "reconnected" : "initial",
    });
  });
  socket.on("disconnect", (reason, description) => {
    addSocketDiagnostic(metrics, session, "disconnected", {
      reason,
      description,
    });
    if (session.controlledInterruption) {
      metrics.controlledInterruptions += 1;
      session.controlledInterruption = false;
    } else if (!session.intentionalDisconnect) {
      metrics.unexpectedDisconnections += 1;
    }
    stopCheck?.();
  });
  socket.on("connect_error", (error) => {
    addSocketDiagnostic(metrics, session, "connect-error", {
      description: error?.message,
      result: "failed",
    });
    stopCheck?.();
    stopCheck?.();
  });
  socket.io.on("reconnect_attempt", (attempt) => {
    session.reconnectionCount += 1;
    metrics.reconnectAttempts += 1;
    addSocketDiagnostic(metrics, session, "reconnect-attempt", {
      attempt,
      result: "pending",
    });
  });
  socket.io.on("reconnect_error", (error) => {
    metrics.reconnectionFailures += 1;
    addSocketDiagnostic(metrics, session, "reconnect-error", {
      description: error?.message,
      result: "failed",
    });
    stopCheck?.();
  });
  socket.io.on("reconnect_failed", () => {
    metrics.reconnectionFailures += 1;
    addSocketDiagnostic(metrics, session, "reconnect-failed", {
      attempt: SOCKET_POLICY.attempts,
      result: "failed",
    });
  });
  socket.connect();
  return session;
}

function waitForInitialConnection(socket, timeoutMs = SOCKET_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("Socket connection timed out")), timeoutMs);
    const onConnect = () => finish(null);
    const onError = () => finish(new Error("Socket connection failed"));
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("connect_error", onError);
      if (error) reject(error);
      else resolve();
    }
    socket.once("connect", onConnect);
    socket.once("connect_error", onError);
    if (socket.connected) finish(null);
  });
}

async function verifyAfterRecovery({
  metrics,
  config,
  client,
  token,
  fetchImpl,
  stopCheck,
}) {
  metrics.sessionVerifications += 1;
  const verify = await requestJson({
    metrics,
    client,
    endpoint: "GET /api/auth/verify",
    url: `${config.baseUrl}/api/auth/verify`,
    token,
    fetchImpl,
  });
  const validSession =
    verify.ok &&
    verify.data?.valid === true &&
    verify.data?.user?.role?.toLowerCase() === "student";
  if (!validSession) {
    increment(metrics.failureCategories, "SESSION_RESTORE_FAILED");
    metrics.sessionVerificationFailures += 1;
    stopCheck?.();
  }
  return validSession;
}

async function pollReadiness({
  metrics,
  config,
  fetchImpl,
  activeCycleSince,
  sockets = [],
}) {
  const startedAt = new Date().toISOString();
  try {
    const response = await fetchImpl(`${config.baseUrl}/ready`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    const data = await response.json();
    const snapshot = {
      timestamp: startedAt,
      httpStatus: response.status,
      database: data.database || "UNKNOWN",
      gpsWorkerStarted: Boolean(data.gpsWorker?.started),
      activeCycle: Boolean(data.gpsWorker?.activeCycle),
      lastCycleStatus: data.gpsWorker?.lastCycleStatus || "UNKNOWN",
      lastCycleCompletedAt: data.gpsWorker?.lastCycleCompletedAt || null,
      socketClients: Number.isFinite(data.socketClients) ? data.socketClients : null,
      activeVirtualSockets: sockets.filter((session) => session.socket.connected).length,
      receivedLocationUpdates: metrics.locationUpdates,
      unexpectedDisconnections: metrics.unexpectedDisconnections,
      reconnectionAttempts: metrics.reconnectAttempts,
      runnerRssBytes: process.memoryUsage().rss,
      runnerHeapUsedBytes: process.memoryUsage().heapUsed,
    };
    metrics.readinessSnapshots.push(snapshot);
    if (!response.ok || snapshot.database !== "CONNECTED") {
      return { issue: "MongoDB readiness failed or became unavailable." };
    }
    if (!snapshot.gpsWorkerStarted) {
      return { issue: "GPS worker stopped during the test." };
    }
    const cycleInterval = Number(data.gpsWorker?.syncIntervalMs) || 35_000;
    const lastCycleAt = Date.parse(snapshot.lastCycleCompletedAt || "");
    if (
      Number.isFinite(lastCycleAt) &&
      Date.now() - lastCycleAt > cycleInterval * 3 + 30_000
    ) {
      return { issue: "GPS worker missed its expected cycle window." };
    }
    if (snapshot.activeCycle) {
      if (!activeCycleSince.value) activeCycleSince.value = Date.now();
      if (Date.now() - activeCycleSince.value > cycleInterval * 2) {
        return { issue: "GPS worker cycle remained active beyond two intervals." };
      }
    } else {
      activeCycleSince.value = null;
    }
    return { issue: null };
  } catch {
    metrics.readinessSnapshots.push({
      timestamp: startedAt,
      httpStatus: null,
      database: "UNAVAILABLE",
      gpsWorkerStarted: null,
      activeCycle: null,
      lastCycleStatus: "UNAVAILABLE",
      lastCycleCompletedAt: null,
      socketClients: null,
      activeVirtualSockets: sockets.filter((session) => session.socket.connected).length,
      receivedLocationUpdates: metrics.locationUpdates,
      unexpectedDisconnections: metrics.unexpectedDisconnections,
      reconnectionAttempts: metrics.reconnectAttempts,
      runnerRssBytes: process.memoryUsage().rss,
      runnerHeapUsedBytes: process.memoryUsage().heapUsed,
    });
    return { issue: "Backend readiness endpoint became unavailable." };
  }
}

function evaluateAndRecordStop(metrics, readinessIssue) {
  const reasons = getStopReasons(
    {
      plannedClients: metrics.plannedClients,
      authenticationAttempts:
        metrics.authenticationAttempts +
        metrics.apiRequests +
        metrics.sessionVerifications,
      authenticationFailures:
        metrics.authenticationFailures +
        metrics.apiAuthenticationFailures +
        metrics.sessionVerificationFailures,
      apiRequests: metrics.apiRequests,
      api5xxErrors: metrics.api5xxErrors,
      connectionFailures: metrics.connectionFailures,
      successfulSocketConnections: metrics.successfulSocketConnections,
      totalSocketConnectionsIncludingReconnects: metrics.totalSocketConnections,
      unexpectedDisconnections: metrics.unexpectedDisconnections,
      reconnectionFailures: metrics.reconnectionFailures,
    },
    readinessIssue,
  );
  if (metrics.functionalErrors > 0) {
    reasons.push("one or more clients could not complete the assigned-bus flow");
  }
  if (metrics.sessionVerificationFailures > 0) {
    reasons.push("session verification failed after reconnection");
  }
  if (metrics.staleUpdateClients > 0) {
    reasons.push("one or more clients stopped receiving location updates");
  }
  for (const reason of reasons) {
    if (!metrics.stopReasons.includes(reason)) metrics.stopReasons.push(reason);
  }
  return reasons.length > 0;
}

function updateStaleLocationMetrics(metrics, sessions) {
  const now = Date.now();
  for (const session of sessions) {
    const lastActivity = session.lastLocationEventAt || session.connectedAt;
    if (lastActivity && now - lastActivity > LOCATION_EVENT_TIMEOUT_MS) {
      session.staleUpdateDetected = true;
    }
  }
  metrics.staleUpdateClients = sessions.filter(
    (session) => session.staleUpdateDetected,
  ).length;
}

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, ms);
    function done() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    if (signal) {
      if (signal.aborted) done();
      else signal.addEventListener("abort", done, { once: true });
    }
  });
}

function buildReport({ config, metrics, startedAt, endedAt, accounts }) {
  const isLoginScenario = config.scenario === "login";
  const loginLatencies = metrics.requests
    .filter((request) => request.kind === "login")
    .map((request) => request.durationMs);
  const apiLatencyByEndpoint = {};
  for (const request of metrics.requests.filter((item) => item.kind === "api")) {
    (apiLatencyByEndpoint[request.endpoint] ||= []).push(request.durationMs);
  }
  const apiLatencySummaries = Object.fromEntries(
    Object.entries(apiLatencyByEndpoint).map(([endpoint, samples]) => [
      endpoint,
      summarizeLatencies(samples),
    ]),
  );
  const clientsReceivingUpdates = isLoginScenario
    ? null
    : metrics.clientResults.filter((client) => client.locationUpdates > 0).length;
  const zeroUpdateClients = isLoginScenario
    ? null
    : Math.max(0, metrics.plannedClients - clientsReceivingUpdates);
  const staleUpdateClients = metrics.clientResults.filter(
    (client) => client.lastLocationEventAgeMs !== null &&
      client.lastLocationEventAgeMs > LOCATION_EVENT_TIMEOUT_MS,
  ).length;
  metrics.zeroUpdateClients = zeroUpdateClients;
  metrics.staleUpdateClients = staleUpdateClients;

  const allLoginsPassed =
    metrics.successfulLogins === metrics.authenticationAttempts &&
    metrics.authenticationFailures === 0;
  const allApisPassed = metrics.apiErrors === 0 && metrics.functionalErrors === 0;
  const allSocketsPassed =
    isLoginScenario ||
    (metrics.connectionFailures === 0 &&
      metrics.unexpectedDisconnections === 0 &&
      zeroUpdateClients === 0 &&
      staleUpdateClients === 0 &&
      metrics.sessionVerificationFailures === 0);
  const pass =
    allLoginsPassed &&
    allApisPassed &&
    allSocketsPassed &&
    metrics.stopReasons.length === 0;
  return {
    generatedAt: new Date().toISOString(),
    target: config.baseUrl,
    environment: config.baseUrl.startsWith("http://") ? "local" : "allowlisted-staging",
    scenario: config.scenario,
    virtualClients: config.clients,
    uniqueAccountsInFixture: accounts.length,
    uniqueAccountsUsed: metrics.uniqueAccounts,
    accountReuseCount: metrics.accountReuseCount,
    accountReuseFactor: Number(
      (config.clients / metrics.uniqueAccounts).toFixed(2),
    ),
    authentication: {
      attempts: metrics.authenticationAttempts,
      successful: metrics.successfulLogins,
      failed: metrics.failedLogins,
      apiAuthenticationFailures: metrics.apiAuthenticationFailures,
      recoverySessionVerifications: metrics.sessionVerifications,
      recoverySessionVerificationFailures: metrics.sessionVerificationFailures,
      activeStudentResponsesVerified: metrics.successfulLogins,
      concurrentRequestsMaximum: metrics.maxLoginInFlight,
      latency: summarizeLatencies(loginLatencies),
      serverStageTimings:
        "unavailable in this client-side report; consult sanitized backend login diagnostics",
    },
    api: {
      requestCount: metrics.apiRequests,
      errors: metrics.apiErrors,
      functionalErrors: metrics.functionalErrors,
      fiveXxErrors: metrics.api5xxErrors,
      statusCodes: metrics.statuses,
      failureCategories: metrics.failureCategories,
      latencyByEndpoint: apiLatencySummaries,
      concurrentRequestsMaximum: metrics.maxApiInFlight,
    },
    sockets: {
      successfulConnections: metrics.successfulSocketConnections,
      totalConnectionsIncludingReconnects: metrics.totalSocketConnections,
      connectionFailures: metrics.connectionFailures,
      unexpectedDisconnections: metrics.unexpectedDisconnections,
      controlledInterruptions: metrics.controlledInterruptions,
      reconnectionAttempts: metrics.reconnectAttempts,
      reconnectionSuccesses: metrics.reconnectSuccesses,
      reconnectionFailures: metrics.reconnectionFailures,
      locationUpdates: metrics.locationUpdates,
      locationUpdateErrors: metrics.locationUpdateErrors,
      clientsReceivingUpdates,
      gpsTimestampAgeAtReceiveMs: summarizeLatencies(
        metrics.clientResults
          .map((client) => client.gpsUpdateAgeAtReceiveMs)
          .filter(Number.isFinite),
      ),
      clientsReceivingZeroUpdates: zeroUpdateClients,
      clientsWithStaleUpdates: staleUpdateClients,
      eventDeliveryPercentage:
        isLoginScenario || metrics.plannedClients === 0
          ? null
          : Number(
              (
                (clientsReceivingUpdates / metrics.plannedClients) *
                100
              ).toFixed(2),
            ),
      updateAgeAtReceive: "GPS timestamp age, not network delivery latency",
    },
    durationMs: Number((endedAt - startedAt).toFixed(2)),
    stopReasons: metrics.stopReasons,
    readinessSnapshots: metrics.readinessSnapshots,
    backendMetrics: metrics.backendMetrics,
    requests: metrics.requests,
    clients: metrics.clientResults,
    socketDiagnostics: metrics.socketDiagnostics,
    pass,
    successfulLoginPercentage:
      metrics.authenticationAttempts === 0
        ? null
        : Number(
            ((metrics.successfulLogins / metrics.authenticationAttempts) * 100).toFixed(2),
          ),
    apiSuccessPercentage:
      metrics.apiRequests === 0
        ? null
        : Number(
            (((metrics.apiRequests - metrics.apiErrors) / metrics.apiRequests) * 100).toFixed(2),
          ),
    socketConnectionSuccessPercentage:
      isLoginScenario || metrics.plannedClients === 0
        ? null
        : Number(
            ((metrics.successfulSocketConnections / metrics.plannedClients) * 100).toFixed(2),
          ),
  };
}

function formatSummary(report, files) {
  const latency = report.authentication.latency;
  return [
    "# BTMS capacity test result",
    "",
    `- Timestamp: ${report.generatedAt}`,
    `- Target: ${report.target} (${report.environment})`,
    `- Scenario: ${report.scenario}; virtual clients: ${report.virtualClients}`,
    `- Unique accounts used: ${report.uniqueAccountsUsed}; reuse count: ${report.accountReuseCount}; reuse factor: ${report.accountReuseFactor}x`,
    `- Authentication: ${report.authentication.successful}/${report.authentication.attempts} successful; ${report.authentication.failed} failed`,
    `- Successful login percentage: ${report.successfulLoginPercentage ?? "n/a"}%`,
    `- Login latency (ms): avg ${latency.averageMs ?? "n/a"}, p50 ${latency.p50Ms ?? "n/a"}, p90 ${latency.p90Ms ?? "n/a"}, p95 ${latency.p95Ms ?? "n/a"}, p99 ${latency.p99Ms ?? "n/a"}, max ${latency.maxMs ?? "n/a"}`,
    `- API: ${report.api.requestCount} requests; ${report.api.errors} errors; ${report.api.fiveXxErrors} 5xx`,
    `- API success percentage: ${report.apiSuccessPercentage ?? "n/a"}%`,
    `- Sockets: ${report.sockets.successfulConnections} successful connections; ${report.sockets.unexpectedDisconnections} unexpected disconnections; ${report.sockets.reconnectionAttempts} attempts / ${report.sockets.reconnectionSuccesses} successful reconnects`,
    `- Socket connection success percentage: ${report.socketConnectionSuccessPercentage ?? "n/a"}%`,
    `- Location events: ${report.sockets.locationUpdates}; zero-update clients: ${report.sockets.clientsReceivingZeroUpdates}; stale-update clients: ${report.sockets.clientsWithStaleUpdates}`,
    `- Location event delivery percentage: ${report.sockets.eventDeliveryPercentage ?? "n/a"}%`,
    `- Duration: ${(report.durationMs / 1000).toFixed(2)} seconds`,
    `- Result: ${report.pass ? "PASS" : "FAIL"}`,
    `- Stop reasons: ${report.stopReasons.length ? report.stopReasons.join("; ") : "none"}`,
    "- Limitation: repeated virtual clients reuse account JWTs; this is not evidence for the same number of distinct student identities.",
    "- Limitation: backend CPU, memory, process restarts, MongoDB pool pressure, and true network event-delivery latency are not exposed by the inspected endpoints.",
    "",
    `Raw JSON: ${path.basename(files.json)}`,
    `Raw CSV: ${path.basename(files.csv)}`,
    "",
  ].join("\n");
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function writeReports(report) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const timestamp = report.generatedAt.replace(/[:.]/g, "-");
  const prefix = `capacity-${report.scenario}-${report.virtualClients}-${timestamp}`;
  const files = {
    json: path.join(REPORTS_DIR, `${prefix}.json`),
    csv: path.join(REPORTS_DIR, `${prefix}.csv`),
    markdown: path.join(REPORTS_DIR, `${prefix}.md`),
  };
  const csvRows = [
    ["recordType", "client", "endpoint", "method", "status", "durationMs", "category", "locationUpdates"],
    ...report.requests.map((request) => [
      "request",
      request.client,
      request.endpoint,
      request.method,
      request.status,
      request.durationMs,
      request.category,
      "",
    ]),
    ...report.clients.map((client) => [
      "client",
      client.client,
      "",
      "",
      "",
      "",
      client.status,
      client.locationUpdates,
    ]),
  ];
  fs.writeFileSync(files.json, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  fs.writeFileSync(
    files.csv,
    `${csvRows.map((row) => row.map(csvEscape).join(",")).join("\n")}\n`,
    { flag: "wx" },
  );
  fs.writeFileSync(files.markdown, formatSummary(report, files), { flag: "wx" });
  return files;
}

async function runCapacityTest({
  config,
  accounts,
  fetchImpl = fetch,
  ioFactory,
}) {
  validateTarget(config.baseUrl);
  validateCapacityLimits({
    clients: config.clients,
    rampMs: config.rampMs,
    holdMs: config.holdMs,
    requestTimeoutMs: config.requestTimeoutMs || REQUEST_TIMEOUT_MS,
    reconnectionAttempts:
      config.reconnectionAttempts ?? SOCKET_POLICY.attempts,
    totalDurationMs:
      config.rampMs +
      config.holdMs +
      (config.requestTimeoutMs || REQUEST_TIMEOUT_MS) +
      SOCKET_TIMEOUT_MS +
      LOCATION_EVENT_TIMEOUT_MS +
      (config.reconnectionAttempts ?? SOCKET_POLICY.attempts) *
        SOCKET_POLICY.maxDelayMs,
  });
  validateAccounts(accounts);
  const assignments = assignVirtualClients(accounts, config.clients);
  const uniqueAccountCount =
    config.scenario === "login"
      ? Math.min(accounts.length, new Set(assignments.map((item) => item.accountIndex)).size)
      : Math.min(config.clients, accounts.length);
  const metrics = createMetrics(config, uniqueAccountCount);
  const sockets = [];
  const abortController = new AbortController();
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    abortController.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const startedAt = performance.now();
  const startTimestamp = new Date().toISOString();
  let readinessIssue = null;
  let readinessTimer = null;
  let activeCycleSince = { value: null };
  let holdCompleted = false;
  let io;
  let accountLogins = [];

  try {
    if (config.scenario === "login") {
      const startTogether = Promise.withResolvers
        ? Promise.withResolvers()
        : (() => {
            let release;
            const promise = new Promise((resolve) => { release = resolve; });
            return { promise, resolve: release };
          })();
      const logins = assignments.map(async (assignment, index) => {
        await startTogether.promise;
        const result = await loginAccount({
          metrics,
          config,
          account: assignment.account,
          client: assignment.label,
          fetchImpl,
        });
        if (result.success) result.token = null;
        if (evaluateAndRecordStop(metrics, readinessIssue)) abortController.abort();
        return { ...result, accountIndex: assignment.accountIndex, label: assignment.label, index };
      });
      startTogether.resolve();
      accountLogins = await Promise.all(logins);
    } else {
      const accountsToAuthenticate = accounts.slice(0, uniqueAccountCount);
      const startGate = Promise.withResolvers
        ? Promise.withResolvers()
        : (() => {
            let release;
            const promise = new Promise((resolve) => { release = resolve; });
            return { promise, resolve: release };
          })();
      const loginTasks = accountsToAuthenticate.map(async (account, index) => {
        await startGate.promise;
        const result = await loginAccount({
          metrics,
          config,
          account,
          client: accountClientLabel(index),
          fetchImpl,
        });
        if (evaluateAndRecordStop(metrics, readinessIssue)) abortController.abort();
        return { ...result, accountIndex: index };
      });
      startGate.resolve();
      accountLogins = await Promise.all(loginTasks);
    }

    if (interrupted) metrics.stopReasons.push("interrupted by operator");
    if (evaluateAndRecordStop(metrics, readinessIssue)) {
      // Do not open sockets after authentication has breached a stop threshold.
    } else if (config.scenario !== "login") {
      const initialReadiness = await pollReadiness({
        metrics,
        config,
        fetchImpl,
        activeCycleSince,
        sockets,
      });
      readinessIssue = initialReadiness.issue;
      if (evaluateAndRecordStop(metrics, readinessIssue)) abortController.abort();
      const ioClient = ioFactory || loadSocketIo();
      io = typeof ioClient === "function" ? ioClient : ioClient.io;
      const loginByAccountIndex = new Map(
        accountLogins.map((result) => [result.accountIndex, result]),
      );
      const clientTasks = [];
      const rampStart = performance.now();
      const spacing = config.clients > 1 ? config.rampMs / (config.clients - 1) : 0;

      for (let index = 0; index < assignments.length; index += 1) {
        if (abortController.signal.aborted || metrics.stopReasons.length) break;
        const dueAt = rampStart + index * spacing;
        await sleep(Math.max(0, dueAt - performance.now()), abortController.signal);
        if (abortController.signal.aborted || metrics.stopReasons.length) break;
        const assignment = assignments[index];
        const login = loginByAccountIndex.get(assignment.accountIndex);
        if (!login?.success) {
          metrics.connectionFailures += 1;
          metrics.clientResults.push({
            client: assignment.label,
            status: "authentication-failed",
            locationUpdates: 0,
            lastLocationEventAgeMs: null,
          });
          evaluateAndRecordStop(metrics, readinessIssue);
          continue;
        }

        const clientResult = {
          client: assignment.label,
          status: "starting",
          locationUpdates: 0,
          lastLocationEventAgeMs: null,
        };
        metrics.clientResults.push(clientResult);
        const session = createSocketSession({
          io,
          baseUrl: config.baseUrl,
          token: login.token,
          clientLabel: assignment.label,
          metrics,
          stopCheck: () => {
            if (evaluateAndRecordStop(metrics, readinessIssue)) abortController.abort();
          },
        });
        sockets.push(session);
        const sessionTask = (async () => {
          try {
            const [connection, api] = await Promise.all([
              waitForInitialConnection(session.socket),
              fetchStudentApis({
                metrics,
                config,
                client: assignment.label,
                token: login.token,
                busIdentifier: login.user.bus_no || login.user.previewNumber,
                fetchImpl,
                stopCheck: () => {
                  if (evaluateAndRecordStop(metrics, readinessIssue)) abortController.abort();
                },
              }),
            ]);
            void connection;
            session.previewRoomIds = api.previewRoomIds;
            for (const preview of session.previewRoomIds) {
              session.socket.emit("join-bus", preview);
            }
            if (api.location && session.socket.connected) {
              const locationIdentifier =
                login.user.previewNumber || api.location.previewNumber ||
                login.user.bus_no || "";
              if (locationIdentifier) {
                session.socket.emit("request-bus-location", locationIdentifier);
              }
            }
            if (!session.previewRoomIds.length) {
              increment(metrics.failureCategories, "NO_PREVIEW_ROOM");
            }
            clientResult.status = "active";
          } catch {
            metrics.connectionFailures += 1;
            clientResult.status = "connection-failed";
            evaluateAndRecordStop(metrics, readinessIssue);
          }
        })();
        clientTasks.push(sessionTask);
      }

      await Promise.allSettled(clientTasks);
      readinessTimer = setInterval(async () => {
        if (abortController.signal.aborted || readinessIssue) return;
        const status = await pollReadiness({
          metrics,
          config,
          fetchImpl,
          activeCycleSince,
          sockets,
        });
        readinessIssue = status.issue;
        updateStaleLocationMetrics(metrics, sockets);
        if (evaluateAndRecordStop(metrics, readinessIssue)) abortController.abort();
      }, READINESS_INTERVAL_MS);

      if (!abortController.signal.aborted && !metrics.stopReasons.length) {
        if (config.scenario === "recovery") {
          await sleep(5_000, abortController.signal);
          const recoveryTasks = sockets.map(async (session) => {
            if (!session.socket.connected || abortController.signal.aborted) return;
            session.controlledInterruption = true;
            const reconnected = new Promise((resolve) => {
              const timer = setTimeout(() => finish(false), SOCKET_TIMEOUT_MS);
              const onConnect = () => finish(true);
              function finish(value) {
                clearTimeout(timer);
                session.socket.off("connect", onConnect);
                resolve(value);
              }
              session.socket.once("connect", onConnect);
              const engine = session.socket.io.engine;
              if (typeof engine?.close !== "function") {
                session.controlledInterruption = false;
                finish(false);
                return;
              }
              engine.close();
            });
            const recovered = await reconnected;
            if (!recovered) {
              metrics.reconnectionFailures += 1;
              increment(metrics.failureCategories, "CONTROLLED_RECOVERY_FAILED");
              evaluateAndRecordStop(metrics, readinessIssue);
              return;
            }
            await verifyAfterRecovery({
              metrics,
              config,
              client: session.clientLabel,
              token: session.token,
              fetchImpl,
              stopCheck: () => {
                if (evaluateAndRecordStop(metrics, readinessIssue)) abortController.abort();
              },
            });
            const assignment = assignments.find((item) => item.label === session.clientLabel);
            const login = assignment && loginByAccountIndex.get(assignment.accountIndex);
            const identifier = login?.user?.bus_no || login?.user?.previewNumber;
            if (identifier) {
              await fetchStudentApis({
                metrics,
                config,
                client: session.clientLabel,
                token: session.token,
                busIdentifier: identifier,
                fetchImpl,
                stopCheck: () => {
                  if (evaluateAndRecordStop(metrics, readinessIssue)) abortController.abort();
                },
              });
              const preview = login?.user?.previewNumber;
              if (preview) session.socket.emit("join-bus", preview);
              session.socket.emit(
                "request-bus-location",
                login?.user?.previewNumber || identifier,
              );
            }
          });
          await Promise.allSettled(recoveryTasks);
        }
        const holdStartedAt = performance.now();
        const holdTimer = setInterval(() => {
          if (abortController.signal.aborted) return;
          const elapsedMs = performance.now() - holdStartedAt;
          updateStaleLocationMetrics(metrics, sockets);
          if (metrics.staleUpdateClients > 0) {
            evaluateAndRecordStop(metrics, readinessIssue);
            abortController.abort();
            return;
          }
          if (elapsedMs >= config.holdMs) {
            holdCompleted = true;
            abortController.abort();
          }
        }, Math.min(5_000, config.holdMs || 5_000));
        await new Promise((resolve) => {
          const check = setInterval(() => {
            if (abortController.signal.aborted) {
              clearInterval(check);
              clearInterval(holdTimer);
              resolve();
            }
          }, 250);
        });
      }
    }
  } finally {
    if (readinessTimer) clearInterval(readinessTimer);
    cleanupSockets(sockets);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }

  for (const session of sockets) {
    const result = metrics.clientResults.find((client) => client.client === session.clientLabel);
    if (!result) continue;
    result.locationUpdates = session.locationUpdates;
    result.locationUpdateErrors = session.locationUpdateErrors;
    result.gpsUpdateAgeAtReceiveMs = session.lastLocationAgeMs;
    result.reconnectionAttempts = session.reconnectionCount;
    result.reconnectionSuccesses = Math.max(0, session.connectCount - 1);
    result.lastLocationEventAgeMs = session.lastLocationEventAt
      ? Date.now() - session.lastLocationEventAt
      : null;
    result.status =
      session.staleUpdateDetected
        ? "stale-location-updates"
        : holdCompleted && !interrupted && !metrics.stopReasons.length
          ? "completed"
          : session.socket.connected
          ? "active"
          : interrupted || metrics.stopReasons.length
            ? "stopped"
            : "disconnected";
  }

  if (interrupted && !metrics.stopReasons.includes("interrupted by operator")) {
    metrics.stopReasons.push("interrupted by operator");
  }
  const endedAt = performance.now();
  const report = buildReport({
    config,
    metrics,
    startedAt,
    endedAt,
    accounts,
  });
  report.startedAt = startTimestamp;
  return report;
}

function printReport(report, files) {
  console.log(
    JSON.stringify(
      {
        target: report.target,
        environment: report.environment,
        scenario: report.scenario,
        virtualClients: report.virtualClients,
        uniqueAccountsUsed: report.uniqueAccountsUsed,
        accountReuseCount: report.accountReuseCount,
        successfulLogins: report.authentication.successful,
        failedLogins: report.authentication.failed,
        apiRequests: report.api.requestCount,
        apiErrors: report.api.errors,
        socketConnections: report.sockets.successfulConnections,
        unexpectedDisconnections: report.sockets.unexpectedDisconnections,
        locationUpdates: report.sockets.locationUpdates,
        durationMs: report.durationMs,
        stopReasons: report.stopReasons,
        pass: report.pass,
        reports: Object.fromEntries(
          Object.entries(files).map(([key, value]) => [key, path.relative(process.cwd(), value)]),
        ),
      },
      null,
      2,
    ),
  );
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const config = loadConfiguration(options, env);
  const accounts = readAccounts(config.accountFile);
  const virtualClients = assignVirtualClients(accounts, config.clients);
  const uniqueAccountsUsed =
    config.scenario === "login"
      ? new Set(virtualClients.map((client) => client.accountIndex)).size
      : Math.min(config.clients, accounts.length);
  const loginAttempts = plannedLoginAttempts(config, accounts);
  const preflight = {
    target: config.baseUrl,
    environment: config.baseUrl.startsWith("http://") ? "local" : "allowlisted-staging",
    scenario: config.scenario,
    virtualClients: config.clients,
    holdMinutes: Number((config.holdMs / 60_000).toFixed(2)),
    rampUpSeconds: Number((config.rampMs / 1000).toFixed(2)),
    uniqueAccountsInFixture: accounts.length,
    uniqueAccountsUsed,
    accountReuseCount: config.clients - uniqueAccountsUsed,
    loginRequests: loginAttempts,
    plannedHttpRequestVolume: plannedHttpRequests(config, accounts),
    plannedSocketConnections: config.scenario === "login" ? 0 : config.clients,
    estimatedRisk: "environment-dependent",
    estimatedResourceImpact:
      `${config.clients} simultaneous virtual clients, ` +
      `${config.scenario === "login" ? config.clients : Math.min(config.clients, accounts.length)} login requests, ` +
      `${config.scenario === "login" ? 0 : config.clients * 3} initial authenticated GET requests, ` +
      `${config.scenario === "login" ? 0 : config.clients} WebSocket connections`,
    warning:
      "This run sends real requests to the selected backend. Only use authorized test accounts; no logout or account mutation is performed.",
  };
  console.log("[capacity preflight]", JSON.stringify(preflight, null, 2));
  const report = await runCapacityTest({
    config,
    accounts,
  });
  const files = writeReports(report);
  printReport(report, files);
  return report.pass ? 0 : 1;
}

const invokedEntry = process.argv[1] ? path.resolve(process.argv[1]) : null;
const isDirectScriptEntry =
  require.main === module && invokedEntry && invokedEntry === __filename;

if (isDirectScriptEntry) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(`Capacity test did not start or complete: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  loadConfiguration,
  main,
  parseArguments,
  plannedHttpRequests,
  readAccounts,
  runCapacityTest,
};
