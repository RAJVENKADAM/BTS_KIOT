// socket.js - Module to share Socket.IO instance
let ioInstance = null;

function getIO() {
  if (!ioInstance) {
    console.warn('⚠️ Socket.IO instance not initialized. Ensure server started and setIO called.');
  }
  return ioInstance;
}

module.exports = {
  getIO,
  setIO: (io) => {
    ioInstance = io;
    console.log('✅ Socket.IO instance set globally');
  }
};
