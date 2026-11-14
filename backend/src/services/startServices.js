const { waitForDbReady } = require('../config/startup');
const { logSafeError } = require('../utils/safeErrorLog');

// Singleton guards to prevent duplicate initialization
const singleton = {
  started: false,
  starting: false,
  stopping: false,
  retryTimer: null,
  startupPromise: null,
  gpsSyncWorker: null,
  gpsWorkerStartEnabled: false,
  gpsWorkerStartCount: 0,
  gpsOwnership: null,
  gpsLeaseRenewTimer: null,
  gpsLeaseLossPromise: null,
  gpsLocationPublisher: null,
  assignmentPropagationStop: null,
};

const STARTUP_RETRY_DELAY_MS = 30_000;

function logStartupEvent(event, details = {}) {
  try {
    console.log(JSON.stringify({ event, ...details }));
  } catch {
    // Startup logging must not prevent service initialization.
  }
}

function scheduleStartupRetry(options) {
  if (singleton.stopping || singleton.retryTimer) return;
  singleton.retryTimer = setTimeout(() => {
    singleton.retryTimer = null;
    startDbDependentServices(options).catch((error) =>
      logSafeError('Retrying DB-dependent service startup failed', error),
    );
  }, STARTUP_RETRY_DELAY_MS);
  singleton.retryTimer.unref?.();
}

function clearGpsLeaseRenewal() {
  if (!singleton.gpsLeaseRenewTimer) return;
  clearInterval(singleton.gpsLeaseRenewTimer);
  singleton.gpsLeaseRenewTimer = null;
}

async function handleGpsOwnershipLoss(ownership, options, error) {
  if (singleton.gpsOwnership !== ownership) return;
  if (singleton.gpsLeaseLossPromise) return singleton.gpsLeaseLossPromise;
  singleton.gpsLeaseLossPromise = (async () => {
    clearGpsLeaseRenewal();
    singleton.started = false;
    logSafeError('GPS worker lost MongoDB ownership', error);
    try {
      await stopGpsWorker();
    } finally {
      if (!singleton.stopping) scheduleStartupRetry(options);
    }
  })();
  try {
    await singleton.gpsLeaseLossPromise;
  } finally {
    singleton.gpsLeaseLossPromise = null;
  }
}

function scheduleGpsLeaseRenewal(ownership, options) {
  let renewalInProgress = false;
  singleton.gpsLeaseRenewTimer = setInterval(async () => {
    if (renewalInProgress || singleton.gpsOwnership !== ownership) return;
    renewalInProgress = true;
    try {
      if (!(await ownership.renew())) {
        throw new Error('MongoDB GPS ownership renewal was rejected.');
      }
    } catch (error) {
      try {
        await handleGpsOwnershipLoss(ownership, options, error);
      } catch (cleanupError) {
        logSafeError('Stopping GPS worker after lease loss failed', cleanupError);
      }
    } finally {
      renewalInProgress = false;
    }
  }, Math.max(1000, Math.floor(ownership.ttlMs / 3)));
  singleton.gpsLeaseRenewTimer.unref?.();
}

function startGpsLocationPublisher(options) {
  if (singleton.gpsLocationPublisher) return;
  const createPublisher =
    options.createGpsLocationPublisher ||
    require("./gpsLocationPublisher").createGpsLocationPublisher;
  const env = options.env || process.env;
  const mode =
    env.SOCKET_IO_MODE ||
    (env.NODE_ENV === "production" ? "redis" : "single-instance");
  if (
    mode === "redis" &&
    typeof options.publishGpsLocationEvent !== "function"
  ) {
    throw new Error(
      "Redis GPS publication requires an awaited Socket.IO publication boundary.",
    );
  }
  singleton.gpsLocationPublisher = createPublisher({
    transportReady: () =>
      mode !== "redis" ||
      options.getSocketClusterStatus?.()?.state === "ready",
    transportGeneration: options.getSocketClusterGeneration || (() => 0),
    publishEvent: options.publishGpsLocationEvent,
  });
  singleton.gpsLocationPublisher.start();
  logStartupEvent("GPS_LOCATION_PUBLISHER_STARTED", { mode });
}

async function performStartup(options = {}) {
  const {
    startGpsWorker = true,
    env = process.env,
  } = options;
  const gpsAllowed =
    startGpsWorker &&
    env.NODE_ENV !== 'test' &&
    env.TEST_ENVIRONMENT !== 'unit' &&
    env.TEST_ENVIRONMENT !== 'local-integration' &&
    !env.NODE_TEST_CONTEXT &&
    !process.env.NODE_TEST_CONTEXT;
  const localIntegrationEnvironment =
    env.TEST_ENVIRONMENT === 'local-integration' ||
    process.env.TEST_ENVIRONMENT === 'local-integration';
  const unitTestEnvironment =
    !localIntegrationEnvironment &&
    (env.NODE_ENV === 'test' ||
      env.TEST_ENVIRONMENT === 'unit' ||
      Boolean(env.NODE_TEST_CONTEXT) ||
      process.env.NODE_ENV === 'test' ||
      process.env.TEST_ENVIRONMENT === 'unit' ||
      Boolean(process.env.NODE_TEST_CONTEXT));
  try {
    if (unitTestEnvironment) {
      singleton.started = true;
      logStartupEvent('BACKGROUND_SERVICES_DISABLED_FOR_UNIT_TESTS');
      return;
    }
    const ok = await waitForDbReady({
      env,
      maxAttempts: 12,
      initialDelayMs: 1000,
      maxDelayMs: 8000,
    });

    if (!ok) {
      logStartupEvent('DB_NOT_READY_AFTER_RETRIES', {
        retryInMs: STARTUP_RETRY_DELAY_MS,
      });
      scheduleStartupRetry(options);
      return;
    }
    if (singleton.stopping) return;

    startGpsLocationPublisher(options);
    if (!singleton.assignmentPropagationStop) {
      const createWorker =
        options.createAssignmentPropagationWorker ||
        require("./assignmentPropagation").createAssignmentPropagationWorker;
      singleton.assignmentPropagationStop = createWorker().start();
      logStartupEvent("ASSIGNMENT_PROPAGATION_WORKER_STARTED");
    }

    if (!gpsAllowed) {
      singleton.started = true;
      logStartupEvent('GPS_WORKER_DISABLED_FOR_ENVIRONMENT');
      return;
    }

    logStartupEvent('MONGODB_CONNECTED_STARTING_GPS_WORKER');

    const hasToken = !!env.GPS_TOKEN;
    const hasEmail = !!env.GPS_EMAIL;
    logStartupEvent('GPS_CREDENTIALS_CONFIGURED', {
      configured: hasToken && hasEmail,
    });
    if (!hasToken || !hasEmail) {
      logStartupEvent('GPS_CREDENTIALS_MISSING');
    }

    let ownership = null;
    try {
      const ownershipService = require('./gpsWorkerOwnership');
      const activateOwnership =
        options.activateGpsWorkerOwnership ||
        ownershipService.activateGpsWorkerOwnership;
      ownership = await activateOwnership({
        ttlMs: ownershipService.getGpsWorkerLeaseTtlMs(env),
      });
      if (!ownership) {
        logStartupEvent('GPS_WORKER_OWNERSHIP_HELD_BY_ANOTHER_INSTANCE', {
          retryInMs: STARTUP_RETRY_DELAY_MS,
        });
        scheduleStartupRetry(options);
        return;
      }
      if (singleton.stopping) {
        await ownership?.release();
        return;
      }
      singleton.gpsSyncWorker = require('../workers/gpsSyncWorker');
      singleton.gpsOwnership = ownership;
      if (ownership) {
        singleton.gpsSyncWorker.setLeaseGuard(ownership, (error) =>
          handleGpsOwnershipLoss(ownership, options, error),
        );
      }
      if (ownership) scheduleGpsLeaseRenewal(ownership, options);
      singleton.gpsWorkerStartEnabled = true;
      singleton.gpsSyncWorker.start();
    } catch (error) {
      if (singleton.gpsSyncWorker) {
        try {
          await stopGpsWorker();
        } catch (cleanupError) {
          logSafeError('Cleaning up GPS worker after startup failure failed', cleanupError);
        }
      } else if (ownership) {
        try {
          await ownership.release();
        } catch (cleanupError) {
          logSafeError('Releasing GPS worker ownership after startup failure failed', cleanupError);
        }
      }
      singleton.gpsSyncWorker = null;
      singleton.gpsOwnership = null;
      singleton.gpsWorkerStartEnabled = false;
      logSafeError('Starting gpsSyncWorker failed', error);
      scheduleStartupRetry(options);
      return;
    }

    singleton.started = true;
    singleton.gpsWorkerStartCount++;
    logStartupEvent('GPS_WORKER_STARTED');
  } finally {
    singleton.starting = false;
  }
}

async function startDbDependentServices(options = {}) {
  if (singleton.started || singleton.stopping) return;
  if (singleton.starting) return singleton.startupPromise;
  if (singleton.retryTimer) {
    clearTimeout(singleton.retryTimer);
    singleton.retryTimer = null;
  }
  singleton.starting = true;
  const startupPromise = performStartup(options);
  singleton.startupPromise = startupPromise;
  try {
    await startupPromise;
  } catch (error) {
    scheduleStartupRetry(options);
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
  try {
    await singleton.startupPromise;
  } finally {
    let stopError;
    try {
      await stopGpsWorker();
    } catch (error) {
      stopError = error;
    }
    const publisher = singleton.gpsLocationPublisher;
    singleton.gpsLocationPublisher = null;
    if (publisher) {
      try {
        await publisher.stop();
      } catch (error) {
        stopError ||= error;
      }
    }
    const stopAssignmentPropagation = singleton.assignmentPropagationStop;
    singleton.assignmentPropagationStop = null;
    if (stopAssignmentPropagation) {
      try {
        stopAssignmentPropagation();
      } catch (error) {
        stopError ||= error;
      }
    }
    if (stopError) throw stopError;
  }
}

async function stopGpsWorker() {
  const worker = singleton.gpsSyncWorker;
  const ownership = singleton.gpsOwnership;
  clearGpsLeaseRenewal();
  singleton.gpsSyncWorker = null;
  singleton.gpsOwnership = null;
  singleton.gpsWorkerStartEnabled = false;
  let stopError;
  if (worker) {
    try {
      await worker.stop();
    } catch (error) {
      stopError = error;
    }
    if (typeof worker.setLeaseGuard === 'function') {
      try {
        worker.setLeaseGuard(null);
      } catch (error) {
        stopError ||= error;
      }
    }
  }
  if (ownership) {
    try {
      await ownership.release();
    } catch (error) {
      logSafeError('Releasing GPS worker ownership failed', error);
      stopError ||= error;
    }
  }
  if (stopError) throw stopError;
}

function getGpsWorkerStatus() {
  if (!singleton.gpsSyncWorker) return null;
  return {
    ...singleton.gpsSyncWorker.getStatus(),
    leaseHeld: Boolean(singleton.gpsOwnership),
    leaseMode: singleton.gpsOwnership ? 'distributed' : 'single-instance',
    restartCount: Math.max(0, singleton.gpsWorkerStartCount - 1),
  };
}

function getGpsLocationPublisherStatus() {
  return singleton.gpsLocationPublisher?.getStatus?.() || null;
}

module.exports = {
  getGpsLocationPublisherStatus,
  getGpsWorkerStatus,
  startDbDependentServices,
  stopDbDependentServices,
  stopGpsWorker,
};
