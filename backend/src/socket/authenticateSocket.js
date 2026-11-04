const User = require("../models/User");

function createSocketAuthentication(
  jwt,
  getSecret = () => process.env.JWT_SECRET,
  UserModel = User,
) {
  return async (socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, "");
    const secret = getSecret();

    if (!token || !secret) {
      return next(new Error("Authentication required"));
    }

    let payload;
    try {
      payload = jwt.verify(token, secret);
    } catch {
      return next(new Error("Invalid or expired token"));
    }

    if (!payload?.id) {
      return next(new Error("Invalid or expired token"));
    }

    try {
      const currentUser = await UserModel.findById(payload.id)
        .select("role is_active deleted_by_user")
        .lean();
      if (!currentUser || !currentUser.is_active || currentUser.deleted_by_user) {
        return next(new Error("Invalid or expired token"));
      }

      socket.user = {
        ...payload,
        id: String(payload.id),
        role: currentUser.role,
      };
      return next();
    } catch {
      return next(new Error("Authentication service unavailable"));
    }
  };
}

module.exports = { createSocketAuthentication };
