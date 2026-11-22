"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createBoundedCache } = require("../src/utils/readCache");

test("bounded cache evicts the least recently used entry", () => {
  const cache = createBoundedCache({ ttlMs: 1_000, maxEntries: 2 });
  cache.set("old", 1);
  cache.set("recent", 2);
  assert.equal(cache.get("old"), 1);
  cache.set("new", 3);

  assert.equal(cache.get("old"), 1);
  assert.equal(cache.get("recent"), undefined);
  assert.equal(cache.get("new"), 3);
});

test("bounded cache expires entries at their TTL", async () => {
  const cache = createBoundedCache({ ttlMs: 5, maxEntries: 1 });
  cache.set("temporary", true);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(cache.get("temporary"), undefined);
});
