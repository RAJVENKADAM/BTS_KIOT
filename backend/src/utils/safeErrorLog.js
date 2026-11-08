"use strict";

const MAX_DIAGNOSTIC_LENGTH = 8_000;
const SENSITIVE_ENVIRONMENT_NAME =
  /(secret|password|passwd|token|credential|private|api[_-]?key|mongodb.*uri|database.*url|redis.*url)/i;

function sanitizeDiagnosticText(value, env = process.env) {
  if (typeof value !== "string") return null;
  let sanitized = value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]")
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, "[REDACTED_MONGODB_URI]")
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(
      /\b(password|passwd|pwd|token|secret|authorization|api[_-]?key)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;)}]+)/gi,
      "$1$2[REDACTED]",
    );

  const sensitiveValues = Object.entries(env)
    .filter(
      ([name, secret]) =>
        SENSITIVE_ENVIRONMENT_NAME.test(name) &&
        typeof secret === "string" &&
        secret.length >= 4,
    )
    .map(([, secret]) => secret)
    .sort((left, right) => right.length - left.length);
  for (const secret of sensitiveValues) {
    sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  return sanitized.slice(0, MAX_DIAGNOSTIC_LENGTH);
}

function attachStartupStage(error, startupStage) {
  const safeError =
    error && (typeof error === "object" || typeof error === "function")
      ? error
      : new Error(String(error));
  if (!safeError.startupStage) {
    try {
      Object.defineProperty(safeError, "startupStage", {
        configurable: true,
        value: startupStage,
      });
    } catch {
      // Preserve the original startup error if it cannot be annotated.
    }
  }
  return safeError;
}

function logSafeError(
  operation,
  error,
  requestId,
  { includeDiagnostics = false } = {},
) {
  try {
    const name =
      typeof error?.name === "string" &&
      /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name)
        ? error.name
        : "Error";
    const code =
      typeof error?.code === "number"
        ? error.code
        : typeof error?.code === "string" &&
            /^[A-Z0-9_-]{1,40}$/.test(error.code)
          ? error.code
          : null;
    const details = {
      name,
      code,
    };
    if (
      typeof requestId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        requestId,
      )
    ) {
      details.requestId = requestId;
    }
    if (includeDiagnostics) {
      const startupStage = sanitizeDiagnosticText(error?.startupStage);
      const message = sanitizeDiagnosticText(error?.message);
      const stack = sanitizeDiagnosticText(error?.stack);
      if (startupStage && /^[A-Za-z0-9 ._:-]{1,100}$/.test(startupStage)) {
        details.startupStage = startupStage;
      }
      if (message) details.message = message;
      if (stack) details.stack = stack;
    }
    console.error(operation, details);
  } catch {
    // Logging failures must not change request behavior.
  }
}

module.exports = { attachStartupStage, logSafeError, sanitizeDiagnosticText };
