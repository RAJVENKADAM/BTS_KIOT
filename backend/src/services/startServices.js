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

  console.log('✅ MongoDB connected. Starting tracking service...');

  // Start bus tracking service (polls GPS API)
  const trackingService = require('./trackingService');
  try {
    trackingService.startTracking();
    console.log('✅ Bus tracking started successfully');
  } catch (error) {
    console.error('Error starting tracking service:', error.message);
  }
}

module.exports = {
  startDbDependentServices,
};

