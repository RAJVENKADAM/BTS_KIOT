function logSafeError(operation, error, requestId) {
  try {
    const name =
      typeof error?.name === "string" &&
      /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name)
        ? error.name
        : "Error";
    const code =
      typeof error?.code === "number"
        ? error.code
        : typeof error?.code === "string" &&
            /^[A-Z0-9_-]{1,40}$/.test(error.code)
          ? error.code
          : null;
    const details = {
      name,
      code,
    };
    if (
      typeof requestId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
    ) {
      details.requestId = requestId;
    }
    console.error(operation, details);
  } catch {
    // Logging failures must not change request behavior.
  }
}

module.exports = { logSafeError };
