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
    // Join a room for a specific bus to receive live updates
    socket.on("join-bus", (busNo) => {
      if (!busNo) return;
      const room = `bus_${String(busNo).toUpperCase()}`;
      socket.join(room);
    });

    // Leave a room for a specific bus
    socket.on("leave-bus", (busNo) => {
      if (!busNo) return;
      const room = `bus_${String(busNo).toUpperCase()}`;
      socket.leave(room);
    });

    // Client requests the latest location for a bus straight from the DB.
    // This avoids hitting the rate-limited GPS provider / HTTP API on refresh.
    socket.on("request-bus-location", async (busNo) => {
      if (!busNo) return;
      try {
        const Bus = getBus();
        const BusLiveLocation = getBusLiveLocation();

        // Resolve bus by bus_no first, then by preview_number.
        let bus = await Bus.findOne({
          bus_no: String(busNo).trim().toUpperCase(),
        });
        if (!bus) {
          bus = await Bus.findOne({
            preview_number: { $in: [busNo, String(busNo)] },
          });
        }
        if (!bus) {
          return socket.emit("locationUpdate", {
            busNo,
            error: "Bus not found",
          });
        }

        const location = await BusLiveLocation.findOne({ bus_id: bus._id });

        const payload = {
          busNo: bus.bus_no,
          bus_no: bus.bus_no,
          previewNumber: bus.preview_number,
          currentPlan: bus.current_plan,
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
        socket.emit("locationUpdate", { busNo, error: err.message });
      }
    });
  });
}

module.exports = { registerTrackSocketHandlers };
