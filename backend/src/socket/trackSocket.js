/**
 * trackSocket.js — Socket.IO handlers for live bus room events.
 * Clients join validated `preview_<number>` rooms for live locations.
 */
const { getIO } = require("../socket");
const normalizeBusNumber = require("../utils/normalizeBusNumber");
const { logSafeError } = require("../utils/safeErrorLog");

// Models are required lazily to avoid importing mongoose before the DB is ready.
const getBus = () => require("../models/Bus");
const getBusLiveLocation = () => require("../models/BusLiveLocation");

function normalizeSocketIdentifier(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  const rawIdentifier = String(value);
  if (/[\u0000-\u001f\u007f]/.test(rawIdentifier)) return null;
  const identifier = rawIdentifier.trim();
  if (
    !identifier ||
    identifier.length > 64
  ) {
    return null;
  }
  return identifier;
}

function registerTrackSocketHandlers({
  io = getIO(),
  BusModel = getBus(),
  BusLiveLocationModel = getBusLiveLocation(),
} = {}) {
  if (!io) return;
  const activePreviewLookups = new Map();

  const findActivePreview = async (previewNumber) => {
    let lookup = activePreviewLookups.get(previewNumber);
    if (!lookup) {
      lookup = Promise.resolve()
        .then(() =>
          BusModel.findOne({
            preview_number: previewNumber,
            status: "active",
          })
            .select("_id")
            .lean(),
        )
        .catch((error) => {
          console.error(
            `Preview room validation failed for ${previewNumber}: ${error?.message || error}`,
          );
          throw error;
        });
      activePreviewLookups.set(previewNumber, lookup);
    }

    try {
      return await lookup;
    } finally {
      if (activePreviewLookups.get(previewNumber) === lookup) {
        activePreviewLookups.delete(previewNumber);
      }
    }
  };

  io.on("connection", (socket) => {
    const authenticatedUserId = String(socket.user.id);
    let locationRequests = 0;
    let locationWindowStarted = Date.now();
    let disconnected = false;
    const pendingPreviewRooms = new Map();
    socket.join(`user_${authenticatedUserId}`);

    socket.on("join-user", (userId) => {
      if (userId && String(userId) === authenticatedUserId) {
        socket.join(`user_${authenticatedUserId}`);
      }
    });
    // Join a room for a specific preview number to receive live updates.
    // Use preview_ prefix to avoid exposing internal bus_no to clients.
    socket.on("join-bus", async (previewNumber) => {
      const identifier = normalizeSocketIdentifier(previewNumber);
      if (!identifier || disconnected) return;
      const room = `preview_${identifier}`;
      if (
        socket.rooms.has(room) ||
        pendingPreviewRooms.has(identifier)
      ) {
        return;
      }

      const joinAttempt = {};
      pendingPreviewRooms.set(identifier, joinAttempt);
      try {
        let bus;
        try {
          bus = await findActivePreview(identifier);
        } catch {
          return;
        }
        if (
          !bus ||
          disconnected ||
          socket.connected === false ||
          pendingPreviewRooms.get(identifier) !== joinAttempt
        ) {
          return;
        }
        await socket.join(room);
        const stillSubscribed =
          !disconnected &&
          socket.connected !== false &&
          pendingPreviewRooms.get(identifier) === joinAttempt;
        if (!stillSubscribed) await socket.leave(room);
      } catch (error) {
        console.error(
          `Preview room join failed for ${identifier}: ${error?.message || error}`,
        );
      } finally {
        if (pendingPreviewRooms.get(identifier) === joinAttempt) {
          pendingPreviewRooms.delete(identifier);
        }
      }
    });

    // Leave a room for a specific preview
    socket.on("leave-bus", async (previewNumber) => {
      const identifier = normalizeSocketIdentifier(previewNumber);
      if (!identifier) return;
      pendingPreviewRooms.delete(identifier);
      const room = `preview_${identifier}`;
      try {
        await socket.leave(room);
      } catch (error) {
        console.error(
          `Preview room leave failed for ${identifier}: ${error?.message || error}`,
        );
      }
    });

    // Client requests the latest location for a bus (search by bus_no or preview).
    // Response payload deliberately avoids exposing internal bus_no. Returns previewNumber and location only.
    socket.on("request-bus-location", async (busIdentifier) => {
      const identifier = normalizeSocketIdentifier(busIdentifier);
      if (!identifier || disconnected) return;
      const now = Date.now();
      if (now - locationWindowStarted >= 60_000) {
        locationWindowStarted = now;
        locationRequests = 0;
      }
      locationRequests += 1;
      if (locationRequests > 30) {
        return socket.emit("locationUpdate", {
            previewNumber: identifier,
          error: "Too many location requests",
        });
      }
      try {
        // Resolve bus by bus_no first, then by preview_number.
        let bus = await BusModel.findOne({
            bus_no: normalizeBusNumber(identifier),
        })
            .select("_id bus_no preview_number")
            .lean();
        if (disconnected || socket.connected === false) return;
        if (!bus) {
            bus = await BusModel.findOne({
              preview_number: { $in: [identifier, String(identifier)] },
            })
              .select("_id bus_no preview_number")
              .lean();
            if (disconnected || socket.connected === false) return;
        }
        if (!bus) {
            return socket.emit("locationUpdate", {
              previewNumber: identifier,
              error: "Bus not found",
            });
        }

        const location = await BusLiveLocationModel.findOne({ bus_id: bus._id })
            .select(
              "latitude longitude speed is_online source lastSuccessfulGpsUpdate updatedAt",
            )
          .lean();
        if (disconnected || socket.connected === false) return;

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
          gpsOfflineThresholdMs:
            Number(process.env.GPS_OFFLINE_THRESHOLD_MS) || 3 * 60 * 1000,
        };

        socket.emit("locationUpdate", payload);
      } catch (err) {
        logSafeError("request-bus-location failed", err);
        if (!disconnected && socket.connected !== false) {
          socket.emit("locationUpdate", { error: "Location is unavailable" });
        }
      }
    });

    socket.on("disconnect", () => {
      disconnected = true;
      pendingPreviewRooms.clear();
    });
  });
}

module.exports = { registerTrackSocketHandlers };
