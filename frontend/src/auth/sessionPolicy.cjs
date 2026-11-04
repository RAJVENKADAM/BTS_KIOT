const shouldClearAuthSession = (status, data) => {
  const isSessionResponse =
    (status >= 200 && status < 300) || status === 401 || status === 403;
  const explicitlyInvalid =
    data?.valid === false || data?.deactivated === true;
  const unsupportedMobileRole =
    data?.valid === true &&
    typeof data.user?.role === "string" &&
    data.user.role.toLowerCase() === "superadmin";
  return isSessionResponse && (explicitlyInvalid || unsupportedMobileRole);
};

module.exports = { shouldClearAuthSession };
