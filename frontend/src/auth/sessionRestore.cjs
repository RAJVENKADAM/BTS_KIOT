async function restoreCachedSession({
  token,
  storedUser,
  verify,
  clear,
  shouldClear,
}) {
  if (!token || !storedUser) return null;

  const user = JSON.parse(storedUser);
  let verification;
  try {
    verification = await verify(token);
  } catch {
    if (typeof user?.role === "string" && user.role.toLowerCase() === "superadmin") {
      return null;
    }
    return { token, user };
  }

  const status =
    typeof verification?.status === "number" ? verification.status : 200;
  const data = verification?.data ?? verification;
  if (shouldClear(status, data)) {
    await clear();
    return null;
  }

  const restoredUser =
    data?.valid === true && data.user
      ? { ...user, ...data.user }
      : user;
  if (
    typeof restoredUser?.role === "string" &&
    restoredUser.role.toLowerCase() === "superadmin"
  ) {
    return null;
  }

  return {
    token,
    user: restoredUser,
  };
}

module.exports = { restoreCachedSession };
