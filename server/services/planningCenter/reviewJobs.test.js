'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { createReviewJobs } = require('./reviewJobs');

test('deadline cancels reads and expires even an unresponsive job; a late preview cannot publish a plan', async () => {
  const jobs = createReviewJobs({ timeoutMs: 10, retentionMs: 100 });
  let finish;
  let aborted;
  const cancelled = new Promise(resolve => { aborted = resolve; });
  const id = jobs.start({ churchId: 'church', userId: 1, operation: 'buildReview', input: {},
    run: ({ signal }) => new Promise(resolve => {
      finish = resolve;
      signal.addEventListener('abort', aborted, { once: true });
    }),
  });
  // Keep the event loop alive while production's unref'ed deadline fires.
  const expiry = delay(150);
  await cancelled;
  assert.equal(jobs.get(id, 'church', 1).state, 'timedOut');
  finish({ reviewToken: 'late' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs.get(id, 'church', 1).state, 'timedOut');
  await expiry;
  assert.equal(jobs.get(id, 'church', 1), null);
});

test('a busy church can reconnect to its reviews and another church can still start a review', () => {
  const jobs = createReviewJobs();
  const start = (churchId, batchId) => jobs.start({ churchId, userId: 1, operation: 'buildReview',
    input: { batchId }, run: async () => ({}) });
  const first = start('a', 1);
  for (const id of [2, 3, 4]) assert.ok(start('a', id));
  assert.equal(start('a', 5), null);
  assert.equal(start('a', 1), first);
  assert.ok(start('b', 5));
});
