const { getIO } = require('../socket');

// Initialize tracking socket handlers
function initTrackingHandlers(io) {
  io.on('connection', (socket) => {
    console.log('User connected to tracking socket:', socket.id);

    // Join a specific bus room
    socket.on('joinBusRoom', (data) => {
      const { busNo } = data;
      if (busNo) {
        socket.join(`bus_${busNo}`);
        console.log(`Socket ${socket.id} joined bus room: bus_${busNo}`);
      }
    });

    // Leave a specific bus room
    socket.on('leaveBusRoom', (data) => {
      const { busNo } = data;
      if (busNo) {
        socket.leave(`bus_${busNo}`);
        console.log(`Socket ${socket.id} left bus room: bus_${busNo}`);
      }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      console.log('User disconnected from tracking socket:', socket.id);
    });
  });
}

module.exports = {
  initTrackingHandlers
};