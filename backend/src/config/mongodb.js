/**
 * Build MongoDB URI with database name.
 * If MONGODB_URI doesn't include a database name (e.g. ends with /?options),
 * inject DB_NAME (default: bts_db) before the query string.
 */
function buildMongoURI(env = process.env) {
  const uri = env.MONGODB_URI;
  const dbName = env.DB_NAME || 'bts_db';

  if (!uri || !uri.trim()) {
    throw new Error('MONGODB_URI is required');
  }

  // Check if URI already has a database name (path between host and ?)
  // Pattern: hosts/DBNAME? or hosts/DBNAME (no query)
  const hasDbName = /\/[^/?]+(\?|$)/.test(uri.replace(/^.*@/, ''));

  if (hasDbName) return uri;

  // Inject database name before query parameters
  if (uri.endsWith('/')) return `${uri}${dbName}`;
  return uri.replace('/?', `/${dbName}?`);
}

function getMongoConnectionOptions(env = process.env) {
  const rawPoolSize = env.MONGODB_MAX_POOL_SIZE;
  const maxPoolSize = rawPoolSize === undefined || rawPoolSize === ""
    ? 100
    : Number(rawPoolSize);
  if (!Number.isSafeInteger(maxPoolSize) || maxPoolSize < 1 || maxPoolSize > 500) {
    throw new Error("MONGODB_MAX_POOL_SIZE must be an integer between 1 and 500.");
  }
  const rawWaitQueueTimeout = env.MONGODB_WAIT_QUEUE_TIMEOUT_MS;
  const waitQueueTimeoutMS =
    rawWaitQueueTimeout === undefined || rawWaitQueueTimeout === ""
      ? 10_000
      : Number(rawWaitQueueTimeout);
  if (
    !Number.isSafeInteger(waitQueueTimeoutMS) ||
    waitQueueTimeoutMS < 1 ||
    waitQueueTimeoutMS > 120_000
  ) {
    throw new Error(
      "MONGODB_WAIT_QUEUE_TIMEOUT_MS must be an integer between 1 and 120000.",
    );
  }
  return { maxPoolSize, waitQueueTimeoutMS };
}

function assertSafeDatabaseTarget(env = process.env) {
  const isLocalIntegration = env.TEST_ENVIRONMENT === 'local-integration';
  const isTestProcess =
    env.NODE_ENV === 'test' ||
    env.TEST_ENVIRONMENT === 'unit' ||
    Boolean(env.NODE_TEST_CONTEXT) ||
    process.env.NODE_ENV === 'test' ||
    process.env.TEST_ENVIRONMENT === 'unit' ||
    Boolean(process.env.NODE_TEST_CONTEXT);

  if (isTestProcess && !isLocalIntegration) {
    throw new Error('MongoDB connections are disabled for unit tests.');
  }
  if (!isLocalIntegration) return;

  let url;
  try {
    url = new URL(buildMongoURI(env));
  } catch {
    throw new Error('Local integration tests require a valid dedicated MongoDB URI.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const ipv4Parts = hostname.split('.');
  const isIpv4 =
    ipv4Parts.length === 4 &&
    ipv4Parts.every(
      (part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255,
    );
  if (
    !(
      hostname === 'localhost' ||
      hostname === '::1' ||
      (isIpv4 && Number(ipv4Parts[0]) === 127)
    ) ||
    !/^btms_test(?:_[a-z0-9_-]+)?$/i.test(databaseName)
  ) {
    throw new Error(
      'Local integration tests may connect only to loopback MongoDB and a btms_test database.',
    );
  }
}

let isConnected = false;

const connectDB = async ({ mongoose = require('mongoose'), env = process.env } = {}) => {
  assertSafeDatabaseTarget(env);
  if (isConnected) {
    console.log('MongoDB is already connected');
    return;
  }

  await mongoose.connect(buildMongoURI(env), getMongoConnectionOptions(env));
  isConnected = true;
  console.log('✅ MongoDB connected successfully');
};

const disconnectDB = async ({ mongoose = require('mongoose') } = {}) => {
  try {
    await mongoose.disconnect();
    isConnected = false;
    console.log('MongoDB disconnected');
  } catch (error) {
    require('../utils/safeErrorLog').logSafeError('MongoDB disconnect failed', error);
  }
};

module.exports = {
  assertSafeDatabaseTarget,
  buildMongoURI,
  connectDB,
  disconnectDB,
  getMongoConnectionOptions,
  get MONGODB_URI() {
    return buildMongoURI();
  },
};
