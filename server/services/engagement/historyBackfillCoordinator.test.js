'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { backfillPendingChurches } = require('./historyBackfillCoordinator');

test('backfillPendingChurches runs approved churches sequentially and contains failures', async () => {
  const calls = [];
  let releaseFirst;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  const operation = backfillPendingChurches({
    churches: [
      { church_id: 'a', is_approved: 1 },
      { church_id: 'ignored', is_approved: 0 },
      { church_id: 'b', is_approved: 1 },
      { church_id: 'c', is_approved: 1 },
    ],
    __deps: {
      backfillEngagementHistory: async (churchId) => {
        calls.push(churchId);
        if (churchId === 'a') await firstPending;
        if (churchId === 'b') throw new Error('broken');
        return { status: 'completed', rulesVersion: 1, weeksEvaluated: 2, transitionsReconstructed: 1 };
      },
      log: { info() {}, warn() {} },
    },
  });

  await Promise.resolve();
  assert.deepEqual(calls, ['a']);
  releaseFirst();
  const results = await operation;

  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.deepEqual(results.map(({ churchId, status }) => ({ churchId, status })), [
    { churchId: 'a', status: 'completed' },
    { churchId: 'b', status: 'failed' },
    { churchId: 'c', status: 'completed' },
  ]);
});
