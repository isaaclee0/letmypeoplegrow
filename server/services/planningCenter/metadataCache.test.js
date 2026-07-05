const { test } = require('node:test');
const assert = require('node:assert');
const { isStale, STALE_MS } = require('./metadataCache');

test('isStale: missing fetchedAt is always stale', () => {
  assert.strictEqual(isStale(null), true);
  assert.strictEqual(isStale(undefined), true);
});

test('isStale: false when age is under the threshold', () => {
  const now = 1000000;
  assert.strictEqual(isStale(now - (STALE_MS - 1), now), false);
});

test('isStale: true when age is over the threshold', () => {
  const now = 1000000;
  assert.strictEqual(isStale(now - (STALE_MS + 1), now), true);
});

test('isStale: exactly at the threshold is not yet stale', () => {
  const now = 1000000;
  assert.strictEqual(isStale(now - STALE_MS, now), false);
});
