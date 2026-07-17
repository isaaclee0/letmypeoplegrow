const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const { getPlanningCenterSyncStats } = require('./integrations');

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
