/**
 * Reset the superadmin password to the user's actual password (Raj@210).
 * Run: node reset-superadmin-password.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

async function resetPassword() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const newPassword = 'Raj@210';
  const salt = await bcrypt.genSalt(12);
  const hash = await bcrypt.hash(newPassword, salt);

  const result = await db.collection('users').updateOne(
    { email: 'rajvenkadam@gmail.com' },
    { $set: { password_hash: hash, is_active: true, deleted_by_user: false } }
  );

  if (result.matchedCount === 0) {
    console.log('No user found with email rajvenkadam@gmail.com');
    const count = await db.collection('users').countDocuments();
    console.log('Total users in DB:', count);
  } else {
    console.log('Superadmin password reset successfully!');
    // Verify the hash works
    const user = await db.collection('users').findOne({ email: 'rajvenkadam@gmail.com' });
    const verify = await bcrypt.compare(newPassword, user.password_hash);
    console.log('Password verification test:', verify ? 'PASS' : 'FAIL');
  }

  console.log('Login with: rajvenkadam@gmail.com / ' + newPassword);
  await mongoose.disconnect();
  process.exit(0);
}

resetPassword().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});</absolute_path>
</create_file>
