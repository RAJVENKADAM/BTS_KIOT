const { waitForDbReady } = require('../config/startup');

// Singleton guards to prevent duplicate initialization
const singleton = {
  started: false,
};

async function startDbDependentServices() {
  if (singleton.started) return;
  singleton.started = true;

  const ok = await waitForDbReady({
    maxAttempts: 12,
    initialDelayMs: 1000,
    maxDelayMs: 8000,
  });

  if (!ok) {
    console.error('❌ MongoDB not ready after retries. Tracking will NOT start.');
    return;
  }

  console.log('✅ MongoDB connected. Starting GPS sync scheduler...');

  // Non-secret env presence logs for GPS provider credentials
  const hasToken = !!process.env.GPS_TOKEN;
  const hasEmail = !!process.env.GPS_EMAIL;
  console.log('🔐 GPS env check:', {
    GPS_TOKEN_set: hasToken,
    GPS_EMAIL_set: hasEmail,
    GPS_TOKEN_length: hasToken ? String(process.env.GPS_TOKEN).length : 0,
    GPS_EMAIL_value_present: hasEmail,
  });
  if (!hasToken || !hasEmail) {
    console.error('❌ GPS credentials missing. GPS sync will fail (check Render env vars).');
  }

  // Start GPS sync worker (polls GPS provider in background; HTTP handlers must remain DB-only)
  try {
    const gpsSyncWorker = require('../workers/gpsSyncWorker');
    gpsSyncWorker.start();
    console.log('✅ gpsSyncWorker started successfully');
  } catch (error) {
    console.error('Error starting gpsSyncWorker:', error.message);
  }
}

module.exports = {
  startDbDependentServices,
};

