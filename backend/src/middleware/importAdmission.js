const MAX_ACTIVE_IMPORTS = 2;
const RETRY_AFTER_SECONDS = 5;

let activeImports = 0;

function reserveImportCapacity(request, response, next) {
  if (activeImports >= MAX_ACTIVE_IMPORTS) {
    response.set("Retry-After", String(RETRY_AFTER_SECONDS));
    response.status(503).json({
      success: false,
      code: "IMPORT_BUSY",
      retryAfter: RETRY_AFTER_SECONDS,
      error: "Imports are temporarily busy. Please retry shortly.",
    });
    return;
  }

  activeImports += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeImports -= 1;
    if (request.file?.buffer) request.file.buffer = null;
    if (request.body) {
      request.body.users = null;
    }
  };
  response.once("finish", release);
  response.once("close", release);
  next();
}

module.exports = {
  reserveImportCapacity,
};
