const { waitForDbReady } = require('../config/startup');

// Singleton guards to prevent duplicate initialization
const singleton = {
  started: false,
  starting: false,
};

async function startDbDependentServices() {
  if (singleton.started || singleton.starting) return;
  singleton.starting = true;

  let gpsSyncWorker;
  try {
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

    // Check GPS credentials exist (log yes/no only, never actual values)
    const hasToken = !!process.env.GPS_TOKEN;
    const hasEmail = !!process.env.GPS_EMAIL;
    console.log('🔐 GPS credentials configured:', hasToken && hasEmail);
    if (!hasToken || !hasEmail) {
      console.error('❌ GPS credentials missing. GPS sync will fail (check Render env vars).');
    }

    // Start GPS worker only after the database is ready.
    try {
      gpsSyncWorker = require('../workers/gpsSyncWorker');
      gpsSyncWorker.start();
    } catch (error) {
      if (gpsSyncWorker) {
        try {
          await gpsSyncWorker.stop();
        } catch (cleanupError) {
          console.error('Failed to clean up gpsSyncWorker after startup failure:', cleanupError.message);
        }
      }
      console.error('Error starting gpsSyncWorker:', error.message);
      return;
    }

    singleton.started = true;
    console.log('✅ gpsSyncWorker started successfully');
  } finally {
    singleton.starting = false;
  }
}

module.exports = {
  startDbDependentServices,
};
