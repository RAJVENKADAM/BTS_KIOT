const { waitForDbReady } = require('../config/startup');

// Singleton guards to prevent duplicate initialization on Render restarts
// within the same process (or accidental re-require).
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
    // Do not crash the Render instance; the app can still serve health/routes.
    console.error('DB not ready after retries. GPS polling and bus state tracking will NOT start yet.');
    return;
  }

  // Start GPS polling and bus state tracking only after DB is connected.
  const gpsService = require('./gpsService');
  const busStateService = require('./busStateService');

  // GPS polling is rate-limited internally; still ensure it does not create duplicates.
  gpsService.startPolling();
  busStateService.startTracking();

  console.log('✅ DB ready: GPS polling and bus state tracking started');
}

module.exports = {
  startDbDependentServices,
};

