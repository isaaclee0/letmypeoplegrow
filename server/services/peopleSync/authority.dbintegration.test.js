const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const {
  PEOPLE_SOURCE_LOCKED,
  getAuthority,
  beginAuthoritySwitch,
  cancelAuthoritySwitch,
  commitAuthoritySwitch,
  disableAuthority,
  getManagedLinks,
  getManagedFamilyIds,
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

test('authority preview cancellation is scoped to the exact pending intent', async () => {
  await withTestChurchDb(async (churchId) => {
    await beginAuthoritySwitch(churchId, 'elvanto', 'preview-old');
    await beginAuthoritySwitch(churchId, 'elvanto', 'preview-new');

    const staleCancel = await cancelAuthoritySwitch(churchId, 'elvanto', 'preview-old');
    assert.deepEqual(staleCancel, { active: 'none', pending: 'elvanto' });

    const exactCancel = await cancelAuthoritySwitch(churchId, 'elvanto', 'preview-new');
    assert.deepEqual(exactCancel, { active: 'none', pending: null });
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

test('a competing begin waits for commit so commit cannot report success after losing its pending provider', async () => {
  await withTestChurchDb(async (churchId) => {
    await beginAuthoritySwitch(churchId, 'elvanto');

    const originalExecute = Database._executeQuery;
    let releaseCommitRead;
    const commitReadGate = new Promise((resolve) => { releaseCommitRead = resolve; });
    let commitReadReached;
    const commitReadReachedPromise = new Promise((resolve) => { commitReadReached = resolve; });
    let held = false;
    Database._executeQuery = async function(db, sql, params) {
      const result = await originalExecute.call(this, db, sql, params);
      if (!held && /SELECT pending_authority_provider[\s\S]*FROM people_sync_settings/.test(sql)) {
        held = true;
        commitReadReached();
        await commitReadGate;
      }
      return result;
    };

    try {
      const commitPromise = commitAuthoritySwitch(churchId, 'elvanto');
      await commitReadReachedPromise;
      const competingBegin = beginAuthoritySwitch(churchId, 'planning_center');
      await new Promise((resolve) => setImmediate(resolve));
      releaseCommitRead();

      assert.deepEqual(await commitPromise, { active: 'elvanto', pending: null });
      await competingBegin;
      assert.deepEqual(await getAuthority(churchId), {
        active: 'elvanto', pending: 'planning_center',
      });
    } finally {
      Database._executeQuery = originalExecute;
      releaseCommitRead();
    }
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

test('managed family ids include direct family links and inherited member links only for the active provider', async () => {
  await withTestChurchDb(async (churchId) => {
    const direct = await Database.query(
      `INSERT INTO families (church_id, family_name) VALUES (?, 'Direct')`, [churchId]
    );
    const inherited = await Database.query(
      `INSERT INTO families (church_id, family_name) VALUES (?, 'Inherited')`, [churchId]
    );
    const inactiveProvider = await Database.query(
      `INSERT INTO families (church_id, family_name) VALUES (?, 'Inactive Provider')`, [churchId]
    );
    const member = await seedIndividual(churchId, { firstName: 'Managed Member' });
    await Database.query(
      `UPDATE individuals SET family_id = ? WHERE id = ? AND church_id = ?`,
      [inherited.insertId, member, churchId]
    );
    await Database.query(
      `INSERT INTO external_family_links
         (church_id, provider, external_family_id, family_id, link_source)
       VALUES (?, 'elvanto', 'elvanto-family', ?, 'matched')`,
      [churchId, direct.insertId]
    );
    await Database.query(
      `INSERT INTO external_family_links
         (church_id, provider, external_family_id, family_id, link_source)
       VALUES (?, 'planning_center', 'pco-family', ?, 'matched')`,
      [churchId, inactiveProvider.insertId]
    );
    await linkPerson(churchId, member, 'elvanto', 'elvanto-member');

    const managed = await getManagedFamilyIds(
      churchId,
      [direct.insertId, inherited.insertId, inactiveProvider.insertId],
      'elvanto'
    );
    assert.deepEqual([...managed].sort((a, b) => a - b),
      [Number(direct.insertId), Number(inherited.insertId)]);
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
