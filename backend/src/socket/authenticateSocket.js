const User = require("../models/User");
const { logSocketDiagnostic } = require("../utils/socketDiagnostics");

function createSocketAuthentication(
  jwt,
  getSecret = () => process.env.JWT_SECRET,
  UserModel = User,
) {
  return async (socket, next) => {
    const reject = (reason) => {
      logSocketDiagnostic("authentication-rejected", {
        socketId: socket.id || socket.conn?.id,
        disconnectReason: reason,
        transportType: socket.conn?.transport?.name,
        wasConnected: socket.connected === true,
      });
      return next(
        new Error(
          reason === "authentication-required"
            ? "Authentication required"
            : reason === "authentication-service-unavailable"
              ? "Authentication service unavailable"
              : "Invalid or expired token",
        ),
      );
    };
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, "");
    const secret = getSecret();

    if (!token || !secret) {
      return reject("authentication-required");
    }

    let payload;
    try {
      payload = jwt.verify(token, secret);
    } catch {
      return reject("invalid-or-expired-token");
    }

    if (!payload?.id) {
      return reject("invalid-or-expired-token");
    }

    try {
      const currentUser = await UserModel.findById(payload.id)
        .select("role is_active deleted_by_user")
        .lean();
      if (!currentUser || !currentUser.is_active || currentUser.deleted_by_user) {
        return reject("invalid-or-expired-token");
      }

      socket.user = {
        ...payload,
        id: String(payload.id),
        role: currentUser.role,
      };
      return next();
    } catch {
      return reject("authentication-service-unavailable");
    }
  };
}

module.exports = { createSocketAuthentication };
