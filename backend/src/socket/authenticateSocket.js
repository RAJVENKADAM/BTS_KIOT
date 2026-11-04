function createSocketAuthentication(jwt, getSecret = () => process.env.JWT_SECRET) {
  return (socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, "");
    const secret = getSecret();

    if (!token || !secret) {
      return next(new Error("Authentication required"));
    }

    jwt.verify(token, secret, (error, user) => {
      if (error || !user?.id) {
        return next(new Error("Invalid or expired token"));
      }
      socket.user = { ...user, id: String(user.id) };
      next();
    });
  };
}

module.exports = { createSocketAuthentication };
