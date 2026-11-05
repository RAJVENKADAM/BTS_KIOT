"use strict";

const SAFE_DISCONNECT_REASONS = new Set([
  "io server disconnect",
  "io client disconnect",
  "ping timeout",
  "transport close",
  "transport error",
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

function sanitizeSocketDescription(description) {
  if (description == null) return null;
  const source =
    typeof description === "string"
      ? { message: description }
      : typeof description === "object"
        ? description
        : {};
  const sanitized = {};

  if (SAFE_ERROR_NAMES.has(source.name)) {
    sanitized.name = source.name;
  }
  if (
    (typeof source.code === "string" && SAFE_ERROR_CODES.has(source.code)) ||
    (typeof source.code === "number" && Number.isFinite(source.code))
  ) {
    sanitized.code = source.code;
  }
  if (typeof source.message === "string") {
    sanitized.message = SAFE_DESCRIPTION_MESSAGES.has(source.message.toLowerCase())
      ? source.message.toLowerCase()
      : "redacted";
  }

  return Object.keys(sanitized).length
    ? sanitized
    : { type: typeof description };
}

function logSocketDiagnostic(event, socket, details = {}) {
  const reason = details.disconnectReason;
  const socketId =
    socket?.id || socket?.io?.engine?.id || details.socketId || null;
  const record = {
    category: "socket-diagnostic",
    timestamp: new Date().toISOString(),
    event,
    socketId:
      typeof socketId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(socketId)
        ? socketId
        : null,
    disconnectReason:
      typeof reason === "string" && SAFE_DISCONNECT_REASONS.has(reason)
        ? reason
        : reason == null
          ? null
          : "other",
    disconnectDescription: sanitizeSocketDescription(
      details.disconnectDescription,
    ),
    transportType:
      details.transportType ||
      socket?.io?.engine?.transport?.name ||
      socket?.io?.engine?.transport?.constructor?.name ||
      null,
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
    reconnectionTrigger: ["server-disconnect", "app-foreground"].includes(
      details.reconnectionTrigger,
    )
      ? details.reconnectionTrigger
      : null,
  };
  console.info("[socket-diagnostic]", record);
}

module.exports = { logSocketDiagnostic, sanitizeSocketDescription };
