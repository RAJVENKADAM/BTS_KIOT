const express = require("express");
const cors = require("cors");
const http = require("http");
const socketIo = require("socket.io");
const { setIO } = require("./socket");
require("dotenv").config();

const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

// Add logging for incoming requests
const morgan = require("morgan");

const app = express();

// Disable ETag caching to prevent 304 responses
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
  credentials: true
};

// Enable request logging
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

app.use(cors(corsOptions));

// Basic rate limiting (tune as needed)
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
  cors: corsOptions
});

setIO(io);

// Initialize socket handlers now that io is set
try {
  const { initTrackingHandlers } = require('./socket/trackSocket');
  initTrackingHandlers(io);
  console.log('✅ Track socket handlers initialized');
} catch (err) {
  console.warn('Track socket handlers not available:', err.message);
}

// Pre-require services that do NOT start polling immediately
require('./services/trackingService');
require('./services/notificationService');

// Services that require DB connectivity (GPS polling, bus state tracking)
// are started from backend/server.js after DB readiness.

 /* ---------------- BODY PARSING ---------------- */
app.use(express.json({ limit: "25mb", verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));


/* ---------------- ROUTES ---------------- */
app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/organize", require("./routes/organize.routes"));
app.use("/api/excel-management", require("./routes/excelManagement.routes"));
app.use("/api/bus", require("./routes/bus.routes"));
app.use("/api/track", require("./routes/track.routes"));

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    message: "BTS Backend is running"
  });
});

/* ---------------- 404 ---------------- */
app.use("*", (req, res) => {
  res.status(404).json({ error: "Route not found" });
});

/* ---------------- SOCKET EVENTS & NAMESPACES ---------------- */
const trackingService = require("./services/trackingService");
const busLocationNamespace = io.of("/bus-location");

busLocationNamespace.on("connection", (socket) => {
  console.log("Tracking client connected:", socket.id);

  socket.on("join-bus", (busNo) => {
    socket.join(`bus_${busNo}`);
    console.log(`Socket ${socket.id} joined bus room: bus_${busNo}`);
  });

  // Mobile tracking update from Primary Admin
  socket.on("update-mobile-location", async (data) => {
    const { userId, bus_no, latitude, longitude, speed, heading } = data;
    if (bus_no && latitude && longitude) {
      await trackingService.updateMobileLocation(userId, bus_no, {
        latitude, longitude, speed, heading
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

/* ---------------- GPS WEBHOOK ---------------- */
app.post("/gps/update-location", async (req, res) => {
  const { device_id, latitude, longitude, speed, heading, timestamp } = req.body;

  if (!device_id || latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    await trackingService.updateGpsLocation(device_id, {
      latitude, longitude, speed, heading, timestamp
    });
    res.status(200).json({ message: "GPS location updated" });
  } catch (error) {
    console.error("GPS Webhook error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ---------------- LEGACY SOCKET EVENTS ---------------- */
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join-room", (room) => {
    socket.join(room);
    console.log(`Socket ${socket.id} joined room: ${room}`);
  });

  // Message socket handlers removed

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

// Global error handler (avoid leaking internals in production)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const statusCode = err.statusCode || err.status || 500;
  const payload = {
    error:
      statusCode === 500 ? "Internal server error" : err.message || "Request failed",
  };


  if (process.env.NODE_ENV !== "production" && err.stack) {
    payload.stack = err.stack;
  }

  console.error("API Error:", err);
  res.status(statusCode).json(payload);
});

module.exports = { app, server };
