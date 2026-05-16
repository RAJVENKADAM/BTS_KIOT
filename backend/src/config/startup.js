const { testConnection } = require('./db');

// Render-compatible: stateless server that may start before DB is ready.
// We block service initialization until DB is reachable (with retry/backoff)
// and we never crash the process due to transient DB failures.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const ok = await testConnection();
    if (ok) return true;

    // Exponential backoff with cap
    await sleep(delayMs);
    delayMs = Math.min(maxDelayMs, delayMs * 2);
  }

  return false;
}

module.exports = {
  waitForDbReady,
};

