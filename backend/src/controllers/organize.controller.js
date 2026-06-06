const ExcelUserService = require("../services/excelUserService");

async function uploadExcelUsers(req, res) {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    console.log("Excel file received:", {
      name: req.file.originalname,
      size: req.file.size,
    });

    // Process Excel file
    const users = await ExcelUserService.processExcelBuffer(req.file.buffer);
    const results = await ExcelUserService.processUsers(users, req.user.id);
    const emailResults = await ExcelUserService.sendNotifications(results.emailsToNotify);

    res.status(200).json({
      message: "Excel users processed successfully",
      results: {
        created: results.created.length,
        updated: results.updated.length,
        skipped: results.skipped.length,
        emailsSent: emailResults.filter(e => e.status === "sent").length,
        emailsFailed: emailResults.filter(e => e.status === "failed").length,
      },
      details: results,
    });
  } catch (error) {
    console.error("Excel upload error:", error);
    res.status(500).json({ error: error.message });
  }
}

module.exports = { uploadExcelUsers };