const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const {
  listPersonLinks,
  upsertPersonLink,
  upsertPersonLinkWithConnection,
  upsertFamilyLink,
  upsertFamilyLinkWithConnection,
  markPeopleSeen,
  recordFullFetchPresence,
} = require('./linkRepository');

async function seedIndividual(churchId, firstName = 'Ada') {
  const result = await Database.query(
    `INSERT INTO individuals (church_id, first_name, last_name)
     VALUES (?, ?, 'Lovelace')`, [churchId, firstName]
  );
  return result.insertId;
}

async function seedFamily(churchId, familyName = 'Lovelace') {
  const result = await Database.query(
    'INSERT INTO families (church_id, family_name) VALUES (?, ?)',
    [churchId, familyName]
  );
  return result.insertId;
}

test('a local person can have one link for each provider', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId);
    await upsertPersonLink({ churchId, provider: 'elvanto', externalPersonId: 'elvanto-1', individualId, linkSource: 'matched' });
    await upsertPersonLink({ churchId, provider: 'planning_center', externalPersonId: 'pco-1', individualId, linkSource: 'matched' });

    assert.deepEqual(await listPersonLinks(churchId, 'elvanto'), [{
      id: 1, churchId, provider: 'elvanto', externalPersonId: 'elvanto-1', individualId,
      linkSource: 'matched', linkedAt: (await listPersonLinks(churchId, 'elvanto'))[0].linkedAt,
      lastSeenAt: (await listPersonLinks(churchId, 'elvanto'))[0].lastSeenAt,
      missingFullSyncCount: 0, reviewDeclined: false,
    }]);
    assert.equal((await listPersonLinks(churchId, 'planning_center'))[0].externalPersonId, 'pco-1');
  });
});

test('a provider collision rejects without disturbing a different provider link', async () => {
  await withTestChurchDb(async (churchId) => {
    const firstIndividualId = await seedIndividual(churchId, 'First');
    const secondIndividualId = await seedIndividual(churchId, 'Second');
    await upsertPersonLink({ churchId, provider: 'elvanto', externalPersonId: 'elvanto-1', individualId: firstIndividualId, linkSource: 'matched' });
    await upsertPersonLink({ churchId, provider: 'planning_center', externalPersonId: 'shared-id', individualId: secondIndividualId, linkSource: 'matched' });

    await assert.rejects(
      upsertPersonLink({ churchId, provider: 'elvanto', externalPersonId: 'elvanto-1', individualId: secondIndividualId, linkSource: 'matched' }),
      /link collision/i
    );
    assert.equal((await listPersonLinks(churchId, 'planning_center'))[0].individualId, secondIndividualId);
  });
});

test('link reads and connection-scoped writes retain the church boundary', async () => {
  await withTestChurchDb(async (churchId) => {
    const otherChurchId = `${churchId}_other`;
    Database.getChurchDb(otherChurchId);
    const individualId = await seedIndividual(churchId);
    await upsertPersonLink({ churchId, provider: 'elvanto', externalPersonId: 'elvanto-1', individualId, linkSource: 'created' });
    assert.deepEqual(await listPersonLinks(otherChurchId, 'elvanto'), []);

    await Database.transaction(async (conn) => {
      await upsertPersonLinkWithConnection(conn, {
        churchId, provider: 'elvanto', externalPersonId: 'elvanto-1', individualId, linkSource: 'manual',
      });
    });
    assert.equal((await listPersonLinks(churchId, 'elvanto'))[0].linkSource, 'manual');
  });
});

test('outer transactions roll back person and family connection-scoped link writes', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId);
    const familyId = await seedFamily(churchId);
    await assert.rejects(Database.transaction(async (conn) => {
      await upsertPersonLinkWithConnection(conn, {
        churchId, provider: 'elvanto', externalPersonId: 'elvanto-person-1', individualId, linkSource: 'created',
      });
      await upsertFamilyLinkWithConnection(conn, {
        churchId, provider: 'elvanto', externalFamilyId: 'elvanto-family-1', familyId, linkSource: 'created',
      });
      throw new Error('abort outer transaction');
    }), /abort outer transaction/);
    assert.equal((await Database.query('SELECT COUNT(*) AS count FROM external_person_links WHERE church_id = ? AND provider = ?', [churchId, 'elvanto']))[0].count, 0);
    assert.equal((await Database.query('SELECT COUNT(*) AS count FROM external_family_links WHERE church_id = ? AND provider = ?', [churchId, 'elvanto']))[0].count, 0);
  });
});

test('seen people reset their missing counter and refresh last seen', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId);
    await upsertPersonLink({ churchId, provider: 'elvanto', externalPersonId: 'elvanto-1', individualId, linkSource: 'created' });
    await recordFullFetchPresence(churchId, 'elvanto', new Set(), { complete: true });
    await markPeopleSeen(churchId, 'elvanto', new Set(['elvanto-1']));
    const [link] = await listPersonLinks(churchId, 'elvanto');
    assert.equal(link.missingFullSyncCount, 0);
    assert.ok(link.lastSeenAt);
  });
});

test('complete full fetches increment missing counters and seen people reset them', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId);
    await upsertPersonLink({ churchId, provider: 'elvanto', externalPersonId: 'elvanto-1', individualId, linkSource: 'created' });

    const first = await recordFullFetchPresence(churchId, 'elvanto', new Set(), { complete: true });
    assert.equal(first.missingCandidates[0].missingFullSyncCount, 1);
    const second = await recordFullFetchPresence(churchId, 'elvanto', new Set(), { complete: true });
    assert.equal(second.missingCandidates[0].missingFullSyncCount, 2);
    await recordFullFetchPresence(churchId, 'elvanto', new Set(['elvanto-1']), { complete: true });
    const links = await listPersonLinks(churchId, 'elvanto');
    assert.equal(links[0].missingFullSyncCount, 0);
  });
});

test('a full-presence write rolls back every earlier counter update when a later write aborts', async () => {
  await withTestChurchDb(async (churchId) => {
    const firstIndividualId = await seedIndividual(churchId, 'First');
    const secondIndividualId = await seedIndividual(churchId, 'Second');
    await upsertPersonLink({ churchId, provider: 'elvanto', externalPersonId: 'elvanto-1', individualId: firstIndividualId, linkSource: 'created' });
    await upsertPersonLink({ churchId, provider: 'elvanto', externalPersonId: 'elvanto-2', individualId: secondIndividualId, linkSource: 'created' });
    await Database.query(`CREATE TRIGGER abort_second_presence
      BEFORE UPDATE ON external_person_links
      WHEN NEW.external_person_id = 'elvanto-2'
      BEGIN SELECT RAISE(ABORT, 'forced presence failure'); END`);

    await assert.rejects(recordFullFetchPresence(churchId, 'elvanto', new Set(), { complete: true }), /forced presence failure/);
    assert.deepEqual((await listPersonLinks(churchId, 'elvanto')).map((link) => link.missingFullSyncCount), [0, 0]);
  });
});

test('incomplete full-fetch presence input fails before it writes counters', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId);
    await upsertPersonLink({ churchId, provider: 'elvanto', externalPersonId: 'elvanto-1', individualId, linkSource: 'created' });
    await assert.rejects(
      recordFullFetchPresence(churchId, 'elvanto', new Set(), { complete: false }),
      /incomplete full fetch/i
    );
    assert.equal((await listPersonLinks(churchId, 'elvanto'))[0].missingFullSyncCount, 0);
  });
});

test('family links use the same church and provider collision boundary', async () => {
  await withTestChurchDb(async (churchId) => {
    const firstFamilyId = await seedFamily(churchId, 'First');
    const secondFamilyId = await seedFamily(churchId, 'Second');
    const familyLink = await upsertFamilyLink({ churchId, provider: 'elvanto', externalFamilyId: 'family-1', familyId: firstFamilyId, linkSource: 'created' });
    assert.equal(familyLink.externalFamilyId, 'family-1');
    assert.equal(familyLink.familyId, firstFamilyId);
    await assert.rejects(
      upsertFamilyLink({ churchId, provider: 'elvanto', externalFamilyId: 'family-1', familyId: secondFamilyId, linkSource: 'manual' }),
      /link collision/i
    );
  });
});
