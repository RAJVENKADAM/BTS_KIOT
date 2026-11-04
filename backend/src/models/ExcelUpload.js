const mongoose = require('mongoose');

const excelUploadSchema = new mongoose.Schema(
  {
    file_name: {
      type: String,
      required: true
    },
    custom_name: {
      type: String,
      default: null
    },
    uploaded_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    is_active: {
      type: Boolean,
      default: true
    }
  },
  { timestamps: true }
);

excelUploadSchema.index({ uploaded_by: 1, createdAt: -1 });

module.exports = mongoose.model('ExcelUpload', excelUploadSchema);
