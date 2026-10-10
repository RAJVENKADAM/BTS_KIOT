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
  "Load failed",
  "The Internet connection appears to be offline",
  "Network error",
  "timed out",
  "timeout",
];

/**
 * Detect whether an error is caused by a network/connectivity problem
 * (no internet, server unreachable, request timeout) rather than a logic error.
 */
export function isNetworkError(err) {
  if (!err) return false;
  // Custom flag set by our fetch helper.
  if (err.isNetwork === true) return true;
  if (
    err.name === "AbortError" ||
    err.name === "TimeoutError" ||
    ["ETIMEDOUT", "ECONNABORTED", "ERR_NETWORK"].includes(err.code)
  ) {
    return true;
  }
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
    case 408:
      return "The request took too long. Please try again.";
    case 429:
      return "Too many requests. Please wait a moment and try again.";
    case 500:
      return "The server encountered an unexpected error. Please try again.";
    case 502:
      return "The server is temporarily unavailable. Please try again shortly.";
    case 503:
      return "The server is temporarily unavailable. Please try again in a few seconds.";
    case 504:
      return "The server took too long to respond. Please try again.";
    default:
      return null;
  }
}

function isTimeoutError(err) {
  const message = String(err?.message || "").toLowerCase();
  return (
    err?.isTimeout === true ||
    err?.name === "TimeoutError" ||
    err?.code === "ETIMEDOUT" ||
    err?.code === "ECONNABORTED" ||
    message.includes("timed out") ||
    message.includes("timeout")
  );
}

function getSafeServerMessage(message, fallback) {
  if (typeof message !== "string" || !message.trim()) return null;
  const normalized = message.trim().replace(/^error:\s*/i, "");
  if (
    /internal server error|request failed(?:\s*\(\d+\))?|network request failed|failed to fetch|timed out|timeout|syntaxerror|stack trace|<html|<!doctype/i.test(
      normalized,
    )
  ) {
    return fallback;
  }
  return normalized;
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
    if (isTimeoutError(err)) {
      return "The request is taking longer than expected. Please check your connection and try again.";
    }
    return "Cannot connect to the server. Please check your internet connection and try again.";
  }

  if (err.code === "NO_DATA") {
    return "Live bus location is not available right now. Please try again shortly.";
  }
  if (err.code === "BUS_NOT_FOUND") {
    return "Bus not found. Please check the bus number and try again.";
  }
  if (err.code === "INVALID_RESPONSE") {
    return "The server returned an unexpected response. Please try again later.";
  }

  const fallbackMessage = fallback || "Something went wrong. Please try again.";
  const httpMsg = getHttpErrorMessage(err?.status);
  if (httpMsg && err?.status !== 400) return httpMsg;

  // Server-provided message (e.g. from a JSON error body).
  const serverMsg = err?.message || err?.serverMessage || err?.error;
  const safeServerMessage = getSafeServerMessage(serverMsg, httpMsg || fallbackMessage);
  if (safeServerMessage) return safeServerMessage;

  // HTTP status based fallback.
  if (httpMsg) return httpMsg;

  return fallbackMessage;
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
    const error = new Error("The server returned an invalid response.");
    error.code = "INVALID_RESPONSE";
    error.status = response.status;
    throw error;
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
  if (Array.isArray(data?.rowResults)) {
    err.rowResults = data.rowResults;
  }
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
  const controller = new AbortController();
  const { timeoutMs = 15000, signal, ...fetchOptions } = options;
  let timedOut = false;
  const timeoutId =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;
  const abortRequest = () => controller.abort();
  if (signal?.aborted) {
    abortRequest();
  } else {
    signal?.addEventListener("abort", abortRequest, { once: true });
  }

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    const data = await parseJsonResponse(response);
    if (!response.ok) {
      throw createHttpError(response, data);
    }
    return data;
  } catch (err) {
    if (err?.status || err?.code === "INVALID_RESPONSE") throw err;
    if (!(err instanceof TypeError) && err?.name !== "AbortError") throw err;

    const wrapped = new Error(
      timedOut
        ? "Request timed out"
        : err?.message || "Network request failed",
    );
    wrapped.isNetwork = true;
    wrapped.isTimeout = timedOut;
    if (timedOut) wrapped.code = "REQUEST_TIMEOUT";
    wrapped.cause = err;
    throw wrapped;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortRequest);
  }
}
