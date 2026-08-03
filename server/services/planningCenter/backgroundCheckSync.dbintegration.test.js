const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { applyBackgroundCheckSnapshot } = require('./backgroundCheckSync');

async function seedIndividual(churchId, {
  planningCenterId = null, isActive = true, cleared = null,
} = {}) {
  const result = await Database.query(
    `INSERT INTO individuals
       (first_name, last_name, church_id, is_active, planning_center_id, pco_background_check_cleared)
     VALUES ('Test', 'Person', ?, ?, ?, ?)`,
    [churchId, isActive ? 1 : 0, planningCenterId, cleared]
  );
  return result.insertId;
}

async function getCleared(individualId) {
  const rows = await Database.query(
    `SELECT pco_background_check_cleared AS cleared FROM individuals WHERE id = ?`,
    [individualId]
  );
  return rows[0].cleared;
}

const snapshot = (people) => ({
  fetchedAt: '2026-08-03T05:00:00.000Z',
  complete: true,
  people,
});

test('applies true, false, and unknown to active and archived PCO-ID-only people', async () => {
  await withTestChurchDb(async (churchId) => {
    const clearedId = await seedIndividual(churchId, { planningCenterId: 'pco-1' });
    const failedId = await seedIndividual(churchId, { planningCenterId: 'pco-2', isActive: false });
    const unknownId = await seedIndividual(churchId, { planningCenterId: 'pco-3', cleared: 1 });

    const result = await applyBackgroundCheckSnapshot(churchId, snapshot([
      { id: 'pco-1', passedBackgroundCheck: true },
      { id: 'pco-2', passedBackgroundCheck: false },
      { id: 'pco-3', passedBackgroundCheck: null },
    ]));
    assert.deepEqual(result, {
      fetchedAt: '2026-08-03T05:00:00.000Z',
      updated: 3, cleared: 1, notCleared: 1, unknown: 1,
    });
    assert.equal(await getCleared(clearedId), 1);
    assert.equal(await getCleared(failedId), 0);
    assert.equal(await getCleared(unknownId), null);
  });
});

test('clears a stale green status when a local PCO ID is absent from a complete snapshot', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId, {
      planningCenterId: 'missing-from-pco', cleared: 1,
    });
    await applyBackgroundCheckSnapshot(churchId, snapshot([]));
    assert.equal(await getCleared(individualId), null);
  });
});

test('does not require an external_person_links row', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId, {
      planningCenterId: 'checkin-imported', isActive: false,
    });
    const links = await Database.query(
      `SELECT COUNT(*) AS count FROM external_person_links
        WHERE church_id = ? AND provider = 'planning_center'`,
      [churchId]
    );
    assert.equal(links[0].count, 0);
    await applyBackgroundCheckSnapshot(churchId, snapshot([
      { id: 'checkin-imported', passedBackgroundCheck: true },
    ]));
    assert.equal(await getCleared(individualId), 1);
  });
});

test('complete snapshot apply is scoped to one church', async () => {
  await withTestChurchDb(async (churchIdA) => {
    await withTestChurchDb(async (churchIdB) => {
      const idB = await seedIndividual(churchIdB, {
        planningCenterId: 'shared-provider-id', cleared: 0,
      });
      await applyBackgroundCheckSnapshot(churchIdA, snapshot([
        { id: 'shared-provider-id', passedBackgroundCheck: true },
      ]));
      assert.equal(await getCleared(idB), 0);
    });
  });
});

test('rejects a partial snapshot before changing local status', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId, {
      planningCenterId: 'pco-1', cleared: 1,
    });
    await assert.rejects(
      applyBackgroundCheckSnapshot(churchId, { complete: false, people: [] }),
      /complete Planning Center background-check snapshot/
    );
    assert.equal(await getCleared(individualId), 1);
  });
});
