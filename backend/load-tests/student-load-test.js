"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { performance } = require("node:perf_hooks");
const { validateTarget: validateCapacityTarget } = require("./capacity-test-core.cjs");
const {
  safeDescription,
  safeDisconnectReason,
  safeSocketId,
  safeTransportType,
} = require("../src/utils/socketDiagnostics");

const ACCOUNT_COUNT = 20;
const SOCKET_HOLD_MS = 5 * 60 * 1000;
const RECONNECT_AFTER_MS = 60 * 1000;
const SOCKET_TIMEOUT_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const ACCOUNT_FILE = path.join(__dirname, "accounts.json");

const metrics = {
  requests: [],
  requestFailures: [],
  httpStatuses: new Map(),
  httpErrors: new Map(),
  requestErrors: new Map(),
  applicationErrors: new Map(),
  loginSuccesses: 0,
  loginFailures: 0,
  logoutSuccesses: 0,
  logoutFailures: 0,
  socketConnections: 0,
  initialSocketClients: 0,
  socketDisconnections: 0,
  plannedSocketDisconnections: 0,
  cleanupSocketDisconnections: 0,
  unexpectedSocketDisconnections: 0,
  socketConnectionErrors: 0,
  reconnectAttempts: 0,
  reconnectSuccesses: 0,
  locationUpdates: 0,
  locationUpdateErrors: 0,
  locationUpdatesByClient: new Map(),
  locationUpdateErrorsByClient: new Map(),
  unexpectedDisconnectClients: [],
  socketFailures: [],
  socketHoldMs: 0,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function logLoadTestSocketDiagnostic(session, event, details = {}) {
  const socket = session.socket;
  const record = {
    category: "socket-diagnostic",
    timestamp: new Date().toISOString(),
    event,
    socketId: safeSocketId(
      socket?.id || socket?.io?.engine?.id || session.lastSocketId,
    ),
    testClient: session.clientLabel,
    disconnectReason: safeDisconnectReason(details.disconnectReason),
    disconnectDescription: safeDescription(details.disconnectDescription),
    transportType: safeTransportType(
      details.transportType || socket?.io?.engine?.transport?.name,
    ),
    wasConnected:
      typeof details.wasConnected === "boolean" ? details.wasConnected : null,
    reconnectionAttempted:
      typeof details.reconnectionAttempted === "boolean"
        ? details.reconnectionAttempted
        : null,
    reconnectionAttemptNumber:
      Number.isInteger(details.reconnectionAttemptNumber) &&
      details.reconnectionAttemptNumber >= 0
        ? details.reconnectionAttemptNumber
        : null,
    reconnectionResult: ["success", "failed", "pending"].includes(
      details.reconnectionResult,
    )
      ? details.reconnectionResult
      : null,
  };
  console.info("[socket-diagnostic]", JSON.stringify(record));
}

function validateTarget(env = process.env) {
  const configuredUrl =
    env.BTMS_LOAD_TEST_BASE_URL || "http://127.0.0.1:5000";
  return validateCapacityTarget(configuredUrl, env);
}

function readAccounts() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf8"));
  } catch {
    throw new Error(
      "Could not read load-tests/accounts.json. See load-tests/README.md.",
    );
  }

  const accounts = parsed?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== ACCOUNT_COUNT) {
    throw new Error("accounts.json must contain exactly 20 test accounts.");
  }

  const emails = new Set();
  for (const account of accounts) {
    if (
      typeof account?.email !== "string" ||
      typeof account?.password !== "string" ||
      !account.email.trim() ||
      !account.password
    ) {
      throw new Error("Each test account must have an email and password.");
    }
    const normalizedEmail = account.email.trim().toLowerCase();
    if (emails.has(normalizedEmail)) {
      throw new Error("Test account emails must be unique.");
    }
    emails.add(normalizedEmail);
  }

  return accounts;
}

function loadSocketIoClient() {
  try {
    const frontendPackage = path.join(__dirname, "..", "..", "frontend", "package.json");
    return createRequire(frontendPackage)("socket.io-client").io;
  } catch {
    throw new Error(
      "socket.io-client is unavailable. Install the existing frontend dependencies first.",
    );
  }
}

function recordApplicationError(label) {
  increment(metrics.applicationErrors, label);
}

async function requestJson(baseUrl, label, requestPath, token, body, clientLabel) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}${requestPath}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    metrics.requests.push({
      label,
      status: response.status,
      durationMs: performance.now() - startedAt,
    });
    increment(metrics.httpStatuses, String(response.status));
    if (!response.ok) {
      increment(metrics.httpErrors, `${label} (${response.status})`);
      metrics.requestFailures.push({
        client: clientLabel,
        endpoint: label,
        status: response.status,
      });
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      recordApplicationError(`${label}: invalid JSON response`);
    }

    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    const type = error?.name === "AbortError" ? "timeout" : "network error";
    metrics.requests.push({
      label,
      status: null,
      durationMs: performance.now() - startedAt,
    });
    increment(metrics.requestErrors, `${label} (${type})`);
    metrics.requestFailures.push({
      client: clientLabel,
      endpoint: label,
      error: type,
    });
    return { ok: false, status: null, data: null };
  } finally {
    clearTimeout(timeout);
  }
}

function waitForSocketConnect(socket) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.io.off("reconnect_failed", onReconnectFailed);
      resolve(connected);
    };
    const onConnect = () => finish(true);
    const onReconnectFailed = () => finish(false);
    const timeout = setTimeout(() => finish(false), SOCKET_TIMEOUT_MS);

    socket.once("connect", onConnect);
    socket.io.once("reconnect_failed", onReconnectFailed);
    if (socket.connected) finish(true);
  });
}

function makeSocket(io, baseUrl, session) {
  const socket = io(baseUrl, {
    path: "/socket.io",
    transports: ["websocket"],
    auth: { token: session.token },
    autoConnect: false,
    reconnection: true,
    reconnectionAttempts: 3,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 3000,
    timeout: SOCKET_TIMEOUT_MS,
    forceNew: true,
  });
  const observedEngines = new WeakSet();
  const attachEngineDiagnostics = () => {
    const engine = socket.io.engine;
    if (!engine || observedEngines.has(engine)) return;
    observedEngines.add(engine);
    engine.on("close", (reason, description) => {
      logLoadTestSocketDiagnostic(session, "load-test-engine-closed", {
        disconnectReason: reason,
        disconnectDescription: description,
        transportType: engine.transport?.name,
        wasConnected:
          session.lastDisconnectWasConnected ?? session.wasConnected,
        reconnectionAttempted: socket.active,
        reconnectionAttemptNumber: session.reconnectionAttemptNumber || null,
        reconnectionResult: socket.active ? "pending" : null,
      });
    });
  };
  socket.io.on("open", attachEngineDiagnostics);

  socket.on("connect", () => {
    metrics.socketConnections += 1;
    session.lastSocketId =
      socket.id || socket.io.engine?.id || session.lastSocketId;
    const wasPreviouslyConnected = session.wasConnected;
    session.lastDisconnectWasConnected = null;
    if (session.reconnecting || session.hasConnected) {
      metrics.reconnectSuccesses += 1;
    }
    logLoadTestSocketDiagnostic(session, "load-test-client-connected", {
      wasConnected: wasPreviouslyConnected,
      reconnectionAttempted: wasPreviouslyConnected,
      reconnectionAttemptNumber: session.reconnectionAttemptNumber || null,
      reconnectionResult: wasPreviouslyConnected ? "success" : null,
    });
    session.wasConnected = true;
    session.hasConnected = true;
    if (session.previewNumber != null) {
      socket.emit("join-bus", String(session.previewNumber));
    }
    if (session.busIdentifier) {
      socket.emit("request-bus-location", String(session.busIdentifier));
    }
  });
  socket.on("connect_error", (error) => {
    metrics.socketConnectionErrors += 1;
    metrics.socketFailures.push({
      client: session.clientLabel,
      event: "connection error",
    });
    logLoadTestSocketDiagnostic(session, "load-test-client-connect-error", {
      disconnectDescription: error,
      wasConnected: session.wasConnected,
      reconnectionAttempted:
        session.reconnecting || session.hasConnected || socket.active,
      reconnectionAttemptNumber: session.reconnectionAttemptNumber || null,
      reconnectionResult: "failed",
    });
  });
  socket.io.on("reconnect_attempt", (attempt) => {
    metrics.reconnectAttempts += 1;
    session.reconnectionAttemptNumber = attempt;
    logLoadTestSocketDiagnostic(session, "load-test-manager-reconnect-attempt", {
      wasConnected: session.wasConnected,
      reconnectionAttempted: true,
      reconnectionAttemptNumber: attempt,
      reconnectionResult: "pending",
    });
  });
  socket.io.on("reconnect", (attempt) => {
    logLoadTestSocketDiagnostic(session, "load-test-manager-reconnected", {
      wasConnected: session.wasConnected,
      reconnectionAttempted: true,
      reconnectionAttemptNumber: attempt,
      reconnectionResult: "success",
    });
  });
  socket.io.on("reconnect_error", (error) => {
    logLoadTestSocketDiagnostic(session, "load-test-manager-reconnect-error", {
      disconnectDescription: error,
      wasConnected: session.wasConnected,
      reconnectionAttempted: true,
      reconnectionAttemptNumber: session.reconnectionAttemptNumber || null,
      reconnectionResult: "failed",
    });
  });
  socket.io.on("reconnect_failed", () => {
    logLoadTestSocketDiagnostic(session, "load-test-manager-reconnect-failed", {
      wasConnected: session.wasConnected,
      reconnectionAttempted: true,
      reconnectionAttemptNumber: 3,
      reconnectionResult: "failed",
    });
  });
  socket.on("locationUpdate", (payload) => {
    metrics.locationUpdates += 1;
    increment(metrics.locationUpdatesByClient, session.clientLabel);
    if (payload?.error) {
      metrics.locationUpdateErrors += 1;
      increment(metrics.locationUpdateErrorsByClient, session.clientLabel);
    }
  });
  socket.on("disconnect", (reason, description) => {
    metrics.socketDisconnections += 1;
    const wasConnected = session.wasConnected;
    const reconnectionAttempted =
      session.reconnecting ||
      (reason !== "io client disconnect" &&
        reason !== "io server disconnect" &&
        socket.active);
    logLoadTestSocketDiagnostic(session, "load-test-client-disconnected", {
      disconnectReason: reason,
      disconnectDescription: description,
      wasConnected,
      reconnectionAttempted,
      reconnectionAttemptNumber: session.reconnectionAttemptNumber || null,
      reconnectionResult: reconnectionAttempted ? "pending" : null,
    });
    session.lastDisconnectWasConnected = wasConnected;
    session.wasConnected = false;
    if (session.reconnecting) {
      metrics.plannedSocketDisconnections += 1;
    } else if (session.cleaningUp) {
      metrics.cleanupSocketDisconnections += 1;
    } else {
      metrics.unexpectedSocketDisconnections += 1;
      metrics.unexpectedDisconnectClients.push(session.clientLabel);
    }
  });

  return socket;
}

async function connectSocket(io, baseUrl, session) {
  session.socket = makeSocket(io, baseUrl, session);
  const connected = waitForSocketConnect(session.socket);
  session.socket.connect();
  return connected;
}

async function reconnectSocket(session) {
  if (!session.socket?.connected) return false;

  session.reconnecting = true;
  const connected = waitForSocketConnect(session.socket);
  metrics.reconnectAttempts += 1;
  session.reconnectionAttemptNumber += 1;
  logLoadTestSocketDiagnostic(session, "load-test-planned-reconnect-attempt", {
    wasConnected: session.wasConnected,
    reconnectionAttempted: true,
    reconnectionAttemptNumber: session.reconnectionAttemptNumber,
    reconnectionResult: "pending",
  });
  session.socket.disconnect();
  await sleep(250);
  session.socket.connect();
  const reconnected = await connected;
  session.reconnecting = false;

  if (!reconnected) {
    recordApplicationError("Socket reconnection failed");
    logLoadTestSocketDiagnostic(session, "load-test-planned-reconnect-failed", {
      wasConnected: session.wasConnected,
      reconnectionAttempted: true,
      reconnectionAttemptNumber: session.reconnectionAttemptNumber,
      reconnectionResult: "failed",
    });
  }
  return reconnected;
}

async function fetchStudentApis(baseUrl, session) {
  const busList = await requestJson(
    baseUrl,
    "Bus details",
    "/api/bus/get-all-buses",
    session.token,
    undefined,
    session.clientLabel,
  );
  const buses = [
    ...(Array.isArray(busList.data?.buses) ? busList.data.buses : []),
    ...(Array.isArray(busList.data?.alteredBuses) ? busList.data.alteredBuses : []),
  ];
  if (busList.ok && !Array.isArray(busList.data?.buses)) {
    recordApplicationError("Bus details: unexpected response shape");
  }

  const firstPreview = buses.find((bus) => bus?.previewNumber != null)?.previewNumber;
  session.busIdentifier =
    session.busIdentifier || session.previewNumber || firstPreview || null;
  if (!session.busIdentifier) {
    recordApplicationError("Bus routes and live location: no bus identifier");
    return;
  }

  const encodedBus = encodeURIComponent(String(session.busIdentifier));
  const routes = await requestJson(
    baseUrl,
    "Bus routes",
    `/api/bus/routes/${encodedBus}`,
    session.token,
    undefined,
    session.clientLabel,
  );
  if (routes.ok && routes.data?.success === false) {
    recordApplicationError("Bus routes: API reported failure");
  }

  const location = await requestJson(
    baseUrl,
    "Live location",
    `/api/bus/location/${encodedBus}`,
    session.token,
    undefined,
    session.clientLabel,
  );
  if (location.ok && location.data?.success === false) {
    recordApplicationError("Live location: API reported failure");
  }

  session.previewNumber =
    session.previewNumber ?? location.data?.previewNumber ?? null;
}

function printCounts(title, counts) {
  console.log(`\n${title}`);
  if (!counts.size) {
    console.log("  None");
    return;
  }
  for (const [label, count] of [...counts.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    console.log(`  ${label}: ${count}`);
  }
}

function printResponseTimes() {
  const grouped = new Map();
  for (const request of metrics.requests) {
    const samples = grouped.get(request.label) || [];
    samples.push(request.durationMs);
    grouped.set(request.label, samples);
  }

  console.log("\nAPI response times (ms)");
  if (!grouped.size) {
    console.log("  No API requests");
    return;
  }

  for (const [label, samples] of grouped) {
    const sorted = [...samples].sort((a, b) => a - b);
    const percentile = (value) => sorted[Math.max(0, Math.ceil(value * sorted.length) - 1)];
    const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    console.log(
      `  ${label}: n=${samples.length}, avg=${average.toFixed(1)}, p50=${percentile(0.50).toFixed(1)}, p95=${percentile(0.95).toFixed(1)}, p99=${percentile(0.99).toFixed(1)}, min=${sorted[0].toFixed(1)}, max=${sorted.at(-1).toFixed(1)}`,
    );
  }
}

function printFailures(title, failures) {
  console.log(`\n${title}`);
  if (!failures.length) {
    console.log("  None");
    return;
  }
  for (const failure of failures) {
    const client = failure.client ? `${failure.client}: ` : "";
    const result = failure.status
      ? `HTTP ${failure.status}`
      : failure.error || failure.event;
    console.log(`  ${client}${failure.endpoint || "Socket.IO"} — ${result}`);
  }
}

function printSummary(startedAt, fatalError) {
  const totalDurationMs = performance.now() - startedAt;
  console.log("\n=== BTMS student load-test summary ===");
  console.log(`Successful student logins: ${metrics.loginSuccesses}/${ACCOUNT_COUNT}`);
  console.log(`Failed student logins: ${metrics.loginFailures}`);
  console.log(`Successful logout responses: ${metrics.logoutSuccesses}`);
  console.log(`Failed logout responses: ${metrics.logoutFailures}`);
  console.log(`Initial successful socket clients: ${metrics.initialSocketClients}`);
  console.log(`Successful socket connection events (including reconnects): ${metrics.socketConnections}`);
  console.log(`Socket disconnections: ${metrics.socketDisconnections}`);
  console.log(`  During planned reconnections: ${metrics.plannedSocketDisconnections}`);
  console.log(`  During cleanup: ${metrics.cleanupSocketDisconnections}`);
  console.log(`  Unexpected: ${metrics.unexpectedSocketDisconnections}`);
  console.log(`Socket connection errors: ${metrics.socketConnectionErrors}`);
  console.log(
    `Reconnections: ${metrics.reconnectSuccesses}/${metrics.reconnectAttempts} successful`,
  );
  console.log(`Received locationUpdate events: ${metrics.locationUpdates}`);
  console.log(`Location updates carrying an error: ${metrics.locationUpdateErrors}`);
  printCounts("locationUpdate events by test client", metrics.locationUpdatesByClient);
  printCounts("locationUpdate errors by test client", metrics.locationUpdateErrorsByClient);
  console.log(`Socket test window: ${(metrics.socketHoldMs / 1000).toFixed(1)} seconds`);
  console.log(`Total test duration: ${(totalDurationMs / 1000).toFixed(1)} seconds`);
  if (fatalError) console.log(`Stopped early: ${fatalError}`);

  printResponseTimes();
  printCounts("HTTP response status codes", metrics.httpStatuses);
  printCounts("HTTP errors by endpoint and status", metrics.httpErrors);
  printCounts("Request errors", metrics.requestErrors);
  printFailures("Failed HTTP requests (client labels are non-identifying)", metrics.requestFailures);
  printFailures("Socket connection errors", metrics.socketFailures);
  printFailures("Unexpected socket disconnections", metrics.unexpectedDisconnectClients.map((client) => ({
    client,
    event: "unexpected disconnection",
  })));
  printCounts("API / socket validation errors", metrics.applicationErrors);
}

async function run() {
  const startedAt = performance.now();
  const authenticatedSessions = [];
  let fatalError = null;
  let baseUrl = null;

  try {
    baseUrl = validateTarget();
    const accounts = readAccounts();
    const io = loadSocketIoClient();

    console.log(`Target: ${new URL(baseUrl).origin}`);
    console.log(`Sending ${ACCOUNT_COUNT} login requests simultaneously.`);

    const loginResults = await Promise.all(
      accounts.map(async (account, index) => {
        const clientLabel = `Client ${String(index + 1).padStart(2, "0")}`;
        const result = await requestJson(
          baseUrl,
          "Login",
          "/api/auth/login",
          null,
          { email: account.email.trim(), password: account.password },
          clientLabel,
        );
        const token = result.data?.token;
        const user = result.data?.user;

        if (result.ok && token) {
          metrics.locationUpdatesByClient.set(clientLabel, 0);
          metrics.locationUpdateErrorsByClient.set(clientLabel, 0);
          const session = {
            token,
            clientLabel,
            busIdentifier: user?.bus_no || null,
            previewNumber: user?.previewNumber ?? null,
            socket: null,
            reconnecting: false,
            hasConnected: false,
            wasConnected: false,
            lastDisconnectWasConnected: null,
            lastSocketId: null,
            reconnectionAttemptNumber: 0,
            cleaningUp: false,
          };
          authenticatedSessions.push(session);
          if (String(user?.role || "").toLowerCase() === "student") {
            metrics.loginSuccesses += 1;
            return session;
          }
        }

        metrics.loginFailures += 1;
        if (result.ok && token) {
          recordApplicationError("Login: account is not a student");
        }
        return null;
      }),
    );
    const studentSessions = loginResults.filter(Boolean);
    console.log(`Student logins ready: ${studentSessions.length}/${ACCOUNT_COUNT}.`);

    await Promise.all(
      studentSessions.map((session) => fetchStudentApis(baseUrl, session)),
    );

    console.log(`Opening up to ${studentSessions.length} independent socket connections.`);
    await Promise.all(
      studentSessions.map(async (session) => {
        const connected = await connectSocket(io, baseUrl, session);
        if (!connected) {
          recordApplicationError("Initial socket connection failed");
          metrics.socketFailures.push({
            client: session.clientLabel,
            event: "initial connection failed",
          });
        }
      }),
    );

    const connectedSessions = studentSessions.filter(
      (session) => session.socket?.connected,
    );
    metrics.initialSocketClients = connectedSessions.length;
    if (connectedSessions.length) {
      const holdStartedAt = performance.now();
      const reconnectTask = (async () => {
        await sleep(RECONNECT_AFTER_MS);
        for (const session of connectedSessions) {
          await reconnectSocket(session);
          await sleep(250);
        }
      })();

      await sleep(SOCKET_HOLD_MS);
      await reconnectTask;
      metrics.socketHoldMs = performance.now() - holdStartedAt;
    } else if (studentSessions.length) {
      recordApplicationError("No socket connections remained for the hold window");
    }
  } catch (error) {
    fatalError = error?.message || "Unexpected test setup error.";
  } finally {
    for (const session of authenticatedSessions) {
      if (session.socket) {
        session.cleaningUp = true;
        logLoadTestSocketDiagnostic(
          session,
          "load-test-cleanup-disconnect-requested",
          {
            disconnectReason: "io client disconnect",
            wasConnected: session.socket.connected,
            reconnectionAttempted: false,
          },
        );
        if (session.previewNumber != null) {
          session.socket.emit("leave-bus", String(session.previewNumber));
        }
        session.socket.disconnect();
      }
    }

    if (authenticatedSessions.length) {
      if (baseUrl) {
        await Promise.all(
          authenticatedSessions.map(async (session) => {
            const result = await requestJson(
              baseUrl,
              "Logout",
              "/api/auth/logout",
              session.token,
              {},
              session.clientLabel,
            );
            if (result.ok) metrics.logoutSuccesses += 1;
            else metrics.logoutFailures += 1;
          }),
        );
      } else {
        metrics.logoutFailures += authenticatedSessions.length;
      }
    }

    printSummary(startedAt, fatalError);
    if (
      fatalError ||
      metrics.loginFailures ||
      metrics.logoutFailures ||
      metrics.httpErrors.size ||
      metrics.requestErrors.size ||
      metrics.applicationErrors.size ||
      metrics.unexpectedSocketDisconnections ||
      metrics.reconnectAttempts !== metrics.reconnectSuccesses
    ) {
      process.exitCode = 1;
    }
  }
}

if (require.main === module) {
  run().catch(() => {
    console.error("Load test stopped due to an unexpected error.");
    process.exitCode = 1;
  });
}

module.exports = { run, validateTarget };
