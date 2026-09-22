/**
 * trackSocket.js — Socket.IO handlers for live bus room events.
 * Clients join `bus_<BUSNO>` rooms to receive real-time bus updates
 * (e.g. current plan changes).
 */
const { getIO } = require("../socket");

// Models are required lazily to avoid importing mongoose before the DB is ready.
const getBus = () => require("../models/Bus");
const getBusLiveLocation = () => require("../models/BusLiveLocation");

function registerTrackSocketHandlers() {
  const io = getIO();
  if (!io) return;

  io.on("connection", (socket) => {
    const authenticatedUserId = String(socket.user.id);
    let locationRequests = 0;
    let locationWindowStarted = Date.now();
    socket.join(`user_${authenticatedUserId}`);

    socket.on("join-user", (userId) => {
      if (userId && String(userId) === authenticatedUserId) {
        socket.join(`user_${authenticatedUserId}`);
      }
    });
    // Join a room for a specific preview number to receive live updates.
    // Use preview_ prefix to avoid exposing internal bus_no to clients.
    socket.on("join-bus", async (previewNumber) => {
      try {
        if (!previewNumber) return;
        const Bus = getBus();
        const bus = await Bus.findOne({
          preview_number: String(previewNumber).trim(),
          status: "active",
        }).select("_id").lean();
        if (!bus) return;
        const room = `preview_${String(previewNumber)}`;
        socket.join(room);
      } catch (error) {
        console.error("join-bus error:", error.message);
      }
    });

    // Leave a room for a specific preview
    socket.on("leave-bus", (previewNumber) => {
      if (!previewNumber) return;
      const room = `preview_${String(previewNumber)}`;
      socket.leave(room);
    });

    // Client requests the latest location for a bus (search by bus_no or preview).
    // Response payload deliberately avoids exposing internal bus_no. Returns previewNumber and location only.
    socket.on("request-bus-location", async (busIdentifier) => {
      if (!busIdentifier) return;
      const now = Date.now();
      if (now - locationWindowStarted >= 60_000) {
        locationWindowStarted = now;
        locationRequests = 0;
      }
      locationRequests += 1;
      if (locationRequests > 30) {
        return socket.emit("locationUpdate", {
          previewNumber: busIdentifier,
          error: "Too many location requests",
        });
      }
      try {
        const Bus = getBus();
        const BusLiveLocation = getBusLiveLocation();

        // Resolve bus by bus_no first, then by preview_number.
        let bus = await Bus.findOne({
          bus_no: String(busIdentifier).trim().toUpperCase(),
        });
        if (!bus) {
          bus = await Bus.findOne({
            preview_number: { $in: [busIdentifier, String(busIdentifier)] },
          });
        }
        if (!bus) {
          return socket.emit("locationUpdate", {
            previewNumber: busIdentifier,
            error: "Bus not found",
          });
        }

        const location = await BusLiveLocation.findOne({ bus_id: bus._id });

        // Privacy: do NOT send internal bus_no. Use previewNumber only.
        const payload = {
          previewNumber: bus.preview_number ?? null,
          latitude: location ? location.latitude : null,
          longitude: location ? location.longitude : null,
          speed: location ? location.speed : 0,
          status: location && location.is_online ? "online" : "offline",
          source: location && location.source ? location.source : "offline",
          is_online: !!(location && location.is_online),
          lastSuccessfulGpsUpdate: location
            ? location.lastSuccessfulGpsUpdate
            : null,
          lastUpdated: location
            ? location.lastSuccessfulGpsUpdate || location.updatedAt
            : null,
        };

        socket.emit("locationUpdate", payload);
      } catch (err) {
        console.error("request-bus-location error:", err.message);
        socket.emit("locationUpdate", { error: err.message });
      }
    });
  });
}

module.exports = { registerTrackSocketHandlers };
