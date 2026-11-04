const express = require("express");
const cors = require("cors");
const http = require("http");
const { randomUUID } = require("node:crypto");
const socketIo = require("socket.io");
const { setIO } = require("./socket");
require("dotenv").config();

if (process.env.NODE_ENV === "production") {
  const missing = ["JWT_SECRET", "MONGODB_URI"].filter(
    (name) => !process.env[name] || process.env[name].trim().length < 1,
  );
  if (missing.length) {
    throw new Error(`Missing required production configuration: ${missing.join(", ")}`);
  }
  if (process.env.JWT_SECRET.length < 32) {
    console.warn(
      "JWT_SECRET is configured but shorter than the recommended 32 characters; rotate it in Render secrets.",
    );
  }
}

const helmet = require("helmet");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

const morgan = require("morgan");
const jwt = require("jsonwebtoken");
const { createSocketAuthentication } = require("./socket/authenticateSocket");
const { createDatabaseReadinessWaiter } = require("./utils/dbReadinessWaiter");
const { logSafeError } = require("./utils/safeErrorLog");
const gpsSyncWorker = require("./workers/gpsSyncWorker");
const { buildReadiness } = require("./utils/readiness");

const app = express();

app.disable("etag");

/* ---------------- SECURITY (PRODUCTION HARDENING) ---------------- */
app.use(helmet());

const corsOrigins = [
  ...String(process.env.CORS_ORIGIN || "")
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
morgan.token("request-id", (req) => req.requestId);
app.use(
  morgan(
    ":request-id :method :status :response-time ms",
  ),
);
app.use(cors(corsOptions));

app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const authorization = req.headers.authorization || "";
    const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    if (token && process.env.JWT_SECRET) {
      try {
        const user = jwt.verify(token, process.env.JWT_SECRET);
        if (user?.id) return `user:${String(user.id)}`;
      } catch {
        // Invalid tokens remain subject to the unauthenticated IP limit.
      }
    }
    return ipKeyGenerator(req.ip);
  },
  skip: (req) => req.path === "/auth/login",
  handler: (_req, res) => {
    res.status(429).json({
      error: "Too many requests. Please try again later.",
      code: "RATE_LIMITED",
    });
  },
});

app.use("/api", apiLimiter);

/* ---------------- SERVER ---------------- */
const server = http.createServer(app);
server.setTimeout(120000);

/* ---------------- SOCKET.IO ---------------- */
const io = socketIo(server, {
  path: "/socket.io",
  cors: corsOptions,
});

io.use(createSocketAuthentication(jwt));

setIO(io);

// Socket.IO handlers for bus room events.
const { registerTrackSocketHandlers } = require('./socket/trackSocket');
registerTrackSocketHandlers();

// Start GPS worker only after MongoDB is ready
try {
  const { startDbDependentServices } = require('./services/startServices');
  startDbDependentServices().catch((error) =>
    logSafeError('Starting DB-dependent services failed', error),
  );
} catch (e) {
  logSafeError('Initializing DB-dependent services failed', e);
}

// Notification service has been removed.
// Real-time bus updates are handled via Socket.IO directly.

/* ---------------- BODY PARSING ---------------- */
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

/* ---------------- ROUTES ---------------- */

const mongoose = require('mongoose');
const waitForDb = createDatabaseReadinessWaiter({
  getReadyState: () => mongoose.connection.readyState,
});

app.use(async (req, res, next) => {
  const isApiRequest = req.path && req.path.startsWith('/api');
  if (!isApiRequest) return next();

  if (mongoose.connection.readyState === 1) return next();

  const ready = await waitForDb(10000);
  if (ready) return next();

  return res.status(503).json({
    error: 'Database not ready. Please try again in a few seconds.'
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

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    message: "BTMS Backend is running",
  });
});

app.get("/ready", (req, res) => {
  const mongoose = require("mongoose");
  const gpsWorker = gpsSyncWorker.getStatus();
  const lastGpsCycle = gpsWorker.lastCycle;
  const readiness = buildReadiness({
    databaseReadyState: mongoose.connection.readyState,
    gpsWorker,
    socketClients: io.engine.clientsCount,
  });
  return res.status(readiness.httpStatus).json(readiness.payload);
});

app.use("*", (req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((err, req, res, next) => {
  if (err && (err.name === 'MulterError' || err.message === 'Only Excel files are allowed')) {
    return res.status(400).json({ error: err.message || 'Invalid upload.' });
  }
  const statusCode = err.statusCode || err.status || 500;
  const payload = {
    error: statusCode === 500 ? "Internal server error" : err.message || "Request failed",
  };

  logSafeError(`API request failed with status ${statusCode}`, err, req.requestId);
  res.status(statusCode).json(payload);
});

module.exports = { app, server };
