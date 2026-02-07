const express = require("express");
const cors = require("cors");
const http = require("http");
const socketIo = require("socket.io");
const { setIO } = require("./socket");
require("dotenv").config();

// Add logging for incoming requests
const morgan = require('morgan');

const app = express();

// Disable ETag caching to prevent 304 responses
app.disable("etag");

/* ---------------- CORS CONFIG ---------------- */
const corsOptions = {
  origin: "*", // dev only
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
};

// Enable request logging for debugging
app.use(morgan('combined')); // Logs all requests

app.use(cors(corsOptions));

/* ---------------- SERVER ---------------- */
const server = http.createServer(app);
server.setTimeout(120000);

/* ---------------- SOCKET.IO ---------------- */
const io = socketIo(server, {
  path: "/socket.io",
  cors: corsOptions
});

setIO(io);

/* ---------------- BODY PARSING ---------------- */
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

/* ---------------- ROUTES ---------------- */
app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/organize", require("./routes/organize.routes"));
app.use("/api/excel-management", require("./routes/excelManagement.routes"));
app.use("/api/bus", require("./routes/bus.routes"));
app.use("/api/messages", require("./routes/message.routes"));
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

/* ---------------- SOCKET EVENTS ---------------- */
const { initTrackingHandlers } = require("./socket/trackSocket");

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join-room", (room) => {
    socket.join(room);
    console.log(`Socket ${socket.id} joined room: ${room}`);
  });

  socket.on("send-message", (data) => {
    const room = data.busNo ? `bus-${data.busNo}` : "general";
    io.to(room).emit("new-message", data);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

initTrackingHandlers(io);

module.exports = { app, server };
