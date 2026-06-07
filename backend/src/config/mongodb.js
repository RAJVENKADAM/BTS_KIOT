const mongoose = require('mongoose');

/**
 * Build MongoDB URI with database name.
 * If MONGODB_URI doesn't include a database name (e.g. ends with /?options),
 * inject DB_NAME (default: bts_db) before the query string.
 */
function buildMongoURI() {
  const uri = process.env.MONGODB_URI || 'mongodb+srv://rajvenkadam_db_user:...';
  const dbName = process.env.DB_NAME || 'bts_db';

  // Check if URI already has a database name (path between host and ?)
  // Pattern: hosts/DBNAME? or hosts/DBNAME (no query)
  const hasDbName = /\/[^/?]+(\?|$)/.test(uri.replace(/^.*@/, ''));

  if (hasDbName) return uri;

  // Inject database name before query parameters
  return uri.replace('/?', `/${dbName}?`);
}

const MONGODB_URI = buildMongoURI();
let isConnected = false;

const connectDB = async () => {
  if (isConnected) {
    console.log('MongoDB is already connected');
    return;
  }

  try {
    await mongoose.connect(MONGODB_URI);
    isConnected = true;
    console.log('✅ MongoDB connected successfully');
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    process.exit(1);
  }
};

const disconnectDB = async () => {
  try {
    await mongoose.disconnect();
    isConnected = false;
    console.log('MongoDB disconnected');
  } catch (error) {
    console.error('Error disconnecting MongoDB:', error);
  }
};

module.exports = { connectDB, disconnectDB, MONGODB_URI };
