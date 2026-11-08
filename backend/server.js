"use strict";

function validateProductionConfiguration(env) {
  if (env.NODE_ENV !== "production") return;
  const missing = ["JWT_SECRET", "MONGODB_URI"].filter(
    (name) => !env[name] || !env[name].trim(),
  );
  if (missing.length) {
    throw new Error(
      `Missing required production configuration: ${missing.join(", ")}`,
    );
  }
  if (env.JWT_SECRET.length < 32) {
    console.warn(
      "JWT_SECRET is configured but shorter than the recommended 32 characters.",
    );
  }
}

async function startServer(options = {}) {
  const env = options.env || process.env;
  validateProductionConfiguration(env);
  const { createRuntime } = require("./src/runtime");
  const runtime = createRuntime({ ...options, env });
  await runtime.start();
  return runtime;
}

async function main() {
  require("dotenv").config();
  const { logSafeError } = require("./src/utils/safeErrorLog");
  const { logSocketDiagnostic } = require("./src/utils/socketDiagnostics");
  const runtime = await startServer();

  console.log("BTMS backend started.");
  logSocketDiagnostic("server-process-started");

  let shutdownPromise;
  const shutdown = (signal) => {
    if (shutdownPromise) return shutdownPromise;
    console.log(`Received ${signal}; shutting down gracefully.`);
    logSocketDiagnostic("server-process-shutdown-started", {
      processSignal: signal,
    });
    shutdownPromise = runtime.shutdown(signal);
    return shutdownPromise;
  };

  process.once("exit", (code) => {
    logSocketDiagnostic("server-process-exited", {
      processExitCode: code,
    });
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      shutdown(signal).catch((error) => {
        logSafeError("Graceful shutdown failed", error);
        process.exitCode = 1;
      });
    });
  }
}

if (require.main === module) {
  main().catch((error) => {
    require("./src/utils/safeErrorLog").logSafeError(
      "Server startup failed",
      error,
    );
    process.exitCode = 1;
  });
}

module.exports = { startServer, validateProductionConfiguration };
