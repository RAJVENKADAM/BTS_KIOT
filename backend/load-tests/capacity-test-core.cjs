"use strict";

const net = require("node:net");

const STAGES = Object.freeze([20, 50, 100, 250, 500]);
const PRODUCTION_HOSTS = new Set(["bts-kiot.onrender.com"]);
const MAX_RAMP_MS = 10 * 60 * 1000;
const MAX_HOLD_MS = 2 * 60 * 60 * 1000;
const MAX_TEST_DURATION_MS = 2 * 60 * 60 * 1000;
const MAX_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_RECONNECTION_ATTEMPTS = 5;

function normalizeHostname(hostname) {
  return String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
}

function isLoopback(hostname) {
  const host = normalizeHostname(hostname);
  if (host === "localhost") return true;
  if (net.isIPv4(host)) return Number(host.split(".")[0]) === 127;
  return net.isIPv6(host) && host === "::1";
}

function validateTarget(configuredUrl, env = process.env) {
  let url;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new Error("Invalid target URL.");
  }

  const host = normalizeHostname(url.hostname);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("Target must be an HTTP(S) origin without credentials, path, query, or fragment.");
  }

  if (PRODUCTION_HOSTS.has(host)) {
    throw new Error("The production host is permanently blocked for load testing.");
  }

  if (isLoopback(host)) {
    if (url.protocol !== "http:" || !["", "5000"].includes(url.port)) {
      throw new Error("Local targets must use HTTP on the supported backend port 5000.");
    }
    return url.origin;
  }

  if (url.protocol !== "https:" || url.port) {
    throw new Error("Remote test targets must use HTTPS on the default port.");
  }

  const allowlistedHosts = new Set(
    String(env.BTMS_CAPACITY_STAGING_HOSTS || "")
      .split(",")
      .map(normalizeHostname)
      .filter(Boolean),
  );
  if (!allowlistedHosts.has(host)) {
    throw new Error("Remote target hostname is not in BTMS_CAPACITY_STAGING_HOSTS.");
  }
  if (env.BTMS_CAPACITY_CONFIRM_STAGING !== "YES") {
    throw new Error("Remote staging targets require BTMS_CAPACITY_CONFIRM_STAGING=YES.");
  }
  return url.origin;
}

function validatePositiveSafeInteger(value, name, maximum, { allowZero = false } = {}) {
  const minimum = allowZero ? 0 : 1;
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer no greater than ${maximum}.`);
  }
  return value;
}

function validateCapacityLimits({
  clients,
  rampMs,
  holdMs,
  requestTimeoutMs,
  reconnectionAttempts,
  totalDurationMs = rampMs + holdMs + requestTimeoutMs,
}) {
  if (!STAGES.includes(clients)) {
    throw new Error(`Client count must be one of ${STAGES.join(", ")}.`);
  }
  validatePositiveSafeInteger(rampMs, "Ramp duration", MAX_RAMP_MS, { allowZero: true });
  validatePositiveSafeInteger(holdMs, "Hold duration", MAX_HOLD_MS, { allowZero: true });
  validatePositiveSafeInteger(requestTimeoutMs, "Request timeout", MAX_REQUEST_TIMEOUT_MS);
  validatePositiveSafeInteger(
    reconnectionAttempts,
    "Reconnection attempts",
    MAX_RECONNECTION_ATTEMPTS,
    { allowZero: true },
  );
  validatePositiveSafeInteger(totalDurationMs, "Total test duration", MAX_TEST_DURATION_MS);
}

function validateAccounts(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error("The account fixture must contain at least one account.");
  }

  const seen = new Set();
  for (const account of accounts) {
    if (
      typeof account?.email !== "string" ||
      typeof account?.password !== "string" ||
      !account.email.trim() ||
      !account.password
    ) {
      throw new Error("Each fixture account must contain an email and password.");
    }

    const email = account.email.trim().toLowerCase();
    if (seen.has(email)) {
      throw new Error("The account fixture must contain unique accounts.");
    }
    seen.add(email);
  }
  return accounts;
}

function assignVirtualClients(accounts, clientCount) {
  validateAccounts(accounts);
  if (!STAGES.includes(clientCount)) {
    throw new Error(`Client count must be one of ${STAGES.join(", ")}.`);
  }

  return Array.from({ length: clientCount }, (_, index) => ({
    label: `virtual-student-${String(index + 1).padStart(3, "0")}`,
    accountIndex: index % accounts.length,
    account: accounts[index % accounts.length],
  }));
}

function percentile(sortedSamples, quantile) {
  if (!sortedSamples.length) return null;
  return sortedSamples[Math.max(0, Math.ceil(quantile * sortedSamples.length) - 1)];
}

function summarizeLatencies(samples) {
  if (!samples.length) {
    return {
      count: 0,
      averageMs: null,
      minMs: null,
      p50Ms: null,
      p90Ms: null,
      p95Ms: null,
      p99Ms: null,
      maxMs: null,
    };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const rounded = (value) => Number(value.toFixed(2));
  return {
    count: sorted.length,
    averageMs: rounded(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    minMs: rounded(sorted[0]),
    p50Ms: rounded(percentile(sorted, 0.5)),
    p90Ms: rounded(percentile(sorted, 0.9)),
    p95Ms: rounded(percentile(sorted, 0.95)),
    p99Ms: rounded(percentile(sorted, 0.99)),
    maxMs: rounded(sorted[sorted.length - 1]),
  };
}

function thresholdExceeded(failures, total, threshold = 0.01) {
  return total > 0 && failures / total > threshold;
}

function getStopReasons(metrics, readinessIssue = null) {
  const reasons = [];
  if (
    thresholdExceeded(
      metrics.authenticationFailures,
      metrics.authenticationAttempts,
    )
  ) {
    reasons.push("authentication failures exceeded 1%");
  }
  if (thresholdExceeded(metrics.api5xxErrors, metrics.apiRequests)) {
    reasons.push("API 5xx responses exceeded 1%");
  }
  if (
    thresholdExceeded(
      metrics.connectionFailures,
      metrics.plannedClients,
    )
  ) {
    reasons.push("Socket.IO connection failures exceeded 1%");
  }
  if (
    thresholdExceeded(
      metrics.unexpectedDisconnections,
      metrics.successfulSocketConnections,
    )
  ) {
    reasons.push("unexpected Socket.IO disconnections exceeded 1%");
  }
  if (metrics.reconnectionFailures >= 3) {
    reasons.push("reconnection failures repeated three times");
  }
  if (readinessIssue) reasons.push(readinessIssue);
  return reasons;
}

function cleanupSockets(sessions) {
  for (const session of sessions) {
    if (!session?.socket) continue;
    if (session.socket.connected && session.previewRoomIds?.length) {
      for (const preview of session.previewRoomIds) {
        session.socket.emit("leave-bus", preview);
      }
    }
    session.intentionalDisconnect = true;
    session.socket.disconnect();
  }
}

module.exports = {
  MAX_HOLD_MS,
  MAX_RAMP_MS,
  MAX_RECONNECTION_ATTEMPTS,
  MAX_REQUEST_TIMEOUT_MS,
  MAX_TEST_DURATION_MS,
  STAGES,
  assignVirtualClients,
  cleanupSockets,
  getStopReasons,
  isLoopback,
  normalizeHostname,
  summarizeLatencies,
  thresholdExceeded,
  validateCapacityLimits,
  validateAccounts,
  validateTarget,
  validatePositiveSafeInteger,
};
