const ExcelManagementService = require('../services/excelManagementService');

async function uploadExcelUsers(req, res) {
  try {
    console.log('Upload endpoint hit');
    console.log('Request user:', req.user);
    console.log('File info:', req.file ? { originalname: req.file.originalname, size: req.file.size, mimetype: req.file.mimetype } : 'No file');
    
    // Check if file was uploaded
    if (!req.file) {
      console.log('No file found in request');
      return res.status(400).json({
        error: 'No file uploaded'
      });
    }

    // Process the Excel file from buffer (memory storage)
    if (!req.file.buffer) {
      console.log('File buffer is empty');
      return res.status(400).json({
        error: 'Uploaded file is empty'
      });
    }
    
    console.log('Processing file from buffer, size:', req.file.buffer.length);

    // Process the Excel file with tracking
    const customName = req.body.customName || null;
    const result = await ExcelManagementService.processExcelWithTracking(
      req.file.buffer,
      req.file.originalname,
      req.user.id,
      customName
    );
    
    console.log('Excel file processed with tracking, results:', result);

    // Return success response
    res.status(200).json({
      message: 'Excel users processed successfully',
      excelUploadId: result.excelUploadId,
      customName: customName,
      results: {
        created: result.results.created.length,
        updated: result.results.updated.length,
        skipped: result.results.skipped.length,
        emailsSent: result.emailResults.filter(r => r.status === 'sent').length,
        emailsFailed: result.emailResults.filter(r => r.status === 'failed').length
      },
      details: {
        created: result.results.created,
        updated: result.results.updated,
        skipped: result.results.skipped,
        emailResults: result.emailResults
      }
    });
  } catch (error) {
    console.error('Error in uploadExcelUsers:', error);
    // Log more detailed error information for debugging
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    
    res.status(500).json({
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

module.exports = { uploadExcelUsers };