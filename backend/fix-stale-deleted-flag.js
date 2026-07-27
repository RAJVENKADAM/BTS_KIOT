/**
 * Migration: Fix users who have is_active=true but deleted_by_user=true
 *
 * This happens when:
 * 1. An Excel upload is deleted → sets is_active=false, deleted_by_user=true
 * 2. The same users are re-imported via a new Excel upload
 * 3. Previously, the import code set is_active=true but did NOT reset deleted_by_user=false
 * 4. Auth login checks deleted_by_user FIRST → blocks login with "Account has been deleted"
 *
 * Run: node backend/fix-stale-deleted-flag.js
 */
const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/bts';

async function fixStaleDeletedFlag() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');

    const User = require('./src/models/User');

    // Find users who are active but also marked as deleted_by_user (the bug state)
    const result = await User.updateMany(
      { is_active: true, deleted_by_user: true },
      { $set: { deleted_by_user: false } }
    );

    console.log(`Fixed ${result.modifiedCount} users: is_active=true but deleted_by_user was true`);

    await mongoose.disconnect();
    console.log('Done');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

fixStaleDeletedFlag();

