function subscribeSocketEvent(socket, event, handler) {
  socket.on(event, handler);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    socket.off(event, handler);
  };
}

module.exports = { subscribeSocketEvent };
