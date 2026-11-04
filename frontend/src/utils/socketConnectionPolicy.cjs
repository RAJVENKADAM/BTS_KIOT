const PERMANENT_SOCKET_AUTH_ERRORS = new Set([
  "Authentication required",
  "Invalid or expired token",
]);

function isPermanentSocketAuthenticationError(error) {
  return PERMANENT_SOCKET_AUTH_ERRORS.has(error?.message);
}

module.exports = { isPermanentSocketAuthenticationError };
