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

  // Start GPS sync scheduler (polls GPS provider on a single loop)
  const trackingService = require('./trackingService');
  try {
    trackingService.start();
    console.log('✅ GPS sync scheduler started successfully');
  } catch (error) {
    console.error('Error starting GPS sync scheduler:', error.message);
  }
}

module.exports = {
  startDbDependentServices,
};

