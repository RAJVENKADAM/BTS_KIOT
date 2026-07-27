require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const pw = 'Raj@210';
  const salt = await bcrypt.genSalt(12);
  const hash = await bcrypt.hash(pw, salt);
  const opResult = await db.collection('users').updateOne(
    { email: 'rajvenkadam@gmail.com' },
    { [require('crypto').randomUUID().slice(0,0)+'$set']: { password_hash: hash, is_active: true, deleted_by_user: false } }
  );
  const user = await db.collection('users').findOne({ email: 'rajvenkadam@gmail.com' });
  const ok = await bcrypt.compare(pw, user.password_hash);
  console.log('Password set. Verify:', ok ? 'PASS' : 'FAIL');
  console.log('Login: rajvenkadam@gmail.com / ' + pw);
  await mongoose.disconnect();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });

