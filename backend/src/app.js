const express = require("express");
const cors = require("cors");
const http = require("http");
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
const rateLimit = require("express-rate-limit");

const morgan = require("morgan");
const jwt = require("jsonwebtoken");

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

io.use((socket, next) => {
  const token =
    socket.handshake.auth?.token ||
    socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, "");

  if (!token || !process.env.JWT_SECRET) {
    return next(new Error("Authentication required"));
  }

  jwt.verify(token, process.env.JWT_SECRET, (error, user) => {
    if (error || !user?.id) {
      return next(new Error("Invalid or expired token"));
    }
    socket.user = { ...user, id: String(user.id) };
    next();
  });
});

setIO(io);

// Socket.IO handlers for bus room events.
const { registerTrackSocketHandlers } = require('./socket/trackSocket');
registerTrackSocketHandlers();

// Start GPS worker only after MongoDB is ready
try {
  const { startDbDependentServices } = require('./services/startServices');
  startDbDependentServices().catch((e) => console.error('startDbDependentServices failed:', e.message));
} catch (e) {
  console.error('Failed to initialize startServices:', e.message);
}

// Notification service has been removed.
// Real-time bus updates are handled via Socket.IO directly.

/* ---------------- BODY PARSING ---------------- */
app.use(
  express.json({
    limit: "1mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
    // Silently ignore empty bodies (null bytes, empty strings) to prevent
    // JSON parse errors on endpoints like logout that don't send a body
    // but still include Content-Type: application/json header.
    strict: false,
  })
);
app.use(express.urlencoded({
  extended: true,
  limit: "1mb",
  parameterLimit: 1000,
}));

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
app.use("/api/notifications", require("./routes/notification.routes"));
app.use("/api/organize", require("./routes/organize.routes"));
app.use("/api/excel-management", require("./routes/excelManagement.routes"));
app.use("/api/bus", require("./routes/bus.routes"));
app.use("/api/bus", require("./routes/busImport.routes"));
app.use("/api/superadmin", require("./routes/superadminImport.routes"));
app.use("/api/superadmin", require("./routes/superadminUsers.routes"));

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    message: "BTMS Backend is running",
  });
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

  if (process.env.NODE_ENV !== "production" && err.stack) {
    payload.stack = err.stack;
  }

  console.error("API Error:", err);
  res.status(statusCode).json(payload);
});

module.exports = { app, server };
