const ExcelUserService = require("../services/excelUserService");

async function uploadExcelUsers(req, res) {
  req.setTimeout?.(0);
  res.setTimeout?.(0);
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Process Excel file
    const users = await ExcelUserService.processExcelBuffer(req.file.buffer);
    const results = await ExcelUserService.processUsers(users, req.user.id);
    const emailResults = Number.isInteger(results.emailsSent)
      ? []
      : await ExcelUserService.sendNotifications(results.emailsToNotify);
    const emailsSent = Number.isInteger(results.emailsSent)
      ? results.emailsSent
      : emailResults.filter((item) => item.status === "sent").length;
    const emailsFailed = Number.isInteger(results.emailsFailed)
      ? results.emailsFailed
      : emailResults.filter((item) => item.status === "failed").length;

    if (results.summary?.validRows === 0) {
      return res.status(400).json({
        success: false,
        error: "No valid workbook rows were available to import.",
        summary: results.summary,
      });
    }

    if (
      results.summary?.completed === false &&
      results.created.length + results.updated.length === 0
    ) {
      return res.status(500).json({
        success: false,
        error: "Excel import could not save any users.",
        summary: results.summary,
      });
    }

    res.status(200).json({
      message: results.summary?.partial
        ? "Excel users were processed partially."
        : "Excel users processed successfully",
      success: true,
      summary: results.summary,
      results: {
        created: results.created.length,
        updated: results.updated.length,
        skipped: results.skipped.length,
        emailsSent,
        emailsFailed,
      },
      details: {
        ...results,
        emailsToNotify: results.emailsToNotify.map(
          ({ permanentPassword, ...notification }) => notification,
        ),
      },
    });
  } catch (error) {
    if (error?.statusCode === 400 && error.summary) {
      return res.status(400).json({
        success: false,
        error: "Some workbook rows failed validation. No users were changed.",
        summary: error.summary,
      });
    }
    console.error("Excel user upload failed:", {
      name: error?.name || "Error",
      code: error?.code || null,
    });
    res.status(500).json({ error: "Excel user upload failed. Please try again." });
  } finally {
    if (req.file) req.file.buffer = null;
  }
}

module.exports = { uploadExcelUsers };