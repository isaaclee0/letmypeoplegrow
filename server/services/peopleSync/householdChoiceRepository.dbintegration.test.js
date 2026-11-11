'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { loadLocalProjectionState } = require('./localProjectionState');
const { listHouseholdPreferences, assertHouseholdPreferencesWithConnection, persistHouseholdPreferencesWithConnection } = require('./householdChoiceRepository');

const provider = 'planning_center';
const pref = (individualId, familyId = null, groupId = 'group') => ({ externalPersonId: 'person', individualId, familyId, groupId, sourceFingerprint: 'a'.repeat(64) });
async function seed(churchId) {
  const individual = await Database.queryForChurch(churchId, `INSERT INTO individuals (church_id, first_name, last_name) VALUES (?, 'Ada', 'Reed')`, [churchId]);
  await Database.queryForChurch(churchId, `INSERT INTO external_person_links (church_id, provider, external_person_id, individual_id, link_source) VALUES (?, ?, 'person', ?, 'manual')`, [churchId, provider, individual.insertId]);
  return Number(individual.insertId);
}

test('preference round trip is scoped by church/provider and exposed in projection state', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seed(churchId);
    const otherChurch = `${churchId}_other`;
    Database.getChurchDb(otherChurch);
    const otherId = await seed(otherChurch);
    await Database.transactionForChurch(churchId, (conn) => persistHouseholdPreferencesWithConnection(conn, { churchId, provider, changes: [pref(individualId)] }));
    await Database.transactionForChurch(otherChurch, (conn) => persistHouseholdPreferencesWithConnection(conn, { churchId: otherChurch, provider, changes: [pref(otherId, null, 'other-group')] }));
    assert.deepEqual(await listHouseholdPreferences(churchId, provider), [pref(individualId)]);
    assert.deepEqual(await listHouseholdPreferences(otherChurch, provider), [pref(otherId, null, 'other-group')]);
    assert.deepEqual(await listHouseholdPreferences(churchId, 'elvanto'), []);
    assert.deepEqual((await loadLocalProjectionState(churchId, provider)).householdPreferences, [pref(individualId)]);
    await Database.transactionForChurch(churchId, async (conn) => {
      await assertHouseholdPreferencesWithConnection(conn, { churchId, provider, expectedPreferences: [pref(individualId)] });
      await persistHouseholdPreferencesWithConnection(conn, { churchId, provider, changes: [{ ...pref(individualId), forget: true }] });
    });
    assert.deepEqual(await listHouseholdPreferences(churchId, provider), []);
    assert.equal((await listHouseholdPreferences(otherChurch, provider)).length, 1);
  });
});

test('stale preference expectations and changed person links reject the entire transaction', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seed(churchId);
    await Database.transactionForChurch(churchId, (conn) => persistHouseholdPreferencesWithConnection(conn, { churchId, provider, changes: [pref(individualId)] }));
    await assert.rejects(Database.transactionForChurch(churchId, async (conn) => {
      await conn.query(`UPDATE individuals SET first_name = 'Changed' WHERE id = ? AND church_id = ?`, [individualId, churchId]);
      await assertHouseholdPreferencesWithConnection(conn, { churchId, provider, expectedPreferences: [] });
    }), { code: 'SYNC_PLAN_STALE' });
    assert.equal((await Database.queryForChurch(churchId, `SELECT first_name FROM individuals WHERE id = ? AND church_id = ?`, [individualId, churchId]))[0].first_name, 'Ada');
    await assert.rejects(Database.transactionForChurch(churchId, (conn) => persistHouseholdPreferencesWithConnection(conn, { churchId, provider, changes: [pref(individualId + 100)] })), { code: 'SYNC_PLAN_STALE' });
    assert.deepEqual(await listHouseholdPreferences(churchId, provider), [pref(individualId)]);
    await Database.queryForChurch(churchId, `DELETE FROM external_person_links WHERE church_id = ? AND provider = ?`, [churchId, provider]);
    await Database.transactionForChurch(churchId, (conn) => persistHouseholdPreferencesWithConnection(conn, { churchId, provider, changes: [{ ...pref(individualId), forget: true }] }));
    assert.deepEqual(await listHouseholdPreferences(churchId, provider), [], 'an invalid old link must still be forgettable');
  });
});

test('an existing connection cannot select another church individual or mutate another scoped preference', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seed(churchId);
    const foreignId = await Database.queryForChurch(churchId, `INSERT INTO individuals (church_id, first_name, last_name) VALUES ('foreign-church', 'Foreign', 'Person')`);
    await Database.queryForChurch(churchId, `INSERT INTO external_person_links (church_id, provider, external_person_id, individual_id, link_source) VALUES ('foreign-church', ?, 'person', ?, 'manual')`, [provider, foreignId.insertId]);
    await Database.transactionForChurch(churchId, (conn) => persistHouseholdPreferencesWithConnection(conn, { churchId, provider, changes: [pref(individualId)] }));
    await assert.rejects(Database.transactionForChurch(churchId, (conn) => persistHouseholdPreferencesWithConnection(conn, { churchId, provider, changes: [pref(foreignId.insertId)] })), { code: 'SYNC_PLAN_STALE' });
    assert.deepEqual(await listHouseholdPreferences(churchId, provider), [pref(individualId)]);
  });
});
