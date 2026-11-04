const { waitForDbReady } = require('../config/startup');
const { logSafeError } = require('../utils/safeErrorLog');

// Singleton guards to prevent duplicate initialization
const singleton = {
  started: false,
  starting: false,
  stopping: false,
  retryTimer: null,
  startupPromise: null,
};

const STARTUP_RETRY_DELAY_MS = 30_000;

function logStartupEvent(event, details = {}) {
  try {
    console.log(JSON.stringify({ event, ...details }));
  } catch {
    // Startup logging must not prevent service initialization.
  }
}

function scheduleStartupRetry() {
  if (singleton.stopping || singleton.retryTimer) return;
  singleton.retryTimer = setTimeout(() => {
    singleton.retryTimer = null;
    startDbDependentServices().catch((error) =>
      logSafeError('Retrying DB-dependent service startup failed', error),
    );
  }, STARTUP_RETRY_DELAY_MS);
  singleton.retryTimer.unref?.();
}

async function performStartup() {
  let gpsSyncWorker;
  try {
    const ok = await waitForDbReady({
      maxAttempts: 12,
      initialDelayMs: 1000,
      maxDelayMs: 8000,
    });

    if (!ok) {
      logStartupEvent('DB_NOT_READY_AFTER_RETRIES', {
        retryInMs: STARTUP_RETRY_DELAY_MS,
      });
      scheduleStartupRetry();
      return;
    }
    if (singleton.stopping) return;

    logStartupEvent('MONGODB_CONNECTED_STARTING_GPS_WORKER');

    const hasToken = !!process.env.GPS_TOKEN;
    const hasEmail = !!process.env.GPS_EMAIL;
    logStartupEvent('GPS_CREDENTIALS_CONFIGURED', {
      configured: hasToken && hasEmail,
    });
    if (!hasToken || !hasEmail) {
      logStartupEvent('GPS_CREDENTIALS_MISSING');
    }

    try {
      gpsSyncWorker = require('../workers/gpsSyncWorker');
      gpsSyncWorker.start();
    } catch (error) {
      if (gpsSyncWorker) {
        try {
          await gpsSyncWorker.stop();
        } catch (cleanupError) {
          logSafeError('Cleaning up GPS worker after startup failure failed', cleanupError);
        }
      }
      logSafeError('Starting gpsSyncWorker failed', error);
      scheduleStartupRetry();
      return;
    }

    singleton.started = true;
    logStartupEvent('GPS_WORKER_STARTED');
  } finally {
    singleton.starting = false;
  }
}

async function startDbDependentServices() {
  if (singleton.started || singleton.starting || singleton.stopping) return;
  if (singleton.retryTimer) {
    clearTimeout(singleton.retryTimer);
    singleton.retryTimer = null;
  }
  singleton.starting = true;
  const startupPromise = performStartup();
  singleton.startupPromise = startupPromise;
  try {
    await startupPromise;
  } catch (error) {
    scheduleStartupRetry();
    throw error;
  } finally {
    if (singleton.startupPromise === startupPromise) {
      singleton.startupPromise = null;
    }
  }
}

async function stopDbDependentServices() {
  singleton.stopping = true;
  if (singleton.retryTimer) {
    clearTimeout(singleton.retryTimer);
    singleton.retryTimer = null;
  }
  await singleton.startupPromise;
}

module.exports = {
  startDbDependentServices,
  stopDbDependentServices,
};
