const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

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
      default: null
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
    push_token: {
      type: String,
      default: null
    }
  },
  { timestamps: true }
);

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password_hash')) return next();
  try {
    const salt = await bcrypt.genSalt(12);
    this.password_hash = await bcrypt.hash(this.password_hash, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Compare password method
userSchema.methods.comparePassword = async function (password) {
  return await bcrypt.compare(password, this.password_hash);
};

module.exports = mongoose.model('User', userSchema);
