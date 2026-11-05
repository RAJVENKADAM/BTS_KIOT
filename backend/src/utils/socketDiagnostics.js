const SAFE_DISCONNECT_REASONS = new Set([
  "io server disconnect",
  "io client disconnect",
  "server namespace disconnect",
  "client namespace disconnect",
  "ping timeout",
  "transport close",
  "transport error",
  "authentication-required",
  "invalid-or-expired-token",
  "authentication-service-unavailable",
]);
const SAFE_ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "WebSocketError",
]);
const SAFE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ERR_NETWORK",
  "TRANSPORT_ERROR",
]);
const SAFE_DESCRIPTION_MESSAGES = new Set([
  "ping timeout",
  "transport close",
  "transport error",
  "websocket error",
  "xhr poll error",
  "server close",
  "forced close",
  "parse error",
]);

function safeSocketId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
    ? value
    : null;
}

function safeTransportType(value) {
  return typeof value === "string" && /^[a-z-]{1,24}$/i.test(value)
    ? value
    : null;
}

function safeDisconnectReason(value) {
  return typeof value === "string" && SAFE_DISCONNECT_REASONS.has(value)
    ? value
    : value == null
      ? null
      : "other";
}

function safeDescription(description) {
  if (description == null) return null;
  const source =
    typeof description === "string"
      ? { message: description }
      : typeof description === "object"
        ? description
        : {};
  const result = {};

  if (SAFE_ERROR_NAMES.has(source.name)) {
    result.name = source.name;
  }
  if (
    (typeof source.code === "string" && SAFE_ERROR_CODES.has(source.code)) ||
    (typeof source.code === "number" && Number.isFinite(source.code))
  ) {
    result.code = source.code;
  }
  if (typeof source.message === "string") {
    result.message = SAFE_DESCRIPTION_MESSAGES.has(source.message.toLowerCase())
      ? source.message.toLowerCase()
      : "redacted";
  }

  return Object.keys(result).length ? result : { type: typeof description };
}

function logSocketDiagnostic(event, details = {}) {
  const memory = process.memoryUsage();
  const record = {
    category: "socket-diagnostic",
    timestamp: new Date().toISOString(),
    event,
    socketId: safeSocketId(details.socketId),
    disconnectReason: safeDisconnectReason(details.disconnectReason),
    disconnectDescription: safeDescription(details.disconnectDescription),
    transportType: safeTransportType(details.transportType),
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
    pingIntervalMs:
      Number.isFinite(details.pingIntervalMs) && details.pingIntervalMs >= 0
        ? details.pingIntervalMs
        : null,
    pingTimeoutMs:
      Number.isFinite(details.pingTimeoutMs) && details.pingTimeoutMs >= 0
        ? details.pingTimeoutMs
        : null,
    processSignal: ["SIGTERM", "SIGINT", "SIGQUIT", "SIGABRT"].includes(
      details.processSignal,
    )
      ? details.processSignal
      : null,
    processExitCode: Number.isInteger(details.processExitCode)
      ? details.processExitCode
      : null,
    processUptimeSeconds: Number(process.uptime().toFixed(3)),
    memoryUsageBytes: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      external: memory.external,
    },
  };
  console.info("[socket-diagnostic]", JSON.stringify(record));
}

module.exports = {
  logSocketDiagnostic,
  safeDescription,
  safeDisconnectReason,
  safeSocketId,
  safeTransportType,
};
