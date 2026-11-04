// socket.js - Module to share Socket.IO instance
let ioInstance = null;

function getIO() {
  if (!ioInstance) {
    console.warn('⚠️ Socket.IO instance not initialized. Ensure server started and setIO called.');
  }
  return ioInstance;
}

function disconnectUserSockets(userIds) {
  const ids = [...new Set(
    (Array.isArray(userIds) ? userIds : [userIds])
      .filter((id) => id != null)
      .map((id) => String(id)),
  )];
  if (!ioInstance || !ids.length) return 0;

  let operator = ioInstance;
  for (const id of ids) {
    operator = operator.to(`user_${id}`);
  }
  operator.disconnectSockets(true);
  return ids.length;
}

function emitBusAssignmentNotification(userId, busNumber) {
  if (!ioInstance || userId == null) return false;
  const assignmentBusNo = busNumber == null ? null : String(busNumber);
  ioInstance.to(`user_${String(userId)}`).emit("notification", {
    type: assignmentBusNo ? "bus_reassigned" : "bus_unassigned",
    message: assignmentBusNo
      ? `Your bus assignment changed to Bus ${assignmentBusNo}.`
      : "Your bus assignment was removed.",
    assignmentBusNo,
  });
  return true;
}

module.exports = {
  getIO,
  disconnectUserSockets,
  emitBusAssignmentNotification,
  setIO: (io) => {
    ioInstance = io;
    console.log('✅ Socket.IO instance set globally');
  }
};
