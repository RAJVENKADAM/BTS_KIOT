/**
 * setup-db.js — Seeds the superadmin user into MongoDB.
 *
 * The superadmin credentials are defined in .env:
 *   SUPERADMIN_EMAIL=rajvenkadam@gmail.com
 *   SUPERADMIN_PASSWORD_HASH=$2a$12$... (already bcrypt hashed)
 *
 * IMPORTANT: The hash is ALREADY bcrypt hashed, so we must bypass
 * Mongoose's pre('save') middleware to avoid double-hashing.
 * We use User.collection.insertOne() to insert the raw document.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/amuxdb';

async function setupDatabase() {
  try {
    console.log('Connecting to MongoDB:', MONGODB_URI.replace(/\/\/.*@/, '//<credentials>@'));
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const db = mongoose.connection.db;
    const usersCollection = db.collection('users');

    const superadminEmail = process.env.SUPERADMIN_EMAIL || 'rajvenkadam@gmail.com';
    const passwordHash = process.env.SUPERADMIN_PASSWORD_HASH;

    if (!passwordHash) {
      console.error('❌ SUPERADMIN_PASSWORD_HASH is not set in .env');
      process.exit(1);
    }

    // Check if superadmin already exists
    const existing = await usersCollection.findOne({ email: superadminEmail });

    if (existing) {
      console.log(`ℹ️  Superadmin ${superadminEmail} already exists. Updating password hash...`);
      await usersCollection.updateOne(
        { email: superadminEmail },
        {
          $set: {
            password_hash: passwordHash,
            is_active: true,
            deleted_by_user: false,
            role: 'superadmin',
            updatedAt: new Date(),
          },
        }
      );
      console.log('✅ Superadmin updated successfully');
    } else {
      // Insert superadmin with pre-hashed password (bypass Mongoose middleware)
      await usersCollection.insertOne({
        name: 'Super Admin',
        email: superadminEmail,
        password_hash: passwordHash,
        role: 'superadmin',
        is_active: true,
        deleted_by_user: false,
        temp_password: false,
        bus_no: null,
        push_token: null,
        excel_upload_id: null,
        is_temporary: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      console.log('✅ Superadmin created successfully');
    }

    // Verify the user was stored correctly
    const verified = await usersCollection.findOne(
      { email: superadminEmail },
      { projection: { email: 1, role: 1, is_active: 1, password_hash: 1 } }
    );
    console.log('\n📋 Superadmin record:');
    console.log(`   Email:       ${verified.email}`);
    console.log(`   Role:        ${verified.role}`);
    console.log(`   Active:      ${verified.is_active}`);
    console.log(`   Password:    ${verified.password_hash.substring(0, 20)}... (bcrypt hash stored)`);

    // Test that the hash matches $2a$12$ pattern (bcrypt)
    if (!verified.password_hash.startsWith('$2a$12$') && !verified.password_hash.startsWith('$2b$12$')) {
      console.warn('⚠️  Warning: Password hash does not start with $2a$12$ or $2b$12$ (bcrypt cost 12)');
    } else {
      console.log('✅ Password hash is valid bcrypt (cost factor 12)');
    }

    await mongoose.disconnect();
    console.log('\n✅ Database setup complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Database setup failed:', error.message);
    process.exit(1);
  }
}

setupDatabase();

