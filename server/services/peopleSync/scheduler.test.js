// Fully dependency-injected — no real database or network access. Every
// collaborator runChurch/runAllChurches can use is faked here, matching the
// Task 10 plan's "inject repositories/adapters" instruction. The one real
// piece of infrastructure exercised is Database.setChurchContext itself
// (a plain AsyncLocalStorage wrapper — see config/database.js), used to
// verify background work actually runs inside a church context.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { COUNT_KEYS } = require('./runRepository');
const { isDueToday, runChurch, runAllChurches } = require('./scheduler');

const MONDAY = new Date('2026-07-06T02:00:00'); // matches a weekly schedule with scheduleDay=1

function baseBatch(overrides = {}) {
  return {
    id: 1,
    provider: 'planning_center',
    enabled: true,
    scheduleEnabled: true,
    scheduleFrequency: 'weekly',
    scheduleDay: 1,
    ...overrides,
  };
}

function noopRunRecorder() {
  let nextId = 1;
  return {
    startRun: async () => ({ id: nextId++ }),
    finishRun: async () => {},
    failRun: async () => {},
  };
}

test('isDueToday behaves exactly as the original planningCenterSync implementation', () => {
  assert.equal(isDueToday('daily', 1, MONDAY), true);
  assert.equal(isDueToday('weekly', 1, MONDAY), true);
  assert.equal(isDueToday('weekly', 2, MONDAY), false);
  assert.equal(isDueToday('monthly', 6, new Date('2026-07-06T02:00:00')), true);
});

test('only enabled and due batches are executed', async () => {
  const batches = [
    baseBatch({ id: 1, enabled: false }), // disabled
    baseBatch({ id: 2, scheduleDay: 2 }), // enabled but not due today (Monday=1)
    baseBatch({ id: 3, scheduleEnabled: false }), // enabled batch, scheduling off
    baseBatch({ id: 4 }), // enabled, due
  ];
  const executed = [];

  await runChurch('church-a', {
    now: MONDAY,
    getAuthority: async () => ({ active: 'planning_center', pending: null }),
    listBatches: async () => batches,
    getConnection: async () => ({ connectionStatus: 'connected' }),
    getAccessToken: async () => 'token-a',
    executeBatch: async (churchId, batch) => { executed.push(batch.id); return { added: 1 }; },
    notify: async () => {},
    ...noopRunRecorder(),
  });

  assert.deepEqual(executed, [4]);
});

test('a batch for the active authority provider runs unattended', async () => {
  const executed = [];
  await runChurch('church-a', {
    now: MONDAY,
    providers: ['planning_center'],
    getAuthority: async () => ({ active: 'planning_center', pending: null }),
    listBatches: async (churchId, provider) => [baseBatch({ id: 10, provider })],
    getConnection: async () => ({ connectionStatus: 'connected' }),
    getAccessToken: async () => 'token-a',
    executeBatch: async (churchId, batch) => { executed.push(batch.id); return { added: 2 }; },
    notify: async () => {},
    ...noopRunRecorder(),
  });
  assert.deepEqual(executed, [10]);
});

test('non-authoritative scheduled batches are skipped entirely (no execution)', async () => {
  const executed = [];
  await runChurch('church-a', {
    now: MONDAY,
    providers: ['planning_center'],
    getAuthority: async () => ({ active: 'elvanto', pending: null }), // a DIFFERENT provider is authoritative
    listBatches: async (churchId, provider) => [baseBatch({ id: 11, provider })],
    getConnection: async () => ({ connectionStatus: 'connected' }),
    getAccessToken: async () => 'token-a',
    executeBatch: async (churchId, batch) => { executed.push(batch.id); return { added: 99 }; },
    notify: async () => {},
    ...noopRunRecorder(),
  });
  assert.deepEqual(executed, [], 'a batch for a non-authoritative provider must never execute unattended');
});

test('with no authority chosen ("none"), no provider may run unattended', async () => {
  const executed = [];
  await runChurch('church-a', {
    now: MONDAY,
    providers: ['planning_center'],
    getAuthority: async () => ({ active: 'none', pending: null }),
    listBatches: async (churchId, provider) => [baseBatch({ id: 12, provider })],
    getConnection: async () => ({ connectionStatus: 'connected' }),
    getAccessToken: async () => 'token-a',
    executeBatch: async (churchId, batch) => { executed.push(batch.id); return { added: 1 }; },
    notify: async () => {},
    ...noopRunRecorder(),
  });
  assert.deepEqual(executed, []);
});

test('a connection already marked invalid is skipped without attempting a token fetch', async () => {
  let tokenFetches = 0;
  const executed = [];
  await runChurch('church-a', {
    now: MONDAY,
    providers: ['planning_center'],
    getAuthority: async () => ({ active: 'planning_center', pending: null }),
    listBatches: async (churchId, provider) => [baseBatch({ id: 13, provider })],
    getConnection: async () => ({ connectionStatus: 'invalid' }),
    getAccessToken: async () => { tokenFetches++; return 'token-a'; },
    executeBatch: async (churchId, batch) => { executed.push(batch.id); return { added: 1 }; },
    notify: async () => {},
    ...noopRunRecorder(),
  });
  assert.equal(tokenFetches, 0);
  assert.deepEqual(executed, []);
});

test('an absent connection (never migrated/connected yet) does not block dispatch — getAccessToken decides', async () => {
  // Guards against a regression where "no connection row yet" (the state
  // every legacy PCO church is in until first access triggers migration —
  // see pcoCredentialMigration.js) is treated as "not connected" and
  // permanently blocks scheduling.
  const executed = [];
  await runChurch('church-a', {
    now: MONDAY,
    providers: ['planning_center'],
    getAuthority: async () => ({ active: 'planning_center', pending: null }),
    listBatches: async (churchId, provider) => [baseBatch({ id: 14, provider })],
    getConnection: async () => null,
    getAccessToken: async () => 'token-a',
    executeBatch: async (churchId, batch) => { executed.push(batch.id); return { added: 1 }; },
    notify: async () => {},
    ...noopRunRecorder(),
  });
  assert.deepEqual(executed, [14]);
});

test('a church with no due batches today does not clear or re-fire an existing review notification marker', async () => {
  // Regression: notify() must not run at all when nothing was actually
  // dispatched this cycle. If it ran unconditionally with all-zero totals,
  // reviewNotificationDecision would see zero counts against an existing
  // dedup marker and clear it — so the same still-unresolved items would
  // look "new" again next time this (e.g. weekly) batch is actually due,
  // re-notifying admins who already saw and haven't resolved them.
  let notifyCalls = 0;
  await runChurch('church-a', {
    now: MONDAY,
    providers: ['planning_center'],
    getAuthority: async () => ({ active: 'planning_center', pending: null }),
    listBatches: async () => [baseBatch({ id: 50, scheduleDay: 3 })], // not due today
    getConnection: async () => ({ connectionStatus: 'connected' }),
    getAccessToken: async () => { throw new Error('must not be called when nothing is due'); },
    executeBatch: async () => { throw new Error('must not be called when nothing is due'); },
    notify: async () => { notifyCalls++; },
    ...noopRunRecorder(),
  });
  assert.equal(notifyCalls, 0);
});

test('a church whose only due batch is skipped for authority reasons does not clear or re-fire an existing marker', async () => {
  let notifyCalls = 0;
  await runChurch('church-a', {
    now: MONDAY,
    providers: ['planning_center'],
    getAuthority: async () => ({ active: 'elvanto', pending: null }), // non-authoritative for this batch's provider
    listBatches: async () => [baseBatch({ id: 51 })], // due today, but authority mismatch
    getConnection: async () => ({ connectionStatus: 'connected' }),
    getAccessToken: async () => { throw new Error('must not be called when authority-skipped'); },
    executeBatch: async () => { throw new Error('must not be called when authority-skipped'); },
    notify: async () => { notifyCalls++; },
    ...noopRunRecorder(),
  });
  assert.equal(notifyCalls, 0);
});

test('an all-failed run (executeBatch throws) does not clear or re-fire an existing review notification marker', async () => {
  // Regression: unlike the "nothing due" case, this batch WAS dispatched
  // (authority matched, connection fine, token obtained) but never produced
  // a summary. notify() must still be skipped — reviewNotificationDecision
  // has nothing failure-specific to report, and running it on an all-zero
  // totals object would clear an existing marker for items that are, as far
  // as anyone knows, still unresolved (the batch never actually re-checked).
  let notifyCalls = 0;
  let failed = null;
  await runChurch('church-a', {
    now: MONDAY,
    providers: ['planning_center'],
    getAuthority: async () => ({ active: 'planning_center', pending: null }),
    listBatches: async () => [baseBatch({ id: 70 })],
    getConnection: async () => ({ connectionStatus: 'connected' }),
    getAccessToken: async () => 'token-a',
    executeBatch: async () => { throw new Error('PCO request failed'); },
    startRun: async () => ({ id: 100 }),
    finishRun: async () => { throw new Error('finishRun should not be called — no summary was produced'); },
    failRun: async (input) => { failed = input; },
    notify: async () => { notifyCalls++; },
  });
  assert.equal(failed.errorCode, 'BATCH_EXECUTION_ERROR');
  assert.equal(notifyCalls, 0, 'notify must not run when every dispatched batch failed');
});

test('an all-failed run (executeBatch returns null) does not clear or re-fire an existing review notification marker', async () => {
  // Reachable in production when getBatch finds no matching legacy row.
  let notifyCalls = 0;
  let failed = null;
  await runChurch('church-a', {
    now: MONDAY,
    providers: ['planning_center'],
    getAuthority: async () => ({ active: 'planning_center', pending: null }),
    listBatches: async () => [baseBatch({ id: 71 })],
    getConnection: async () => ({ connectionStatus: 'connected' }),
    getAccessToken: async () => 'token-a',
    executeBatch: async () => null,
    startRun: async () => ({ id: 101 }),
    finishRun: async () => { throw new Error('finishRun should not be called — no summary was produced'); },
    failRun: async (input) => { failed = input; },
    notify: async () => { notifyCalls++; },
  });
  assert.equal(failed.errorCode, 'BATCH_EXECUTION_FAILED');
  assert.equal(notifyCalls, 0, 'notify must not run when every dispatched batch returned no summary');
});

test('a mix of a failed batch and a successful batch still notifies, using only the successful summary', async () => {
  // The three-way behavior must not regress: at least one REAL summary
  // (even alongside a failure) is enough to run notify and let a genuinely
  // resolved marker clear.
  let notified = null;
  await runChurch('church-a', {
    now: MONDAY,
    providers: ['planning_center'],
    getAuthority: async () => ({ active: 'planning_center', pending: null }),
    listBatches: async () => [baseBatch({ id: 72 }), baseBatch({ id: 73 })],
    getConnection: async () => ({ connectionStatus: 'connected' }),
    getAccessToken: async () => 'token-a',
    executeBatch: async (churchId, batch) => {
      if (batch.id === 72) throw new Error('simulated failure');
      return { added: 1, ambiguous: 0, visitorMatches: 0, familyNameUpdatesPending: 0 };
    },
    startRun: async () => ({ id: 102 }),
    finishRun: async () => {},
    failRun: async () => {},
    notify: async (churchId, totals) => { notified = totals; },
  });
  assert.deepEqual(notified, { ambiguous: 0, visitorMatches: 0, familyNameUpdatesPending: 0 });
});

test('review-required counts produce a sanitized notification summary and a review_required run', async () => {
  let notified = null;
  let finished = null;
  await runChurch('church-a', {
    now: MONDAY,
    providers: ['planning_center'],
    getAuthority: async () => ({ active: 'planning_center', pending: null }),
    listBatches: async (churchId, provider) => [baseBatch({ id: 20, provider })],
    getConnection: async () => ({ connectionStatus: 'connected' }),
    getAccessToken: async () => 'token-a',
    executeBatch: async () => ({
      added: 3, updated: 1, archived: 0, reactivated: 0, linked: 2,
      gatheringAssigned: 1, gatheringRemoved: 0, familyNamesUpdated: 0,
      ambiguous: 2, visitorMatches: 1, familyNameUpdatesPending: 0,
    }),
    startRun: async () => ({ id: 42 }),
    finishRun: async (input) => { finished = input; },
    failRun: async () => { throw new Error('failRun should not be called on success'); },
    notify: async (churchId, totals) => { notified = { churchId, totals }; },
  });

  // The notification summary is exactly the numeric totals — nothing else
  // (no names, no plan data, no tokens) ever reaches the notifier.
  assert.deepEqual(notified, {
    churchId: 'church-a',
    totals: { ambiguous: 2, visitorMatches: 1, familyNameUpdatesPending: 0 },
  });
  assert.deepEqual(Object.keys(notified.totals).sort(), ['ambiguous', 'familyNameUpdatesPending', 'visitorMatches']);
  for (const value of Object.values(notified.totals)) assert.equal(typeof value, 'number');

  // The generic audit run is recorded as review_required, with only
  // allowlisted, sanitized counts.
  assert.equal(finished.status, 'review_required');
  assert.equal(finished.runId, 42);
  for (const key of Object.keys(finished.counts)) {
    assert.ok(COUNT_KEYS.has(key), `count key "${key}" must be one runRepository recognises`);
  }
  assert.equal(finished.counts.ambiguousPeople, 2);
});

test('a fully clean run (no review items) is recorded as applied, and notify sees all-zero totals', async () => {
  let finished = null;
  let notified = null;
  await runChurch('church-a', {
    now: MONDAY,
    providers: ['planning_center'],
    getAuthority: async () => ({ active: 'planning_center', pending: null }),
    listBatches: async (churchId, provider) => [baseBatch({ id: 21, provider })],
    getConnection: async () => ({ connectionStatus: 'connected' }),
    getAccessToken: async () => 'token-a',
    executeBatch: async () => ({ added: 1, ambiguous: 0, visitorMatches: 0, familyNameUpdatesPending: 0 }),
    startRun: async () => ({ id: 7 }),
    finishRun: async (input) => { finished = input; },
    failRun: async () => {},
    notify: async (churchId, totals) => { notified = totals; },
  });
  assert.equal(finished.status, 'applied');
  assert.deepEqual(notified, { ambiguous: 0, visitorMatches: 0, familyNameUpdatesPending: 0 });
});

test('a batch with per-item apply errors (but no ambiguous/visitor/family items) is still recorded as review_required, not applied', async () => {
  let finished = null;
  await runChurch('church-a', {
    now: MONDAY,
    providers: ['planning_center'],
    getAuthority: async () => ({ active: 'planning_center', pending: null }),
    listBatches: async () => [baseBatch({ id: 22 })],
    getConnection: async () => ({ connectionStatus: 'connected' }),
    getAccessToken: async () => 'token-a',
    executeBatch: async () => ({
      added: 1, ambiguous: 0, visitorMatches: 0, familyNameUpdatesPending: 0, errors: 2,
    }),
    startRun: async () => ({ id: 55 }),
    finishRun: async (input) => { finished = input; },
    failRun: async () => {},
    notify: async () => {},
  });
  assert.equal(finished.status, 'review_required');
});

test('a batch that throws is recorded as a failed run and does not stop the next batch', async () => {
  const executedIds = [];
  let failed = null;
  await runChurch('church-a', {
    now: MONDAY,
    providers: ['planning_center'],
    getAuthority: async () => ({ active: 'planning_center', pending: null }),
    listBatches: async () => [baseBatch({ id: 30 }), baseBatch({ id: 31 })],
    getConnection: async () => ({ connectionStatus: 'connected' }),
    getAccessToken: async () => 'token-a',
    executeBatch: async (churchId, batch) => {
      executedIds.push(batch.id);
      if (batch.id === 30) throw new Error('simulated PCO failure');
      return { added: 1 };
    },
    startRun: async () => ({ id: 99 }),
    finishRun: async () => {},
    failRun: async (input) => { failed = input; },
    notify: async () => {},
  });
  assert.deepEqual(executedIds, [30, 31], 'batch 31 must still run after batch 30 throws');
  assert.equal(failed.errorCode, 'BATCH_EXECUTION_ERROR');
  assert.equal(failed.runId, 99);
});

test('one church failing does not stop another church from running', async () => {
  const ran = [];
  await runAllChurches({
    listChurches: async () => [{ church_id: 'church-a' }, { church_id: 'church-b' }],
    runChurch: async (churchId) => {
      ran.push(churchId);
      if (churchId === 'church-a') throw new Error('church A blew up');
      return { ambiguous: 0, visitorMatches: 0, familyNameUpdatesPending: 0 };
    },
  });
  assert.deepEqual(ran, ['church-a', 'church-b']);
});

test('churches run sequentially, in listChurches order', async () => {
  const order = [];
  await runAllChurches({
    listChurches: async () => [{ church_id: 'church-1' }, { church_id: 'church-2' }, { church_id: 'church-3' }],
    runChurch: async (churchId) => {
      // If these ran concurrently instead of sequentially, a slow first call
      // combined with a fast second/third call could reorder this array.
      await new Promise((resolve) => setTimeout(resolve, churchId === 'church-1' ? 15 : 0));
      order.push(churchId);
    },
  });
  assert.deepEqual(order, ['church-1', 'church-2', 'church-3']);
});

test('background work executes inside Database.setChurchContext for the correct church', async () => {
  let observedChurchId = null;
  let notifyCalled = false;
  await runChurch('church-xyz', {
    now: MONDAY,
    providers: ['planning_center'],
    getAuthority: async (churchId) => {
      observedChurchId = Database.getCurrentChurchId();
      return { active: 'planning_center', pending: null };
    },
    // At least one due batch must actually dispatch, otherwise notify() is
    // deliberately never called (see the no-due-batches tests above) and this
    // test's own notify assertion below would silently never run.
    listBatches: async (churchId, provider) => [baseBatch({ id: 60, provider })],
    getConnection: async () => ({ connectionStatus: 'connected' }),
    getAccessToken: async () => 'token',
    executeBatch: async () => ({ added: 0 }),
    notify: async () => {
      notifyCalled = true;
      // Also verify the context is still active by the time notify runs.
      assert.equal(Database.getCurrentChurchId(), 'church-xyz');
    },
    ...noopRunRecorder(),
  });
  assert.equal(observedChurchId, 'church-xyz');
  assert.equal(notifyCalled, true, 'notify must actually have run for this assertion to mean anything');
  // Context must not leak past the call.
  assert.equal(Database.getCurrentChurchId(), undefined);
});

test('runChurch options with skipScheduleCheck run due-or-not batches (manual "run now")', async () => {
  const executed = [];
  await runChurch('church-a', {
    skipScheduleCheck: true,
    getAuthority: async () => ({ active: 'planning_center', pending: null }),
    listBatches: async () => [baseBatch({ id: 40, scheduleDay: 3 })], // not due on MONDAY, but skipScheduleCheck bypasses it
    getConnection: async () => ({ connectionStatus: 'connected' }),
    getAccessToken: async () => 'token-a',
    executeBatch: async (churchId, batch) => { executed.push(batch.id); return { added: 1 }; },
    notify: async () => {},
    ...noopRunRecorder(),
  });
  assert.deepEqual(executed, [40]);
});
