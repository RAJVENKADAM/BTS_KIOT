const multer = require("multer");
const {
  parseBusRoutesWorkbook,
  createUserWorkbookRows,
} = require("../utils/spreadsheetImport");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (request, file, callback) => {
    if (!/\.xlsx$/i.test(file.originalname)) {
      callback(new Error("Upload an .xlsx workbook."));
      return;
    }
    callback(null, true);
  },
});

function uploadWorkbook(fieldName, required = false) {
  return (request, response, next) => {
    upload.single(fieldName)(request, response, (error) => {
      if (error) {
        const status = error instanceof multer.MulterError &&
          error.code === "LIMIT_FILE_SIZE"
          ? 413
          : 400;
        response.status(status).json({
          success: false,
          error: error.message || "Could not receive the Excel workbook.",
        });
        return;
      }
      if (required && !request.file) {
        response.status(400).json({
          success: false,
          error: "Select an Excel workbook to upload.",
        });
        return;
      }
      next();
    });
  };
}

function parseUserWorkbookUpload(request, response, next) {
  const excelCustomName = String(request.body?.excelCustomName || "").trim();
  if (!excelCustomName) {
    response.status(400).json({
      success: false,
      error: "Enter a name for this user workbook.",
    });
    return;
  }

  try {
    const rowIterator = createUserWorkbookRows(request.file.buffer);
    request.file.buffer = null;
    const users = { [Symbol.iterator]: rowIterator };
    request.body = { ...request.body, users, excelCustomName };
    next();
  } catch {
    if (request.file) request.file.buffer = null;
    response.status(400).json({
      success: false,
      error: "Could not read the Excel workbook. Check the file format and try again.",
    });
  }
}

function parseBusRoutesWorkbookUpload(request, response, next) {
  if (!request.file) {
    next();
    return;
  }

  try {
    request.body = {
      ...request.body,
      routesByPlan: parseBusRoutesWorkbook(request.file.buffer),
    };
    next();
  } catch (error) {
    response.status(400).json({
      success: false,
      error: error.message || "Could not read the route workbook.",
    });
  }
}

module.exports = {
  parseBusRoutesWorkbookUpload,
  parseUserWorkbookUpload,
  uploadBusRoutesWorkbook: uploadWorkbook("routesFile"),
  uploadUserWorkbook: uploadWorkbook("file", true),
};
