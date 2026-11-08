"use strict";

function createApplication({
  env = process.env,
  getRuntimeStatus,
  incrementSharedRateLimit,
} = {}) {
  const express = require("express");
  const cors = require("cors");
  const helmet = require("helmet");
  const { randomUUID } = require("node:crypto");
  const { performance } = require("node:perf_hooks");
  const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
  const morgan = require("morgan");
  const jwt = require("jsonwebtoken");
  const mongoose = require("mongoose");
  const { createDatabaseReadinessWaiter } = require("./utils/dbReadinessWaiter");
  const { logSafeError } = require("./utils/safeErrorLog");
  const { buildReadiness } = require("./utils/readiness");

  const app = express();
  const sharedRedisMode = env.SOCKET_IO_MODE === "redis";
  const runtimeStatus = getRuntimeStatus || (() => ({
    databaseReadyState: mongoose.connection.readyState,
    gpsWorker: null,
    socketClients: 0,
    socketCluster: {
      mode: env.SOCKET_IO_MODE || (env.NODE_ENV === "production" ? "redis" : "single-instance"),
      state: "disabled",
      enabled: false,
      reason: "Runtime services have not been initialized.",
    },
  }));
  const trustedProxy = require("./config/proxyTrust").createProxyTrust(env);

  app.set("trust proxy", trustedProxy);
  app.disable("etag");
  app.use(helmet());

  const corsOrigins = [
    ...String(env.CORS_ORIGIN || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    "https://rajvenkadam.github.io",
    "http://localhost:8765",
    "http://127.0.0.1:8765",
  ];
  const corsOptions = {
    origin: [...new Set(corsOrigins)],
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  };

  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set("X-Request-Id", req.requestId);
    next();
  });
  app.use(
    morgan((tokens, req, res) =>
      JSON.stringify({
        event: "http_request",
        requestId: req.requestId,
        method: req.method,
        status: Number(tokens.status(req, res)),
        durationMs: Number(tokens["response-time"](req, res)),
      }),
    ),
  );
  app.use(cors(corsOptions));
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.locals.incrementSharedRateLimit = sharedRedisMode
    ? incrementSharedRateLimit
    : null;
  const getRateLimitKey = (req) => {
    const authorization = req.headers.authorization || "";
    const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    if (token && env.JWT_SECRET) {
      try {
        const user = jwt.verify(token, env.JWT_SECRET);
        if (user?.id) return `user:${String(user.id)}`;
      } catch {
        // Invalid tokens remain subject to the unauthenticated IP limit.
      }
    }
    return ipKeyGenerator(req.ip);
  };
  const apiLimiter = sharedRedisMode
    ? async (req, res, next) => {
        if (req.path === "/auth/login") return next();
        try {
          const result = await incrementSharedRateLimit(
            getRateLimitKey(req),
            15 * 60 * 1000,
          );
          const remaining = Math.max(0, 300 - result.totalHits);
          const resetSeconds = Math.ceil(
            Math.max(0, result.resetTime - Date.now()) / 1000,
          );
          res.set("RateLimit-Limit", "300");
          res.set("RateLimit-Remaining", String(remaining));
          res.set("RateLimit-Reset", String(resetSeconds));
          if (result.totalHits > 300) {
            return res.status(429).json({
              error: "Too many requests. Please try again later.",
              code: "RATE_LIMITED",
            });
          }
          return next();
        } catch (error) {
          logSafeError("Shared API rate limiting is unavailable", error, req.requestId);
          return res.status(503).json({
            error: "Request protection is temporarily unavailable.",
            code: "RATE_LIMIT_UNAVAILABLE",
          });
        }
      }
    : rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 300,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: getRateLimitKey,
        skip: (req) => req.path === "/auth/login",
        handler: (_req, res) => {
          res.status(429).json({
            error: "Too many requests. Please try again later.",
            code: "RATE_LIMITED",
          });
        },
      });
  app.use("/api", apiLimiter);

  const spreadsheetImportJsonParser = express.json({
    limit: "25mb",
    strict: false,
  });
  app.use("/api/bus/import-routes", spreadsheetImportJsonParser);
  const defaultJsonParser = express.json({
    limit: "5mb",
    strict: false,
  });
  app.use((req, res, next) => {
    if (req.path === "/api/superadmin/import-users") return next();
    return defaultJsonParser(req, res, next);
  });
  app.use(express.urlencoded({
    extended: true,
    limit: "5mb",
    parameterLimit: 1000,
  }));

  const waitForDb = createDatabaseReadinessWaiter({
    getReadyState: () => mongoose.connection.readyState,
  });
  app.use(async (req, res, next) => {
    const isApiRequest = req.path && req.path.startsWith("/api");
    if (!isApiRequest) return next();

    const isLoginRequest =
      req.method === "POST" && req.path === "/api/auth/login";
    const readinessStartedAt = performance.now();
    if (mongoose.connection.readyState === 1) {
      if (isLoginRequest) req.loginDatabaseReadinessWaitMs = 0;
      return next();
    }

    const ready = await waitForDb(10000);
    if (isLoginRequest) {
      req.loginDatabaseReadinessWaitMs = Number(
        (performance.now() - readinessStartedAt).toFixed(2),
      );
    }
    if (ready) return next();

    return res.status(503).json({
      error: "Database not ready. Please try again in a few seconds.",
    });
  });

  app.use("/api/auth", require("./routes/auth.routes"));
  app.use("/api/notifications", require("./routes/notification.routes"));
  app.use("/api/organize", require("./routes/organize.routes"));
  app.use("/api/excel-management", require("./routes/excelManagement.routes"));
  app.use("/api/bus", require("./routes/bus.routes"));
  app.use("/api/bus", require("./routes/busImport.routes"));
  app.use("/api/stops", require("./routes/stopMaster.routes"));
  app.use("/api/superadmin", require("./routes/superadminImport.routes"));
  app.use("/api/superadmin", require("./routes/superadminUsers.routes"));
  app.use("/api/superadmin/gps-devices", require("./routes/gpsDevice.routes"));

  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: "OK",
      message: "BTMS Backend is running",
    });
  });

  app.get("/ready", (_req, res) => {
    const status = runtimeStatus();
    const readiness = buildReadiness(status);
    return res.status(readiness.httpStatus).json(readiness.payload);
  });

  app.use("*", (req, res) => {
    res.status(404).json({ error: "Route not found" });
  });

  app.use((err, req, res, next) => {
    if (
      err &&
      (err.name === "MulterError" || err.message === "Only Excel files are allowed")
    ) {
      return res.status(400).json({ error: err.message || "Invalid upload." });
    }
    const statusCode = err.statusCode || err.status || 500;
    const payload = {
      error:
        statusCode === 500
          ? "Internal server error"
          : err.message || "Request failed",
    };

    logSafeError(`API request failed with status ${statusCode}`, err, req.requestId);
    res.status(statusCode).json(payload);
  });

  return app;
}

module.exports = { createApplication };
