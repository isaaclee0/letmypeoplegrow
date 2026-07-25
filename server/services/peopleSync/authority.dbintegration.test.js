const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const {
  PEOPLE_SOURCE_LOCKED,
  getAuthority,
  beginAuthoritySwitch,
  commitAuthoritySwitch,
  disableAuthority,
  getManagedLinks,
  isPersonLocked,
  lockedResponse,
} = require('./authority');

async function seedIndividual(churchId, overrides = {}) {
  const result = await Database.query(
    `INSERT INTO individuals (church_id, first_name, last_name, planning_center_id)
     VALUES (?, ?, ?, ?)`,
    [churchId, overrides.firstName || 'Ada', overrides.lastName || 'Lovelace', overrides.planningCenterId || null]
  );
  return Number(result.insertId);
}

async function linkPerson(churchId, individualId, provider, externalPersonId) {
  await Database.query(
    `INSERT INTO external_person_links
       (church_id, provider, external_person_id, individual_id, link_source)
     VALUES (?, ?, ?, ?, 'matched')`,
    [churchId, provider, externalPersonId, individualId]
  );
}

test('authority switch is pending until explicitly committed', async () => {
  await withTestChurchDb(async (churchId) => {
    await beginAuthoritySwitch(churchId, 'elvanto');
    assert.deepEqual(await getAuthority(churchId), { active: 'none', pending: 'elvanto' });
    await commitAuthoritySwitch(churchId, 'elvanto');
    assert.deepEqual(await getAuthority(churchId), { active: 'elvanto', pending: null });
  });
});

test('only the active provider link locks a person', () => {
  const links = new Map([[7, new Set(['planning_center', 'elvanto'])]]);
  assert.equal(isPersonLocked('elvanto', links.get(7)), true);
  assert.equal(isPersonLocked('planning_center', links.get(7)), true);
  assert.equal(isPersonLocked('none', links.get(7)), false);
  assert.equal(isPersonLocked('elvanto', new Set(['planning_center'])), false);
});

test('authority operations reject invalid providers and mismatched commits', async () => {
  await withTestChurchDb(async (churchId) => {
    await assert.rejects(beginAuthoritySwitch(churchId, 'other'), /unsupported people authority provider/i);
    await assert.rejects(commitAuthoritySwitch(churchId, 'planning_center'), /pending authority switch/i);

    await beginAuthoritySwitch(churchId, 'elvanto');
    await assert.rejects(commitAuthoritySwitch(churchId, 'planning_center'), /pending authority switch/i);
    assert.deepEqual(await getAuthority(churchId), { active: 'none', pending: 'elvanto' });
  });
});

test('a later switch replaces the pending switch and disabling clears active and pending authority', async () => {
  await withTestChurchDb(async (churchId) => {
    await beginAuthoritySwitch(churchId, 'elvanto');
    await beginAuthoritySwitch(churchId, 'planning_center');
    assert.deepEqual(await getAuthority(churchId), { active: 'none', pending: 'planning_center' });

    await commitAuthoritySwitch(churchId, 'planning_center');
    await beginAuthoritySwitch(churchId, 'elvanto');
    await disableAuthority(churchId);
    assert.deepEqual(await getAuthority(churchId), { active: 'none', pending: null });
  });
});

test('requesting the active provider cancels a pending authority switch', async () => {
  await withTestChurchDb(async (churchId) => {
    await beginAuthoritySwitch(churchId, 'planning_center');
    await commitAuthoritySwitch(churchId, 'planning_center');
    await beginAuthoritySwitch(churchId, 'elvanto');
    assert.deepEqual(await getAuthority(churchId), {
      active: 'planning_center', pending: 'elvanto',
    });

    await beginAuthoritySwitch(churchId, 'planning_center');
    assert.deepEqual(await getAuthority(churchId), {
      active: 'planning_center', pending: null,
    });
  });
});

test('managed link reads include both providers and the temporary legacy PCO fallback', async () => {
  await withTestChurchDb(async (churchId) => {
    const both = await seedIndividual(churchId, { firstName: 'Both' });
    const elvantoOnly = await seedIndividual(churchId, { firstName: 'Elvanto' });
    const legacyPco = await seedIndividual(churchId, { firstName: 'Legacy', planningCenterId: 'legacy-pco-3' });
    await linkPerson(churchId, both, 'planning_center', 'pco-1');
    await linkPerson(churchId, both, 'elvanto', 'elvanto-1');
    await linkPerson(churchId, elvantoOnly, 'elvanto', 'elvanto-2');

    const links = await getManagedLinks(churchId, [both, elvantoOnly, legacyPco, 9999]);
    assert.deepEqual([...links.get(both)].sort(), ['elvanto', 'planning_center']);
    assert.deepEqual([...links.get(elvantoOnly)], ['elvanto']);
    assert.deepEqual([...links.get(legacyPco)], ['planning_center']);
    assert.equal(links.has(9999), false);
  });
});

test('authority and managed links remain isolated by church', async () => {
  await withTestChurchDb(async (churchId) => {
    const otherChurchId = `${churchId}_other`;
    Database.getChurchDb(otherChurchId);
    await Database.queryForChurch(
      otherChurchId,
      `INSERT INTO church_settings (church_id, church_name) VALUES (?, 'Other Church')`,
      [otherChurchId]
    );
    const otherPerson = await Database.queryForChurch(
      otherChurchId,
      `INSERT INTO individuals (church_id, first_name, last_name, planning_center_id)
       VALUES (?, 'Other', 'Person', 'other-pco')`,
      [otherChurchId]
    );

    await beginAuthoritySwitch(otherChurchId, 'elvanto');
    await commitAuthoritySwitch(otherChurchId, 'elvanto');

    assert.deepEqual(await getAuthority(churchId), { active: 'none', pending: null });
    assert.deepEqual(await getAuthority(otherChurchId), { active: 'elvanto', pending: null });
    assert.equal((await getManagedLinks(churchId, [Number(otherPerson.insertId)])).size, 0);
  });
});

test('locked responses use the provider-neutral contract', () => {
  assert.deepEqual(lockedResponse('elvanto', 'merge'), {
    error: 'This person is managed by Elvanto. Make the change in Elvanto and sync again.',
    code: PEOPLE_SOURCE_LOCKED,
    provider: 'elvanto',
    action: 'merge',
  });
});
