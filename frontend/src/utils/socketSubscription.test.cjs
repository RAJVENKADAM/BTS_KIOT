const assert = require("node:assert/strict");
const test = require("node:test");
const { subscribeSocketEvent } = require("./socketSubscription.cjs");

function createSocketDouble() {
  const listeners = new Map();
  return {
    listeners,
    on(event, handler) {
      const eventListeners = listeners.get(event) || new Set();
      eventListeners.add(handler);
      listeners.set(event, eventListeners);
    },
    off(event, handler) {
      listeners.get(event)?.delete(handler);
    },
  };
}

test("screen listener cleanup removes the handler once and permits a single remount", () => {
  const socket = createSocketDouble();
  let calls = 0;
  const handler = () => {
    calls += 1;
  };

  const unmount = subscribeSocketEvent(socket, "locationUpdate", handler);
  assert.equal(socket.listeners.get("locationUpdate").size, 1);
  unmount();
  unmount();
  assert.equal(socket.listeners.get("locationUpdate").size, 0);

  const remount = subscribeSocketEvent(socket, "locationUpdate", handler);
  assert.equal(socket.listeners.get("locationUpdate").size, 1);
  [...socket.listeners.get("locationUpdate")][0]();
  assert.equal(calls, 1);
  remount();
  assert.equal(socket.listeners.get("locationUpdate").size, 0);
});
