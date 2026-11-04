const PERMANENT_SOCKET_AUTH_ERRORS = new Set([
  "Authentication required",
  "Invalid or expired token",
]);
const SOCKET_RECONNECTION_DELAY_MS = 1_000;
const SOCKET_RECONNECTION_MAX_DELAY_MS = 30_000;
const SOCKET_RECONNECTION_RANDOMIZATION_FACTOR = 0.5;
const SOCKET_RECONNECTION_ATTEMPTS = 12;

function shouldConnectSocketForAppState(appState) {
  return appState === "active";
}

function getPreviewRoomIds(selectedPreviewNumber, busData) {
  return [
    ...new Set(
      [
        selectedPreviewNumber,
        busData?.previewNumber,
        busData?.preview_number,
        busData?.effectivePreviewNumber,
      ]
        .filter((identifier) => identifier != null && String(identifier).trim())
        .map((identifier) => String(identifier).trim()),
    ),
  ];
}

function isPermanentSocketAuthenticationError(error) {
  return PERMANENT_SOCKET_AUTH_ERRORS.has(error?.message);
}

function shouldReconnectAfterServerDisconnect(reason) {
  return reason === "io server disconnect";
}

function getSocketActionForAppStateChange({
  previousAppState,
  nextAppState,
  socketConnected,
  authenticationRejected,
}) {
  const wasActive = previousAppState === "active";
  const isActive = nextAppState === "active";
  if (!isActive) return socketConnected ? "disconnect" : null;
  if (!wasActive && !authenticationRejected && !socketConnected) {
    return "connect";
  }
  return null;
}

module.exports = {
  getSocketActionForAppStateChange,
  getPreviewRoomIds,
  isPermanentSocketAuthenticationError,
  SOCKET_RECONNECTION_DELAY_MS,
  SOCKET_RECONNECTION_ATTEMPTS,
  SOCKET_RECONNECTION_MAX_DELAY_MS,
  SOCKET_RECONNECTION_RANDOMIZATION_FACTOR,
  shouldReconnectAfterServerDisconnect,
  shouldConnectSocketForAppState,
};
