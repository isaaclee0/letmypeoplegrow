// Fully dependency-injected — no real database or network access. Every
// collaborator runChurch/runAllChurches can use is faked here. As of
// Task 15, per-batch execution is a single injected `runUnattended` call
// (defaulting to orchestrator.runUnattended in production) that owns its
// own audit-trail (startRun/finishRun/failRun) and review notification
// internally — this file only tests what scheduler.js itself still owns:
// due-batch selection, the authority/connection gates, forcing a full
// snapshot on the configured full-reconciliation day, per-batch isolation
// on failure, and persisting each batch's own last-sync bookkeeping via
// recordBatchResult. The one real piece of infrastructure exercised is
// Database.setChurchContext itself (a plain AsyncLocalStorage wrapper —
// see config/database.js), used to verify background work actually runs
// inside a church context.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
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
    lastExternalWatermark: null,
    ...overrides,
  };
}

function baseOptions(overrides = {}) {
  return {
    now: MONDAY,
    getAuthority: async () => ({ active: 'planning_center', pending: null }),
    getConnection: async () => ({ connectionStatus: 'connected' }),
    getUnattendedProviderEnabled: async () => true,
    getFullReconciliationSchedule: async () => ({ frequency: 'weekly', day: 1 }),
    recordBatchResult: async () => {},
    ...overrides,
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

  await runChurch('church-a', baseOptions({
    listBatches: async () => batches,
    runUnattended: async ({ batchId }) => { executed.push(batchId); return { status: 'applied', fetchMode: 'full', complete: true, externalWatermark: null }; },
  }));

  assert.deepEqual(executed, [4]);
});

test('a batch for the active authority provider runs unattended', async () => {
  const executed = [];
  await runChurch('church-a', baseOptions({
    providers: ['planning_center'],
    listBatches: async (churchId, provider) => [baseBatch({ id: 10, provider })],
    runUnattended: async ({ batchId }) => { executed.push(batchId); return { status: 'applied', fetchMode: 'full', complete: true, externalWatermark: null }; },
  }));
  assert.deepEqual(executed, [10]);
});

test('Planning Center master switch off skips unattended dispatch before any batch run', async () => {
  const executed = [];
  await runChurch('church-a', baseOptions({
    providers: ['planning_center'],
    getUnattendedProviderEnabled: async (_churchId, provider) => provider !== 'planning_center',
    listBatches: async () => [baseBatch({ id: 101 })],
    runUnattended: async ({ batchId }) => { executed.push(batchId); return { status: 'applied', fetchMode: 'full', complete: true, externalWatermark: null }; },
  }));
  assert.deepEqual(executed, []);
});

test('Planning Center master switch on permits the existing authority and schedule gates to dispatch', async () => {
  const executed = [];
  await runChurch('church-a', baseOptions({
    providers: ['planning_center'],
    getUnattendedProviderEnabled: async () => true,
    listBatches: async () => [baseBatch({ id: 102 })],
    runUnattended: async ({ batchId }) => { executed.push(batchId); return { status: 'applied', fetchMode: 'full', complete: true, externalWatermark: null }; },
  }));
  assert.deepEqual(executed, [102]);
});

test('Planning Center master switch policy does not disable Elvanto scheduling', async () => {
  const executed = [];
  await runChurch('church-a', baseOptions({
    providers: ['elvanto'], getAuthority: async () => ({ active: 'elvanto', pending: null }),
    getUnattendedProviderEnabled: async (_churchId, provider) => provider !== 'planning_center',
    listBatches: async () => [baseBatch({ id: 103, provider: 'elvanto' })],
    runUnattended: async ({ batchId }) => { executed.push(batchId); return { status: 'applied', fetchMode: 'full', complete: true, externalWatermark: null }; },
  }));
  assert.deepEqual(executed, [103]);
});

test('real church setting turns Planning Center scheduler dispatch off and on while Elvanto remains unaffected', async () => {
  await withTestChurchDb(async (churchId) => {
    const executed = [];
    const options = {
      now: MONDAY, providers: ['planning_center'],
      getAuthority: async () => ({ active: 'planning_center', pending: null }),
      listBatches: async (_churchId, provider) => [baseBatch({ id: 104, provider })],
      getConnection: async () => ({ connectionStatus: 'connected' }),
      getFullReconciliationSchedule: async () => ({ frequency: 'weekly', day: 1 }),
      runUnattended: async ({ batchId }) => { executed.push(batchId); return { status: 'applied', fetchMode: 'full', complete: true, externalWatermark: null }; },
      recordBatchResult: async () => {},
    };
    await Database.query('UPDATE church_settings SET planning_center_sync_enabled = 0 WHERE church_id = ?', [churchId]);
    await runChurch(churchId, options);
    assert.deepEqual(executed, []);
    await Database.query('UPDATE church_settings SET planning_center_sync_enabled = 1 WHERE church_id = ?', [churchId]);
    await runChurch(churchId, options);
    assert.deepEqual(executed, [104]);

    await runChurch(churchId, { ...options, providers: ['elvanto'], getAuthority: async () => ({ active: 'elvanto', pending: null }),
      listBatches: async () => [baseBatch({ id: 105, provider: 'elvanto' })] });
    assert.deepEqual(executed, [104, 105]);
  });
});

test('non-authoritative scheduled batches are skipped entirely (no execution)', async () => {
  const executed = [];
  await runChurch('church-a', baseOptions({
    providers: ['planning_center'],
    getAuthority: async () => ({ active: 'elvanto', pending: null }), // a DIFFERENT provider is authoritative
    listBatches: async (churchId, provider) => [baseBatch({ id: 11, provider })],
    runUnattended: async ({ batchId }) => { executed.push(batchId); return { status: 'applied', fetchMode: 'full', complete: true, externalWatermark: null }; },
  }));
  assert.deepEqual(executed, [], 'a batch for a non-authoritative provider must never execute unattended');
});

test('with no authority chosen ("none"), no provider may run unattended', async () => {
  const executed = [];
  await runChurch('church-a', baseOptions({
    providers: ['planning_center'],
    getAuthority: async () => ({ active: 'none', pending: null }),
    listBatches: async (churchId, provider) => [baseBatch({ id: 12, provider })],
    runUnattended: async ({ batchId }) => { executed.push(batchId); return { status: 'applied', fetchMode: 'full', complete: true, externalWatermark: null }; },
  }));
  assert.deepEqual(executed, []);
});

test('a connection already marked invalid is skipped without attempting a run', async () => {
  const executed = [];
  await runChurch('church-a', baseOptions({
    providers: ['planning_center'],
    listBatches: async (churchId, provider) => [baseBatch({ id: 13, provider })],
    getConnection: async () => ({ connectionStatus: 'invalid' }),
    runUnattended: async ({ batchId }) => { executed.push(batchId); return { status: 'applied', fetchMode: 'full', complete: true, externalWatermark: null }; },
  }));
  assert.deepEqual(executed, []);
});

test('an absent connection (never migrated/connected yet) does not block dispatch', async () => {
  // Guards against a regression where "no connection row yet" is treated as
  // "not connected" and permanently blocks scheduling — orchestrator's own
  // connection load is the real gate for that case now.
  const executed = [];
  await runChurch('church-a', baseOptions({
    providers: ['planning_center'],
    listBatches: async (churchId, provider) => [baseBatch({ id: 14, provider })],
    getConnection: async () => null,
    runUnattended: async ({ batchId }) => { executed.push(batchId); return { status: 'applied', fetchMode: 'full', complete: true, externalWatermark: null }; },
  }));
  assert.deepEqual(executed, [14]);
});

test('a batch that throws is not recorded, and does not stop the next batch', async () => {
  const executedIds = [];
  const recorded = [];
  await runChurch('church-a', baseOptions({
    listBatches: async () => [baseBatch({ id: 30 }), baseBatch({ id: 31 })],
    runUnattended: async ({ batchId }) => {
      executedIds.push(batchId);
      if (batchId === 30) throw new Error('simulated failure');
      return { status: 'applied', fetchMode: 'full', complete: true, externalWatermark: 'wm-31' };
    },
    recordBatchResult: async (input) => { recorded.push(input); },
  }));
  assert.deepEqual(executedIds, [30, 31], 'batch 31 must still run after batch 30 throws');
  assert.deepEqual(recorded.map((r) => r.batchId), [31], 'a thrown batch must never be recorded as a result');
});

test('a null result (no summary produced) is not recorded', async () => {
  const recorded = [];
  await runChurch('church-a', baseOptions({
    listBatches: async () => [baseBatch({ id: 40 })],
    runUnattended: async () => null,
    recordBatchResult: async (input) => { recorded.push(input); },
  }));
  assert.deepEqual(recorded, []);
});

test('a successful run records the batch result with trigger "scheduled" and the returned fetch mode/watermark/status', async () => {
  const recorded = [];
  await runChurch('church-a', baseOptions({
    listBatches: async () => [baseBatch({ id: 50 })],
    runUnattended: async () => ({ status: 'review_required', fetchMode: 'incremental', complete: true, externalWatermark: 'wm-50' }),
    recordBatchResult: async (input) => { recorded.push(input); },
  }));
  assert.deepEqual(recorded, [{
    churchId: 'church-a', provider: 'planning_center', batchId: 50, trigger: 'scheduled',
    fetchMode: 'incremental', complete: true, status: 'review_required', externalWatermark: 'wm-50',
  }]);
});

test('forceFull is true on the configured full-reconciliation day and threaded into runUnattended', async () => {
  const seen = [];
  await runChurch('church-a', baseOptions({
    listBatches: async () => [baseBatch({ id: 60 })],
    getFullReconciliationSchedule: async () => ({ frequency: 'weekly', day: 1 }), // MONDAY matches scheduleDay 1
    runUnattended: async ({ forceFull }) => { seen.push(forceFull); return { status: 'applied', fetchMode: 'full', complete: true, externalWatermark: null }; },
  }));
  assert.deepEqual(seen, [true]);
});

test('forceFull is false on a day that does not match the full-reconciliation schedule', async () => {
  const seen = [];
  await runChurch('church-a', baseOptions({
    listBatches: async () => [baseBatch({ id: 61 })],
    getFullReconciliationSchedule: async () => ({ frequency: 'weekly', day: 3 }), // Wednesday, not MONDAY
    runUnattended: async ({ forceFull }) => { seen.push(forceFull); return { status: 'applied', fetchMode: 'full', complete: true, externalWatermark: null }; },
  }));
  assert.deepEqual(seen, [false]);
});

test('skipScheduleCheck forces forceFull true regardless of the reconciliation schedule', async () => {
  const seen = [];
  await runChurch('church-a', baseOptions({
    skipScheduleCheck: true,
    listBatches: async () => [baseBatch({ id: 62, scheduleDay: 3 })], // not due on MONDAY, but skipScheduleCheck bypasses it
    getFullReconciliationSchedule: async () => ({ frequency: 'weekly', day: 3 }),
    runUnattended: async ({ forceFull }) => { seen.push(forceFull); return { status: 'applied', fetchMode: 'full', complete: true, externalWatermark: null }; },
  }));
  assert.deepEqual(seen, [true]);
});

test('a failure loading the full-reconciliation schedule falls back to weekly/day-1 rather than aborting the church', async () => {
  const executed = [];
  await runChurch('church-a', baseOptions({
    listBatches: async () => [baseBatch({ id: 70 })],
    getFullReconciliationSchedule: async () => { throw new Error('boom'); },
    runUnattended: async ({ batchId }) => { executed.push(batchId); return { status: 'applied', fetchMode: 'full', complete: true, externalWatermark: null }; },
  }));
  assert.deepEqual(executed, [70]);
});

test('multiple due batches are each executed independently', async () => {
  const executed = [];
  await runChurch('church-a', baseOptions({
    listBatches: async () => [baseBatch({ id: 80 }), baseBatch({ id: 81 })],
    runUnattended: async ({ batchId }) => { executed.push(batchId); return { status: 'applied', fetchMode: 'full', complete: true, externalWatermark: null }; },
  }));
  assert.deepEqual(executed, [80, 81]);
});

test('one church failing does not stop another church from running', async () => {
  const ran = [];
  await runAllChurches({
    listChurches: async () => [{ church_id: 'church-a' }, { church_id: 'church-b' }],
    runChurch: async (churchId) => {
      ran.push(churchId);
      if (churchId === 'church-a') throw new Error('church A blew up');
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
  let ran = false;
  await runChurch('church-xyz', baseOptions({
    getAuthority: async () => {
      observedChurchId = Database.getCurrentChurchId();
      return { active: 'planning_center', pending: null };
    },
    listBatches: async (churchId, provider) => [baseBatch({ id: 90, provider })],
    runUnattended: async () => {
      ran = true;
      assert.equal(Database.getCurrentChurchId(), 'church-xyz');
      return { status: 'applied', fetchMode: 'full', complete: true, externalWatermark: null };
    },
  }));
  assert.equal(observedChurchId, 'church-xyz');
  assert.equal(ran, true, 'runUnattended must actually have run for this assertion to mean anything');
  // Context must not leak past the call.
  assert.equal(Database.getCurrentChurchId(), undefined);
});

test('runChurch options with skipScheduleCheck run due-or-not batches (manual "run now")', async () => {
  const executed = [];
  await runChurch('church-a', baseOptions({
    skipScheduleCheck: true,
    listBatches: async () => [baseBatch({ id: 100, scheduleDay: 3 })], // not due on MONDAY, but skipScheduleCheck bypasses it
    runUnattended: async ({ batchId }) => { executed.push(batchId); return { status: 'applied', fetchMode: 'full', complete: true, externalWatermark: null }; },
  }));
  assert.deepEqual(executed, [100]);
});
