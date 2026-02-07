// socket.js - Module to share Socket.IO instance
let ioInstance = null;

module.exports = {
  getIO: () => ioInstance,
  setIO: (io) => {
    ioInstance = io;
  }
};