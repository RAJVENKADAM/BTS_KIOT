const assert = require("node:assert/strict");
const test = require("node:test");
const { createDatabaseReadinessWaiter } = require("../src/utils/dbReadinessWaiter");

test("concurrent API requests share one database readiness poller", async () => {
  let readyState = 0;
  let stateChecks = 0;
  const waitForDatabase = createDatabaseReadinessWaiter({
    getReadyState() {
      stateChecks += 1;
      return readyState;
    },
    intervalMs: 5,
    maxWaitMs: 100,
  });

  const requests = Array.from({ length: 40 }, () => waitForDatabase());
  setTimeout(() => {
    readyState = 1;
  }, 15);

  assert.deepEqual(await Promise.all(requests), Array(40).fill(true));
  assert.ok(
    stateChecks - requests.length < 10,
    `expected shared polling after initial checks, got ${stateChecks} checks`,
  );
});

test("a timed-out readiness wait releases its shared slot for a later request", async () => {
  let readyState = 0;
  const waitForDatabase = createDatabaseReadinessWaiter({
    getReadyState: () => readyState,
    intervalMs: 2,
    maxWaitMs: 8,
  });

  assert.equal(await waitForDatabase(), false);
  readyState = 1;
  assert.equal(await waitForDatabase(), true);
});
