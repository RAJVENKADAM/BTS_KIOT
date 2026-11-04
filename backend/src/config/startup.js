const mongoose = require('mongoose');
const { MONGODB_URI } = require('./mongodb');
const { logSafeError } = require('../utils/safeErrorLog');

function logStartupEvent(event, details = {}) {
  try {
    console.log(JSON.stringify({ event, ...details }));
  } catch {
    // Startup logging must not interrupt database readiness checks.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testMongoConnection() {
  try {
    const state = mongoose.connection.readyState;
    // 1 = connected
    if (state === 1) return true;

    if (state === 0 || state === 3) {
      // Not connected, try to connect (Mongoose v9+ no longer supports legacy options)
      await mongoose.connect(MONGODB_URI);
      return true;
    }
    return false;
  } catch (error) {
    logSafeError('MongoDB connection check failed', error);
    return false;
  }
}

async function waitForDbReady({
  maxAttempts = 10,
  initialDelayMs = 1000,
  maxDelayMs = 10000,
} = {}) {
  let attempt = 0;
  let delayMs = initialDelayMs;

  while (attempt < maxAttempts) {
    attempt += 1;
    const ok = await testMongoConnection();
    if (ok) return true;

    logStartupEvent('MONGODB_CONNECTION_RETRY', {
      attempt,
      maxAttempts,
      retryInMs: delayMs,
    });
    await sleep(delayMs);
    delayMs = Math.min(maxDelayMs, delayMs * 2);
  }

  return false;
}

module.exports = {
  waitForDbReady,
};
