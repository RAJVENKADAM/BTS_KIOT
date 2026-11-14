const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const normalizeBusNumber = require('../utils/normalizeBusNumber');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },
    password_hash: {
      type: String,
      required: true
    },
    role: {
      type: String,
      enum: ['student', 'primary_admin', 'superadmin'],
      default: 'student'
    },
    bus_no: {
      type: String,
      default: null,
      set: normalizeBusNumber,
    },
    resourceVersion: {
      type: Number,
      min: 0,
      default: 0,
    },
    assignmentRevision: {
      type: Number,
      min: 0,
      default: 0,
    },
    is_active: {
      type: Boolean,
      default: true
    },
    temp_password: {
      type: Boolean,
      default: false
    },
    deleted_by_user: {
      type: Boolean,
      default: false
    },
    excel_upload_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ExcelUpload',
      default: null
    },
    is_temporary: {
      type: Boolean,
      default: false
    },
    push_token: {
      type: String,
      default: null
    }
  },
  { timestamps: true, optimisticConcurrency: true }
);

// Hash password before saving (Mongoose 9 async middleware — no next callback)
userSchema.pre('save', async function () {
  const modifiedPaths = this.modifiedPaths();
  if (
    !this.isNew &&
    modifiedPaths.some(
      (path) =>
        !['resourceVersion', 'assignmentRevision', '__v', 'updatedAt'].includes(path),
    )
  ) {
    this.resourceVersion = Math.max(0, Number(this.resourceVersion) || 0) + 1;
    if (
      modifiedPaths.some((path) =>
        ['bus_no', 'role', 'is_active', 'deleted_by_user'].includes(path),
      )
    ) {
      this.assignmentRevision =
        Math.max(0, Number(this.assignmentRevision) || 0) + 1;
    }
  }
  if (!this.isModified('password_hash')) return;
  const salt = await bcrypt.genSalt(12);
  this.password_hash = await bcrypt.hash(this.password_hash, salt);
});

userSchema.index({ role: 1, is_active: 1, bus_no: 1 });
userSchema.index({ excel_upload_id: 1, is_active: 1, _id: 1 });

// Compare password method
userSchema.methods.comparePassword = async function (password) {
  return await bcrypt.compare(password, this.password_hash);
};

module.exports = mongoose.model('User', userSchema);
