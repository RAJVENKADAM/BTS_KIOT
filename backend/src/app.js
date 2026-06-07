const express = require("express");
const cors = require("cors");
const http = require("http");
const socketIo = require("socket.io");
const { setIO } = require("./socket");
require("dotenv").config();

const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const morgan = require("morgan");

const app = express();

app.disable("etag");

/* ---------------- SECURITY (PRODUCTION HARDENING) ---------------- */
app.use(helmet());

const corsOrigin = process.env.CORS_ORIGIN || "";
const corsOptions = {
  origin: corsOrigin
    ? corsOrigin.split(",").map((s) => s.trim())
    : false,
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(cors(corsOptions));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
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

setIO(io);

// Tracking sockets disabled for this deployment (no mobile/primary/secondary admins).
// GPS sync is handled exclusively by gpsSyncWorker.

try {
  const { initTrackingHandlers } = require("./socket/trackSocket");
  initTrackingHandlers(io);
  console.log("✅ Track socket handlers initialized (legacy disabled endpoints)." );
} catch (err) {
  console.warn("Track socket handlers not available:", err.message);
}

// Start GPS worker only after MongoDB is ready
try {
  const { startDbDependentServices } = require('./services/startServices');
  startDbDependentServices().catch((e) => console.error('startDbDependentServices failed:', e.message));
} catch (e) {
  console.error('Failed to initialize startServices:', e.message);
}

require("./services/notificationService");

/* ---------------- BODY PARSING ---------------- */
app.use(
  express.json({
    limit: "25mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

/* ---------------- ROUTES ---------------- */

const mongoose = require('mongoose');

function waitForDb(maxWaitMs = 10000) {
  return new Promise((resolve) => {
    if (mongoose.connection.readyState === 1) return resolve(true);

    const start = Date.now();
    const check = () => {
      if (mongoose.connection.readyState === 1) return resolve(true);
      if (Date.now() - start > maxWaitMs) return resolve(false);
      setTimeout(check, 250);
    };
    setTimeout(check, 250);
  });
}

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
app.use("/api/organize", require("./routes/organize.routes"));
app.use("/api/excel-management", require("./routes/excelManagement.routes"));
app.use("/api/bus", require("./routes/bus.routes"));
app.use("/api/bus", require("./routes/busImport.routes"));
app.use("/api/superadmin", require("./routes/superadminImport.routes"));
app.use("/api/superadmin", require("./routes/superadminUsers.routes"));
app.use("/api/track", require("./routes/track.routes"));

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    message: "BTS Backend is running",
  });
});

app.post("/gps/update-location", async (req, res) => {
  return res.status(410).json({
    error: 'GPS webhook is deprecated. Live GPS updates are handled by the backend worker.',
  });
});

app.use("*", (req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((err, req, res, next) => {
  const statusCode = err.statusCode || err.status || 500;
  const payload = {
    error: statusCode === 500 ? "Internal server error" : err.message || "Request failed",
  };

  if (process.env.NODE_ENV !== "production" && err.stack) {
    payload.stack = err.stack;
  }

  console.error("API Error:", err);
  res.status(statusCode).json(payload);
});

module.exports = { app, server };

