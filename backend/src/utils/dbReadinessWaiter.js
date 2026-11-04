function createDatabaseReadinessWaiter({
  getReadyState,
  intervalMs = 250,
  maxWaitMs = 10_000,
}) {
  let pendingWait = null;

  return function waitForDatabase(timeoutMs = maxWaitMs) {
    if (getReadyState() === 1) return Promise.resolve(true);
    if (pendingWait) return pendingWait;

    const deadline = Date.now() + timeoutMs;
    pendingWait = new Promise((resolve) => {
      let timer;
      const finish = (ready) => {
        if (timer) clearTimeout(timer);
        pendingWait = null;
        resolve(ready);
      };
      const check = () => {
        if (getReadyState() === 1) {
          finish(true);
          return;
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          finish(false);
          return;
        }
        timer = setTimeout(check, Math.min(intervalMs, remainingMs));
      };

      timer = setTimeout(check, Math.min(intervalMs, Math.max(timeoutMs, 0)));
    });

    return pendingWait;
  };
}

module.exports = { createDatabaseReadinessWaiter };
