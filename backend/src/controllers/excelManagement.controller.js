const ExcelManagementService = require('../services/excelManagementService');

// Get all Excel uploads for current user
async function getAllExcelUploads(req, res) {
  try {
    const userId = req.user.id;
    const uploads = await ExcelManagementService.getAllExcelUploads(userId);
    
    res.status(200).json({
      success: true,
      data: uploads
    });
  } catch (error) {
    console.error('Get Excel uploads error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

// Get specific Excel upload
async function getExcelUpload(req, res) {
  try {
    const { id } = req.params;
    const upload = await ExcelManagementService.getExcelUploadById(id);
    
    if (!upload) {
      return res.status(404).json({
        success: false,
        error: 'Excel upload not found'
      });
    }
    
    res.status(200).json({
      success: true,
      data: upload
    });
  } catch (error) {
    console.error('Get Excel upload error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

// Re-upload/Edit Excel file
async function reuploadExcel(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    // Check file
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }

    console.log('Re-uploading Excel file:', {
      id,
      name: req.file.originalname,
      size: req.file.size
    });

    const result = await ExcelManagementService.reuploadExcel(
      id,
      req.file.buffer,
      req.file.originalname,
      userId
    );

    res.status(200).json({
      success: true,
      message: result.message,
      results: {
        created: result.results.created.length,
        updated: result.results.updated.length,
        deactivated: result.results.skipped.length,
        emailsSent: result.emailResults.filter(e => e.status === 'sent').length,
        emailsFailed: result.emailResults.filter(e => e.status === 'failed').length
      }
    });
  } catch (error) {
    console.error('Re-upload Excel error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

// Delete Excel upload
async function deleteExcelUpload(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    const result = await ExcelManagementService.deleteExcelUpload(id, userId);
    
    res.status(200).json({
      success: true,
      message: result.message,
      usersDeleted: result.usersDeleted
    });
  } catch (error) {
    console.error('Delete Excel upload error:', error);
    
    if (error.message.includes('Unauthorized')) {
      return res.status(403).json({
        success: false,
        error: error.message
      });
    }
    
    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: error.message
      });
    }
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

// Get users associated with Excel upload
async function getUsersByExcelUpload(req, res) {
  try {
    const { id } = req.params;
    const users = await ExcelManagementService.getUsersByExcelUpload(id);
    
    res.status(200).json({
      success: true,
      data: users
    });
  } catch (error) {
    console.error('Get users by Excel upload error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

module.exports = {
  getAllExcelUploads,
  getExcelUpload,
  reuploadExcel,
  deleteExcelUpload,
  getUsersByExcelUpload
};