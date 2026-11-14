"use strict";

const User = require("../models/User");

async function preserveSuperadminAccess(
  users,
  { currentUserId, changingRole = null, session } = {},
) {
  const actorId = String(currentUserId || "");
  if (users.some((user) => String(user._id) === actorId)) {
    return "You cannot change or delete your own administrator account.";
  }

  const selectedActiveSuperadmins = users.filter(
    (user) => user.role === "superadmin" && user.is_active !== false,
  ).length;
  if (!selectedActiveSuperadmins) return null;

  let activeSuperadminsQuery = User.countDocuments({
    role: "superadmin",
    is_active: { $ne: false },
  });
  if (session) activeSuperadminsQuery = activeSuperadminsQuery.session(session);
  const activeSuperadmins = await activeSuperadminsQuery;
  const remaining = activeSuperadmins - selectedActiveSuperadmins;
  const replacementAdmins = changingRole === "superadmin"
    ? users.filter((user) => user.is_active !== false).length
    : 0;
  return remaining + replacementAdmins > 0
    ? null
    : "At least one active super admin account must remain.";
}

module.exports = { preserveSuperadminAccess };
