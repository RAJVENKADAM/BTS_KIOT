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

try {
  const { initTrackingHandlers } = require("./socket/trackSocket");
  initTrackingHandlers(io);
  console.log("✅ Track socket handlers initialized");
} catch (err) {
  console.warn("Track socket handlers not available:", err.message);
}

// Pre-require services that do NOT start polling immediately
require("./services/trackingService");
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

// DB guard: wait briefly for MongoDB connection instead of rejecting immediately
// This handles Render cold-start where the first request arrives before DB connects
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

  // DB not ready yet — wait up to 10s for connection
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

/* ---------------- GPS WEBHOOK (must be before 404 catch-all) ---------------- */
app.post("/gps/update-location", async (req, res) => {
  const { device_id, latitude, longitude, speed, heading, timestamp, token: gpsToken } = req.body;

  // Validate GPS token for security
  if (gpsToken !== process.env.GPS_TOKEN) {
    return res.status(401).json({ error: "Unauthorized GPS device" });
  }

  if (!device_id || latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    await trackingService.updateGpsLocation(device_id, {
      latitude,
      longitude,
      speed,
      heading,
      timestamp,
    });
    res.status(200).json({ message: "GPS location updated" });
  } catch (error) {
    console.error("GPS Webhook error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.use("*", (req, res) => {
  res.status(404).json({ error: "Route not found" });
});

/* ---------------- SOCKET EVENTS & NAMESPACES ---------------- */
const trackingService = require("./services/trackingService");

const busLocationNamespace = io.of("/bus-location");

busLocationNamespace.on("connection", (socket) => {
  console.log("Tracking client connected:", socket.id);

  socket.on("join-bus", async (busNo) => {
    if (!busNo) return;
    socket.join(`bus_${busNo}`);
    console.log(`Socket ${socket.id} joined bus room: bus_${busNo}`);
  });

  // Mobile tracking update from Primary Admin
  socket.on("update-mobile-location", async (data) => {
    const { userId, bus_no, latitude, longitude, speed, heading } = data;
    if (bus_no && latitude != null && longitude != null) {
      await trackingService.updateMobileLocation(userId, bus_no, {
        latitude,
        longitude,
        speed,
        heading,
      });
    }
  });

  socket.on("toggle-mobile-tracking", async (data) => {
    const { bus_no, active } = data;
    if (bus_no) {
      await trackingService.setMobileTrackingStatus(bus_no, active);
    }
  });

  socket.on("disconnect", () => {
    console.log("Tracking client disconnected:", socket.id);
  });
});

/* ---------------- LEGACY SOCKET EVENTS ---------------- */
// NOTE: trackSocket.js initTrackingHandlers already registers io.on('connection')
// Avoid duplicate registration to prevent double-logging and event conflicts

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

