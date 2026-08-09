/**
 * errorHandler — Centralized error classification & human-readable messages.
 *
 * The whole app shares one place to figure out WHAT actually went wrong so the
 * UI never shows a misleading generic message like "Bus Not Found" when the
 * real problem was a network failure or a server error.
 *
 * Error objects produced/found here carry two optional flags:
 *   - err.isNetwork : true when the failure is a connectivity/timeout issue
 *   - err.code       : a stable machine-readable code (AUTH, BUS_NOT_FOUND, ...)
 */

const NETWORK_MESSAGES = [
  "Network request failed",
  "Failed to fetch",
  "NetworkError",
  "request failed",
  "fetch is not defined",
  "Network request failed",
  "Load failed",
  "The Internet connection appears to be offline",
  "Network error",
];

/**
 * Detect whether an error is caused by a network/connectivity problem
 * (no internet, server unreachable, request timeout) rather than a logic error.
 */
export function isNetworkError(err) {
  if (!err) return false;
  // Custom flag set by our fetch helper.
  if (err.isNetwork === true) return true;
  // TypeError from native fetch (network failure).
  if (err instanceof TypeError) return true;
  const msg = String(err?.message || err?.name || "").toLowerCase();
  return NETWORK_MESSAGES.some((m) => msg.includes(m.toLowerCase()));
}

/**
 * Map an HTTP status code to a specific, human-readable explanation.
 * @returns {string}
 */
export function getHttpErrorMessage(status) {
  switch (status) {
    case 400:
      return "The request was invalid. Please check the details you entered.";
    case 401:
      return "Your session has expired. Please log in again.";
    case 403:
      return "You do not have permission to perform this action.";
    case 404:
      return "The requested item was not found.";
    case 429:
      return "Too many requests. Please wait a moment and try again.";
    case 500:
      return "The server encountered an unexpected error. Please try again.";
    case 503:
      return "The server is temporarily unavailable. Please try again in a few seconds.";
    default:
      return null;
  }
}

/**
 * Convert a thrown error into a clear, human-readable message.
 * - Network errors get a connection-specific message.
 * - Errors with a server-provided `message`/`error` are surfaced.
 * - Otherwise a provided fallback (or a generic message) is used.
 *
 * @param {Error} err
 * @param {string} [fallback]
 * @returns {string}
 */
export function getErrorMessage(
  err,
  fallback = "Something went wrong. Please try again.",
) {
  if (!err) return fallback;

  // Network error → specific, actionable message.
  if (isNetworkError(err)) {
    return "Cannot connect to the server. Please check your internet connection and try again.";
  }

  // Server-provided message (e.g. from a JSON error body).
  const serverMsg = err?.message || err?.serverMessage || err?.error;
  if (serverMsg && typeof serverMsg === "string" && serverMsg.trim()) {
    // Avoid returning a generic technical string like "Internal server error".
    if (/internal server error/i.test(serverMsg)) {
      return "The server hit an unexpected error. Please try again.";
    }
    // Avoid leaking raw "Error: ..." prefixes.
    return serverMsg.replace(/^error:\s*/i, "");
  }

  // HTTP status based fallback.
  const httpMsg = getHttpErrorMessage(err?.status);
  if (httpMsg) return httpMsg;

  return fallback;
}

/**
 * Safely parse a fetch response body as JSON without crashing on empty/HTML.
 */
export async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    return {};
  }
}

/**
 * Build a normalized Error from a fetch response and its parsed body.
 * Attaches `code`, `status`, and `serverMessage` so callers can react.
 */
export function createHttpError(response, data) {
  const err = new Error(
    data?.error ||
      data?.message ||
      getHttpErrorMessage(response.status) ||
      `Request failed (${response.status})`,
  );
  err.status = response.status;
  err.code = data?.error || data?.code || `HTTP_${response.status}`;
  err.serverMessage = data?.error || data?.message;
  return err;
}

/**
 * Wrapper around fetch that:
 *   - throws a typed error on network failure (isNetwork = true)
 *   - checks response.ok and throws a descriptive HTTP error otherwise
 *   - safely parses JSON body
 *
 * @param {string} url
 * @param {RequestInit} [options]
 */
export async function fetchJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (err) {
    // Native fetch network failure → tag it so callers can show a connection message.
    const wrapped = new Error(err?.message || "Network request failed");
    wrapped.isNetwork = true;
    wrapped.cause = err;
    throw wrapped;
  }

  const data = await parseJsonResponse(response);

  if (!response.ok) {
    throw createHttpError(response, data);
  }

  return data;
}
