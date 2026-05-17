const { getIO } = require('../socket');

// Initialize tracking socket handlers
function initTrackingHandlers(io) {
  io.on('connection', (socket) => {
    console.log('User connected to tracking socket:', socket.id);

    // Join a specific bus room - STANDARDIZED EVENT NAME
    socket.on('join-bus', (busNo) => {
      if (busNo) {
        socket.join(`bus_${busNo}`);
        console.log(`Socket ${socket.id} joined bus room: bus_${busNo}`);
      }
    });

    // Fallback: also listen for camelCase version for compatibility
    socket.on('joinBusRoom', (data) => {
      const busNo = typeof data === 'string' ? data : data?.busNo;
      if (busNo) {
        socket.join(`bus_${busNo}`);
        console.log(`Socket ${socket.id} joined bus room (legacy): bus_${busNo}`);
      }
    });

    // Leave a specific bus room - STANDARDIZED EVENT NAME
    socket.on('leave-bus', (busNo) => {
      if (busNo) {
        socket.leave(`bus_${busNo}`);
        console.log(`Socket ${socket.id} left bus room: bus_${busNo}`);
      }
    });

    // Fallback: also listen for camelCase version for compatibility
    socket.on('leaveBusRoom', (data) => {
      const busNo = typeof data === 'string' ? data : data?.busNo;
      if (busNo) {
        socket.leave(`bus_${busNo}`);
        console.log(`Socket ${socket.id} left bus room (legacy): bus_${busNo}`);
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