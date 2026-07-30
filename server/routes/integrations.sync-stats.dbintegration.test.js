const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const { getPlanningCenterSyncStats, validateBatchBody, resolveGatheringAutoRemoveEnabled } = require('./integrations');

async function seedIndividual(churchId, { active = 1, pcoId = null } = {}) {
  const res = await Database.query(
    `INSERT INTO individuals (first_name, last_name, church_id, is_active, planning_center_id)
     VALUES ('Test', 'Person', ?, ?, ?)`,
    [churchId, active, pcoId]
  );
  return res.insertId;
}

test('getPlanningCenterSyncStats counts active individuals and how many are linked to PCO', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedIndividual(churchId, { active: 1, pcoId: 'pco_1' });
    await seedIndividual(churchId, { active: 1, pcoId: 'pco_2' });
    await seedIndividual(churchId, { active: 1, pcoId: null });
    // Archived — must not count toward either total or synced.
    await seedIndividual(churchId, { active: 0, pcoId: 'pco_archived' });

    const stats = await getPlanningCenterSyncStats(churchId);

    assert.strictEqual(stats.totalPeople, 3);
    assert.strictEqual(stats.syncedPeople, 2);
  });
});

test('getPlanningCenterSyncStats only counts individuals belonging to the given church', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedIndividual(churchId, { active: 1, pcoId: 'pco_1' });

    // A different church's rows can end up in the same physical test DB file
    // (church_id is retained as a plain column even though production keeps
    // one SQLite file per church — see CLAUDE.md). Insert one directly under
    // a different church_id to prove the query filters by church_id rather
    // than counting every row in the table. (Do NOT nest a second
    // withTestChurchDb call here — its own docstring warns that overlapping
    // calls race on shared module state.)
    await Database.query(
      `INSERT INTO individuals (first_name, last_name, church_id, is_active, planning_center_id)
       VALUES ('Other', 'Church1', ?, 1, 'pco_other_1')`,
      [`${churchId}_other`]
    );
    await Database.query(
      `INSERT INTO individuals (first_name, last_name, church_id, is_active, planning_center_id)
       VALUES ('Other', 'Church2', ?, 1, NULL)`,
      [`${churchId}_other`]
    );

    const stats = await getPlanningCenterSyncStats(churchId);
    assert.strictEqual(stats.totalPeople, 1);
    assert.strictEqual(stats.syncedPeople, 1);
  });
});

test('getPlanningCenterSyncStats returns zeros, not an error, for a church with no individuals', async () => {
  await withTestChurchDb(async (churchId) => {
    const stats = await getPlanningCenterSyncStats(churchId);
    assert.strictEqual(stats.totalPeople, 0);
    assert.strictEqual(stats.syncedPeople, 0);
  });
});

// Task 9: PCO batch create/update routes now delegate persistence to
// pcoSync.createBatch/updateBatch (generic people_sync_batches, dual-written
// to the legacy planning_center_sync_batches table), but the request-body
// validation and defaulting in routes/integrations.js are untouched by that
// refactor. These preserve compatibility for gatheringAutoRemoveEnabled:
// it is not required, and an omitted value resolves to `false` rather than
// rejecting the request. The batch name is instead derived from the resolved
// provider-owned source and must not be client writable.
function validBatchBody(overrides = {}) {
  return {
    sourceKind: 'planning_center_list',
    sourceExternalId: 'list-1',
    defaultPeopleType: 'regular',
    gatheringTypeId: null,
    scheduleEnabled: false,
    scheduleFrequency: 'weekly',
    scheduleDay: 1,
    ...overrides,
  };
}

test('validateBatchBody accepts a body that omits gatheringAutoRemoveEnabled entirely', () => {
  const body = validBatchBody();
  assert.strictEqual('gatheringAutoRemoveEnabled' in body, false);
  assert.strictEqual(validateBatchBody(body), null);
});

test('validateBatchBody rejects a client-supplied batch name', () => {
  assert.strictEqual(validateBatchBody(validBatchBody({ name: 'Client override' })), 'Unknown Planning Center batch field.');
});

test('resolveGatheringAutoRemoveEnabled defaults to false when an old client omits the field', () => {
  assert.strictEqual(resolveGatheringAutoRemoveEnabled({}), false);
});

test('resolveGatheringAutoRemoveEnabled passes through explicit booleans', () => {
  assert.strictEqual(resolveGatheringAutoRemoveEnabled({ gatheringAutoRemoveEnabled: true }), true);
  assert.strictEqual(resolveGatheringAutoRemoveEnabled({ gatheringAutoRemoveEnabled: false }), false);
});

test('resolveGatheringAutoRemoveEnabled defaults to false for a non-boolean value', () => {
  assert.strictEqual(resolveGatheringAutoRemoveEnabled({ gatheringAutoRemoveEnabled: 'true' }), false);
});
