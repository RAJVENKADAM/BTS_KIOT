const shouldClearAuthSession = (status, data) => {
  const isSessionResponse =
    (status >= 200 && status < 300) || status === 401 || status === 403;
  const explicitlyInvalid =
    data?.valid === false || data?.deactivated === true;
  return isSessionResponse && explicitlyInvalid;
};

module.exports = { shouldClearAuthSession };
