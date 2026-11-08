const {
  MAX_CONCURRENT_IMPORT_PASSWORD_HASHES,
  MAX_QUEUED_IMPORT_PASSWORD_HASHES,
} = require("./userImportLimits");

const createBusyError = () => {
  const error = new Error("Authentication service is busy");
  error.status = 503;
  error.code = "AUTH_BUSY";
  error.retryAfter = 2;
  return error;
};

function readIntegerEnv(name, fallback, { min = 1, max = 1000 } = {}) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function createWorkLimiter({ maxActive, maxQueued, maxWaitMs = 5000 }) {
  if (!Number.isSafeInteger(maxActive) || maxActive < 1) {
    throw new TypeError("maxActive must be a positive integer");
  }
  if (!Number.isSafeInteger(maxQueued) || maxQueued < 0) {
    throw new TypeError("maxQueued must be a non-negative integer");
  }
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0) {
    throw new TypeError("maxWaitMs must be a non-negative integer");
  }

  let active = 0;
  const queue = [];

  const start = (entry) => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.started = true;
    active += 1;
    Promise.resolve()
      .then(entry.task)
      .then(
        (value) => {
          active -= 1;
          drain();
          entry.resolve(value);
        },
        (error) => {
          active -= 1;
          drain();
          entry.reject(error);
        },
      );
  };

  const drain = () => {
    while (active < maxActive && queue.length > 0) {
      const entry = queue.shift();
      if (!entry.settled) start(entry);
    }
  };

  const run = (task) =>
    new Promise((resolve, reject) => {
      if (typeof task !== "function") {
        reject(new TypeError("Limited work must be a function"));
        return;
      }

      const entry = {
        task,
        resolve,
        reject,
        timer: null,
        started: false,
        settled: false,
      };

      if (active < maxActive) {
        start(entry);
        return;
      }
      if (queue.length >= maxQueued) {
        reject(createBusyError());
        return;
      }

      queue.push(entry);
      if (maxWaitMs === 0) {
        entry.settled = true;
        queue.splice(queue.indexOf(entry), 1);
        reject(createBusyError());
        return;
      }
      entry.timer = setTimeout(() => {
        if (entry.started || entry.settled) return;
        entry.settled = true;
        const index = queue.indexOf(entry);
        if (index !== -1) queue.splice(index, 1);
        reject(createBusyError());
      }, maxWaitMs);
    });

  return {
    run,
    getStatus: () => ({ active, queued: queue.length }),
  };
}

const authOperationLimiter = createWorkLimiter({
  maxActive: readIntegerEnv("AUTH_MAX_CONCURRENT_OPERATIONS", 8, {
    max: 64,
  }),
  maxQueued: readIntegerEnv("AUTH_MAX_QUEUED_OPERATIONS", 64, {
    min: 0,
    max: 512,
  }),
  maxWaitMs: readIntegerEnv("AUTH_QUEUE_WAIT_MS", 30000, {
    min: 1,
    max: 120000,
  }),
});

const passwordCheckLimiter = createWorkLimiter({
  maxActive: readIntegerEnv("AUTH_MAX_CONCURRENT_PASSWORD_CHECKS", 4, {
    max: 64,
  }),
  maxQueued: readIntegerEnv("AUTH_MAX_QUEUED_PASSWORD_CHECKS", 64, {
    min: 0,
    max: 512,
  }),
  maxWaitMs: readIntegerEnv(
    "AUTH_PASSWORD_QUEUE_WAIT_MS",
    readIntegerEnv("AUTH_QUEUE_WAIT_MS", 60000, {
      min: 1,
      max: 120000,
    }),
    { min: 1, max: 120000 },
  ),
});

const importPasswordHashLimiter = createWorkLimiter({
  maxActive: MAX_CONCURRENT_IMPORT_PASSWORD_HASHES,
  maxQueued: MAX_QUEUED_IMPORT_PASSWORD_HASHES,
  maxWaitMs: 30000,
});

const runLimitedAuthOperation = (task) => authOperationLimiter.run(task);
const runLimitedPasswordCheck = (task) => passwordCheckLimiter.run(task);
const runLimitedImportPasswordHash = (task) =>
  importPasswordHashLimiter.run(task);

module.exports = {
  createWorkLimiter,
  readIntegerEnv,
  runLimitedAuthOperation,
  runLimitedPasswordCheck,
  runLimitedImportPasswordHash,
};
