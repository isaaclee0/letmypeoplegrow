const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { syncBackgroundCheckStatuses } = require('./backgroundCheckSync');

async function seedIndividual(churchId, { planningCenterId = null } = {}) {
  const res = await Database.query(
    `INSERT INTO individuals (first_name, last_name, church_id, is_active, planning_center_id)
     VALUES ('Test', 'Person', ?, 1, ?)`,
    [churchId, planningCenterId]
  );
  return res.insertId;
}

async function getCleared(individualId) {
  const rows = await Database.query(
    `SELECT pco_background_check_cleared AS cleared FROM individuals WHERE id = ?`,
    [individualId]
  );
  return rows[0].cleared;
}

test('syncBackgroundCheckStatuses: writes 1 for a linked person with passedBackgroundCheck true', async () => {
  await withTestChurchDb(async (churchId) => {
    const id = await seedIndividual(churchId, { planningCenterId: 'pco_1' });
    const synced = await syncBackgroundCheckStatuses(churchId, [
      { id: 'pco_1', passedBackgroundCheck: true },
    ]);
    assert.strictEqual(synced, 1);
    assert.strictEqual(await getCleared(id), 1);
  });
});

test('syncBackgroundCheckStatuses: writes 0 for a linked person with passedBackgroundCheck false', async () => {
  await withTestChurchDb(async (churchId) => {
    const id = await seedIndividual(churchId, { planningCenterId: 'pco_2' });
    await syncBackgroundCheckStatuses(churchId, [
      { id: 'pco_2', passedBackgroundCheck: false },
    ]);
    assert.strictEqual(await getCleared(id), 0);
  });
});

test('syncBackgroundCheckStatuses: no-ops for PCO people not linked to any individual', async () => {
  await withTestChurchDb(async (churchId) => {
    const synced = await syncBackgroundCheckStatuses(churchId, [
      { id: 'pco_unlinked', passedBackgroundCheck: true },
    ]);
    assert.strictEqual(synced, 0);
  });
});

test('syncBackgroundCheckStatuses: is scoped per church (church isolation)', async () => {
  await withTestChurchDb(async (churchIdA) => {
    await withTestChurchDb(async (churchIdB) => {
      const idB = await seedIndividual(churchIdB, { planningCenterId: 'pco_shared_id' });
      await syncBackgroundCheckStatuses(churchIdA, [
        { id: 'pco_shared_id', passedBackgroundCheck: true },
      ]);
      // churchB's individual, which happens to share the same PCO id string,
      // must not be touched by a sync run scoped to churchA.
      assert.strictEqual(await getCleared(idB), null);
    });
  });
});

test('syncBackgroundCheckStatuses: skips entries with no passedBackgroundCheck field', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedIndividual(churchId, { planningCenterId: 'pco_3' });
    const synced = await syncBackgroundCheckStatuses(churchId, [{ id: 'pco_3' }]);
    assert.strictEqual(synced, 0);
  });
});
