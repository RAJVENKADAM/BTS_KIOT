const ACCOUNT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ACCOUNT_ATTEMPTS = 10;
const MAX_TRACKED_ACCOUNTS = 50000;

const MAX_AUTH_OPERATIONS = 8;
const MAX_QUEUED_AUTH_OPERATIONS = 16;
const MAX_PASSWORD_CHECKS = 4;
const MAX_QUEUED_PASSWORD_CHECKS = 64;
const {
  MAX_CONCURRENT_IMPORT_PASSWORD_HASHES,
  MAX_QUEUED_IMPORT_PASSWORD_HASHES,
} = require("./userImportLimits");

const loginAttempts = new Map();
let nextReservationId = 0;
let activeAuthOperations = 0;
let activePasswordChecks = 0;
let activeImportPasswordHashes = 0;
const authOperationQueue = [];
const passwordCheckQueue = [];
const importPasswordHashQueue = [];

const createBusyError = () => {
  const error = new Error('Authentication service is busy');
  error.status = 503;
  error.code = 'AUTH_BUSY';
  error.retryAfter = 2;
  return error;
};

const pruneAttempts = (email, now) => {
  const attempts = loginAttempts.get(email);
  if (!attempts) return [];

  const activeAttempts = attempts.filter(
    (attempt) => now - attempt.createdAt < ACCOUNT_WINDOW_MS,
  );
  if (activeAttempts.length) {
    loginAttempts.set(email, activeAttempts);
  } else {
    loginAttempts.delete(email);
  }
  return activeAttempts;
};

const reserveLoginAttempt = (email, now = Date.now()) => {
  const attempts = pruneAttempts(email, now);
  if (attempts.length >= MAX_ACCOUNT_ATTEMPTS) {
    return {
      allowed: false,
      retryAfter: Math.max(
        1,
        Math.ceil((ACCOUNT_WINDOW_MS - (now - attempts[0].createdAt)) / 1000),
      ),
    };
  }

  if (!loginAttempts.has(email) && loginAttempts.size >= MAX_TRACKED_ACCOUNTS) {
    for (const [trackedEmail] of loginAttempts) {
      pruneAttempts(trackedEmail, now);
      if (loginAttempts.size < MAX_TRACKED_ACCOUNTS) break;
    }
    if (loginAttempts.size >= MAX_TRACKED_ACCOUNTS) {
      loginAttempts.delete(loginAttempts.keys().next().value);
    }
  }

  const reservationId = ++nextReservationId;
  const updatedAttempts = [...attempts, { id: reservationId, createdAt: now }];
  loginAttempts.set(email, updatedAttempts);
  return { allowed: true, reservationId };
};

const releaseLoginAttempt = (email, reservationId) => {
  const attempts = loginAttempts.get(email);
  if (!attempts) return;
  const remaining = attempts.filter((attempt) => attempt.id !== reservationId);
  if (remaining.length) loginAttempts.set(email, remaining);
  else loginAttempts.delete(email);
};

const clearLoginAttempts = (email) => {
  loginAttempts.delete(email);
};

const runWithLimit = (task, state) =>
  new Promise((resolve, reject) => {
    const execute = () => {
      state.increment();
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          state.decrement();
          const next = state.queue.shift();
          if (next) next();
        });
    };

    if (state.active < state.maxActive) {
      execute();
    } else if (state.queue.length < state.maxQueued) {
      state.queue.push(execute);
    } else {
      reject(createBusyError());
    }
  });

const runLimitedAuthOperation = (task) =>
  runWithLimit(task, {
    get active() {
      return activeAuthOperations;
    },
    increment: () => {
      activeAuthOperations += 1;
    },
    decrement: () => {
      activeAuthOperations -= 1;
    },
    queue: authOperationQueue,
    maxActive: MAX_AUTH_OPERATIONS,
    maxQueued: MAX_QUEUED_AUTH_OPERATIONS,
  });

const runLimitedPasswordCheck = (task) =>
  runWithLimit(task, {
    get active() {
      return activePasswordChecks;
    },
    increment: () => {
      activePasswordChecks += 1;
    },
    decrement: () => {
      activePasswordChecks -= 1;
    },
    queue: passwordCheckQueue,
    maxActive: MAX_PASSWORD_CHECKS,
    maxQueued: MAX_QUEUED_PASSWORD_CHECKS,
  });

const runLimitedImportPasswordHash = (task) =>
  runWithLimit(task, {
    get active() {
      return activeImportPasswordHashes;
    },
    increment: () => {
      activeImportPasswordHashes += 1;
    },
    decrement: () => {
      activeImportPasswordHashes -= 1;
    },
    queue: importPasswordHashQueue,
    maxActive: MAX_CONCURRENT_IMPORT_PASSWORD_HASHES,
    maxQueued: MAX_QUEUED_IMPORT_PASSWORD_HASHES,
  });

module.exports = {
  reserveLoginAttempt,
  releaseLoginAttempt,
  clearLoginAttempts,
  runLimitedAuthOperation,
  runLimitedPasswordCheck,
  runLimitedImportPasswordHash,
};
