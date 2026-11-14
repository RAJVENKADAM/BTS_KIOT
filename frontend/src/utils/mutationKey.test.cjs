const assert = require("node:assert/strict");
const { test } = require("node:test");

let getMutationAttempt;
test.before(async () => {
  ({ getMutationAttempt } = await import("./mutationKey.js"));
});

test("retries and duplicate clicks reuse the key for the same payload", () => {
  const ref = { current: { key: null, signature: null } };
  const payload = { busNo: "BUS-1", expectedVersion: 4 };

  const first = getMutationAttempt(ref, payload);
  const retry = getMutationAttempt(ref, payload);

  assert.equal(first, retry);
});

test("a changed mutation payload receives a new key", () => {
  const ref = { current: { key: null, signature: null } };
  const first = getMutationAttempt(ref, { busNo: "BUS-1" });
  const changed = getMutationAttempt(ref, { busNo: "BUS-2" });

  assert.notEqual(first, changed);
});
