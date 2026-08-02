/**
 * trackSocket.js — Socket.IO handlers for live bus room events.
 * Clients join `bus_<BUSNO>` rooms to receive real-time bus updates
 * (e.g. current plan changes).
 */
const { getIO } = require('../socket');

function registerTrackSocketHandlers() {
  const io = getIO();
  if (!io) return;

  io.on('connection', (socket) => {
    // Join a room for a specific bus to receive live updates
    socket.on('join-bus', (busNo) => {
      if (!busNo) return;
      const room = `bus_${String(busNo).toUpperCase()}`;
      socket.join(room);
    });

    // Leave a room for a specific bus
    socket.on('leave-bus', (busNo) => {
      if (!busNo) return;
      const room = `bus_${String(busNo).toUpperCase()}`;
      socket.leave(room);
    });
  });
}

module.exports = { registerTrackSocketHandlers };

