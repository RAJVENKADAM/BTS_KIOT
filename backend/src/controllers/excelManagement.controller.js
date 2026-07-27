const mongoose = require('mongoose');
const ExcelUpload = require('../models/ExcelUpload');
const User = require('../models/User');

// Get all Excel uploads for current user
async function getAllExcelUploads(req, res) {
  try {
    const userId = req.user?.id;

    // Use Mongoose's built-in ObjectId validator instead of fragile length check.
    if (!userId || typeof userId !== 'string' || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(200).json({
        success: true,
        data: []
      });
    }

    const uploads = await ExcelUpload.find({ uploaded_by: userId })
      .sort({ createdAt: -1 })
      .select('_id file_name custom_name uploaded_by createdAt updatedAt is_active');

    // Ensure frontend receives a stable `id` field and uses `custom_name` correctly.
    const normalized = uploads.map((u) => {
      const obj = u.toObject();
      // Frontend expects: upload.id and upload.custom_name
      return {
        ...obj,
        id: obj._id,
        custom_name: obj.custom_name,
        uploaded_at: obj.createdAt,
      };
    });

    res.status(200).json({
      success: true,
      data: normalized
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
    const upload = await ExcelUpload.findById(id);
    
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

// Re-upload Excel file
async function reuploadExcel(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    
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

    // Update Excel upload record
    const upload = await ExcelUpload.findByIdAndUpdate(
      id,
      {
        file_name: req.file.originalname,
        updatedAt: new Date()
      },
      { new: true }
    );

    if (!upload) {
      return res.status(404).json({
        success: false,
        error: 'Excel upload not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Excel file re-uploaded successfully',
      data: upload
    });
  } catch (error) {
    console.error('Re-upload Excel error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

// Delete Excel upload and cascade-wipe all linked users
async function deleteExcelUpload(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    const upload = await ExcelUpload.findById(id);
    
    if (!upload) {
      return res.status(404).json({
        success: false,
        error: 'Excel upload not found'
      });
    }

    // Only user who uploaded or admin can delete
    if (upload.uploaded_by.toString() !== userId && req.user.role !== 'superadmin') {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized to delete this upload'
      });
    }

    // ❗ CRITICAL FIX: Soft-deactivate all users linked to this ExcelUpload
    // Changed from User.deleteMany() to User.updateMany() to avoid permanent data loss.
    // This sets is_active=false, deleted_by_user=true so users cannot log in,
    // but their account records and history are preserved.
    const updateResult = await User.updateMany(
      { excel_upload_id: id },
      { $set: { is_active: false, deleted_by_user: true } }
    );

    // Delete the upload record
    await ExcelUpload.findByIdAndDelete(id);

    res.status(200).json({
      success: true,
      message: 'Excel upload deleted and associated users deactivated successfully',
      deactivatedUsers: updateResult.modifiedCount || 0
    });
  } catch (error) {
    console.error('Delete Excel upload error:', error);
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
    
    // Find Excel upload
    const upload = await ExcelUpload.findById(id);
    if (!upload) {

      return res.status(404).json({
        success: false,
        error: 'Excel upload not found'
      });
    }

    // Find active users linked to this Excel upload (FIX 3: filter only active users)
    const users = await User.find({ excel_upload_id: id, is_active: true })
      .select('name email role bus_no is_active');

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