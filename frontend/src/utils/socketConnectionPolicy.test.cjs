const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getSocketActionForAppStateChange,
  getPreviewRoomIds,
  isPermanentSocketAuthenticationError,
  shouldConnectSocketForAppState,
  SOCKET_RECONNECTION_ATTEMPTS,
  shouldReconnectAfterServerDisconnect,
} = require("./socketConnectionPolicy.cjs");

test("permanent authentication failures stop socket reconnect retries", () => {
  assert.equal(
    isPermanentSocketAuthenticationError(
      new Error("Authentication required"),
    ),
    true,
  );
  assert.equal(
    isPermanentSocketAuthenticationError(
      new Error("Invalid or expired token"),
    ),
    true,
  );
  assert.equal(
    isPermanentSocketAuthenticationError(new Error("network unavailable")),
    false,
  );
  assert.equal(isPermanentSocketAuthenticationError(null), false);
});

test("server-initiated socket revocation reconnects once to reauthenticate", () => {
  assert.equal(shouldReconnectAfterServerDisconnect("io server disconnect"), true);
  assert.equal(shouldReconnectAfterServerDisconnect("transport close"), false);
  assert.equal(shouldReconnectAfterServerDisconnect("ping timeout"), false);
});

test("app background disconnects and foreground reconnects without bypassing auth rejection", () => {
  assert.equal(
    getSocketActionForAppStateChange({
      previousAppState: "active",
      nextAppState: "background",
      socketConnected: true,
      authenticationRejected: false,
    }),
    "disconnect",
  );
  assert.equal(
    getSocketActionForAppStateChange({
      previousAppState: "background",
      nextAppState: "active",
      socketConnected: false,
      authenticationRejected: false,
    }),
    "connect",
  );
  assert.equal(
    getSocketActionForAppStateChange({
      previousAppState: "background",
      nextAppState: "active",
      socketConnected: false,
      authenticationRejected: true,
    }),
    null,
  );
});

test("socket uses bounded retries and only joins distinct preview rooms", () => {
  assert.equal(SOCKET_RECONNECTION_ATTEMPTS, 12);
  assert.equal(shouldConnectSocketForAppState("active"), true);
  assert.equal(shouldConnectSocketForAppState("background"), false);
  assert.deepEqual(
    getPreviewRoomIds("4", {
      busNo: "BUS-4",
      previewNumber: "4",
      effectivePreviewNumber: 8,
    }),
    ["4", "8"],
  );
  assert.deepEqual(
    getPreviewRoomIds(null, { bus_no: "BUS-9", preview_number: "9" }),
    ["9"],
  );
  assert.deepEqual(getPreviewRoomIds(null, null), []);
});
