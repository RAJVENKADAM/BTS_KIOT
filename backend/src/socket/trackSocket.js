/**
 * trackSocket.js — Socket.IO handlers for live bus room events.
 * Clients join `bus_<BUSNO>` rooms to receive real-time bus updates
 * (e.g. current plan changes).
 */
const { getIO } = require("../socket");

// Models are required lazily to avoid importing mongoose before the DB is ready.
const getBus = () => require("../models/Bus");
const getBusLiveLocation = () => require("../models/BusLiveLocation");
const getUser = () => require("../models/User");

function registerTrackSocketHandlers() {
  const io = getIO();
  if (!io) return;

  io.on("connection", (socket) => {
    const authenticatedUserId = String(socket.user.id);
    let locationRequests = 0;
    let locationWindowStarted = Date.now();
    let masterRoom = null;
    socket.join(`user_${authenticatedUserId}`);

    socket.on("join-user", (userId) => {
      if (userId && String(userId) === authenticatedUserId) {
        socket.join(`user_${authenticatedUserId}`);
      }
    });
    socket.on("join-master", async () => {
      try {
        const User = getUser();
        const Bus = getBus();
        const user = await User.findById(authenticatedUserId)
          .select("bus_no is_active deleted_by_user")
          .lean();
        if (!user || !user.is_active || user.deleted_by_user || !user.bus_no) {
          return;
        }

        let bus = await Bus.findOne({
          bus_no: String(user.bus_no).trim().toUpperCase(),
        });
        if (!bus) {
          bus = await Bus.findOne({
            preview_number: String(user.bus_no).trim(),
          });
        }
        const visited = new Set();
        let depth = 0;
        while (
          bus?.altered_to_bus_id &&
          depth < 20 &&
          !visited.has(String(bus._id))
        ) {
          visited.add(String(bus._id));
          const nextBus = await Bus.findById(bus.altered_to_bus_id)
            .select("_id altered_to_bus_id")
            .lean();
          if (!nextBus) break;
          bus = nextBus;
          depth += 1;
        }
        if (!bus) return;

        if (masterRoom) socket.leave(masterRoom);
        masterRoom = `master_${String(bus._id)}`;
        socket.join(masterRoom);
      } catch (error) {
        console.error("join-master error:", error.message);
      }
    });
    socket.on("leave-master", () => {
      if (!masterRoom) return;
      socket.leave(masterRoom);
      masterRoom = null;
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
