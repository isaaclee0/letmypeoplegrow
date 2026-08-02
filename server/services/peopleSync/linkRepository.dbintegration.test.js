const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const {
  listPersonLinks,
  upsertPersonLink,
  upsertPersonLinkWithConnection,
  applyPersonLinkCorrectionsWithConnection,
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

async function personLinkPairs(churchId, provider) {
  const rows = await Database.query(
    `SELECT external_person_id, individual_id FROM external_person_links
      WHERE church_id = ? AND provider = ? ORDER BY external_person_id`,
    [churchId, provider]
  );
  return rows.map((row) => [row.external_person_id, row.individual_id]);
}

async function pcoIds(...individualIds) {
  const placeholders = individualIds.map(() => '?').join(', ');
  const rows = await Database.query(
    `SELECT id, planning_center_id FROM individuals WHERE id IN (${placeholders}) ORDER BY id`,
    individualIds
  );
  return rows.map((row) => row.planning_center_id);
}

async function seedPersonLink(churchId, provider, externalPersonId, individualId) {
  await upsertPersonLink({
    churchId, provider, externalPersonId, individualId, linkSource: 'matched',
  });
  if (provider === 'planning_center') {
    await Database.query(
      `UPDATE individuals SET planning_center_id = ? WHERE church_id = ? AND id = ?`,
      [externalPersonId, churchId, individualId]
    );
  }
}

test('explicit PCO relinks clear old compatibility IDs before inserting final links', async () => {
  await withTestChurchDb(async (churchId) => {
    const firstId = await seedIndividual(churchId, 'First');
    const secondId = await seedIndividual(churchId, 'Second');
    await seedPersonLink(churchId, 'planning_center', 'pco-a', firstId);
    await seedPersonLink(churchId, 'planning_center', 'pco-b', secondId);

    await Database.transaction(async (conn) => {
      await applyPersonLinkCorrectionsWithConnection(conn, {
        churchId,
        provider: 'planning_center',
        corrections: [
          { externalPersonId: 'pco-a', fromIndividualId: firstId, outcome: 'relink', individualId: secondId },
          { externalPersonId: 'pco-b', fromIndividualId: secondId, outcome: 'relink', individualId: firstId },
        ],
      });
    });

    assert.deepEqual(await personLinkPairs(churchId, 'planning_center'), [
      ['pco-a', secondId], ['pco-b', firstId],
    ]);
    assert.deepEqual(await pcoIds(firstId, secondId), ['pco-b', 'pco-a']);
  });
});

test('corrections reject a stale old pair before changing any link', async () => {
  await withTestChurchDb(async (churchId) => {
    const firstId = await seedIndividual(churchId, 'First');
    const secondId = await seedIndividual(churchId, 'Second');
    await seedPersonLink(churchId, 'planning_center', 'pco-a', firstId);

    await assert.rejects(Database.transaction((conn) =>
      applyPersonLinkCorrectionsWithConnection(conn, {
        churchId,
        provider: 'planning_center',
        corrections: [{
          externalPersonId: 'pco-a', fromIndividualId: secondId, outcome: 'unlink',
        }],
      })
    ), /current link|base pair|stale/i);

    assert.deepEqual(await personLinkPairs(churchId, 'planning_center'), [['pco-a', firstId]]);
    assert.deepEqual(await pcoIds(firstId), ['pco-a']);
  });
});

test('correction targets cannot cross the church boundary', async () => {
  await withTestChurchDb(async (churchId) => {
    const linkedId = await seedIndividual(churchId, 'Linked');
    await seedPersonLink(churchId, 'elvanto', 'elvanto-a', linkedId);
    const otherChurchId = `${churchId}_other`;
    const otherId = (await Database.query(
      `INSERT INTO individuals (church_id, first_name, last_name) VALUES (?, 'Other', 'Church')`,
      [otherChurchId]
    )).insertId;

    await assert.rejects(Database.transaction((conn) =>
      applyPersonLinkCorrectionsWithConnection(conn, {
        churchId,
        provider: 'elvanto',
        corrections: [{
          externalPersonId: 'elvanto-a', fromIndividualId: linkedId,
          outcome: 'relink', individualId: otherId,
        }],
      })
    ), /outside this church/i);

    assert.deepEqual(await personLinkPairs(churchId, 'elvanto'), [['elvanto-a', linkedId]]);
  });
});

test('corrections keep the strict final target uniqueness boundary', async () => {
  await withTestChurchDb(async (churchId) => {
    const firstId = await seedIndividual(churchId, 'First');
    const occupiedId = await seedIndividual(churchId, 'Occupied');
    await seedPersonLink(churchId, 'elvanto', 'elvanto-a', firstId);
    await seedPersonLink(churchId, 'elvanto', 'elvanto-b', occupiedId);

    await assert.rejects(Database.transaction((conn) =>
      applyPersonLinkCorrectionsWithConnection(conn, {
        churchId,
        provider: 'elvanto',
        corrections: [{
          externalPersonId: 'elvanto-a', fromIndividualId: firstId,
          outcome: 'relink', individualId: occupiedId,
        }],
      })
    ), /link collision/i);

    assert.deepEqual(await personLinkPairs(churchId, 'elvanto'), [
      ['elvanto-a', firstId], ['elvanto-b', occupiedId],
    ]);
  });
});

test('unlink clears only Planning Center compatibility IDs and leaves Elvanto compatibility untouched', async () => {
  await withTestChurchDb(async (churchId) => {
    const pcoId = await seedIndividual(churchId, 'PCO');
    const elvantoId = await seedIndividual(churchId, 'Elvanto');
    await seedPersonLink(churchId, 'planning_center', 'pco-a', pcoId);
    await seedPersonLink(churchId, 'elvanto', 'elvanto-a', elvantoId);
    await Database.query(
      `UPDATE individuals SET planning_center_id = 'legacy-pco' WHERE church_id = ? AND id = ?`,
      [churchId, elvantoId]
    );

    await Database.transaction(async (conn) => {
      await applyPersonLinkCorrectionsWithConnection(conn, {
        churchId, provider: 'planning_center',
        corrections: [{ externalPersonId: 'pco-a', fromIndividualId: pcoId, outcome: 'unlink' }],
      });
      await applyPersonLinkCorrectionsWithConnection(conn, {
        churchId, provider: 'elvanto',
        corrections: [{ externalPersonId: 'elvanto-a', fromIndividualId: elvantoId, outcome: 'unlink' }],
      });
    });

    assert.deepEqual(await personLinkPairs(churchId, 'planning_center'), []);
    assert.deepEqual(await personLinkPairs(churchId, 'elvanto'), []);
    assert.deepEqual(await pcoIds(pcoId, elvantoId), [null, 'legacy-pco']);
  });
});

test('a later correction insert failure rolls back every deleted link and compatibility ID', async () => {
  await withTestChurchDb(async (churchId) => {
    const firstId = await seedIndividual(churchId, 'First');
    const secondId = await seedIndividual(churchId, 'Second');
    await seedPersonLink(churchId, 'planning_center', 'pco-a', firstId);
    await seedPersonLink(churchId, 'planning_center', 'pco-b', secondId);
    await Database.query(`CREATE TRIGGER abort_pco_b_correction
      BEFORE INSERT ON external_person_links
      WHEN NEW.external_person_id = 'pco-b' AND NEW.link_source = 'manual'
      BEGIN SELECT RAISE(ABORT, 'forced correction insert failure'); END`);

    await assert.rejects(Database.transaction((conn) =>
      applyPersonLinkCorrectionsWithConnection(conn, {
        churchId,
        provider: 'planning_center',
        corrections: [
          { externalPersonId: 'pco-a', fromIndividualId: firstId, outcome: 'relink', individualId: secondId },
          { externalPersonId: 'pco-b', fromIndividualId: secondId, outcome: 'relink', individualId: firstId },
        ],
      })
    ), /forced correction insert failure/i);

    assert.deepEqual(await personLinkPairs(churchId, 'planning_center'), [
      ['pco-a', firstId], ['pco-b', secondId],
    ]);
    assert.deepEqual(await pcoIds(firstId, secondId), ['pco-a', 'pco-b']);
  });
});

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

test('full-fetch presence rejects a changed authority stance before updating counters', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId);
    await upsertPersonLink({
      churchId, provider: 'elvanto', externalPersonId: 'elvanto-1', individualId, linkSource: 'created',
    });
    await Database.query(
      `UPDATE people_sync_settings SET authority_provider = 'none', pending_authority_provider = NULL
        WHERE church_id = ?`,
      [churchId]
    );

    await assert.rejects(
      recordFullFetchPresence(churchId, 'elvanto', new Set(), {
        complete: true,
        authorityExpectation: { active: 'elvanto', pending: null },
      }),
      (error) => error.code === 'SYNC_PLAN_STALE' && error.status === 409,
    );
    assert.equal((await listPersonLinks(churchId, 'elvanto'))[0].missingFullSyncCount, 0);
  });
});

test('full-fetch presence rejects a changed Elvanto connection generation before updating counters', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId);
    await upsertPersonLink({
      churchId, provider: 'elvanto', externalPersonId: 'elvanto-1', individualId, linkSource: 'created',
    });
    await Database.query(
      `INSERT INTO integration_connection_generations (church_id, provider, generation)
       VALUES (?, 'elvanto', 8)`,
      [churchId]
    );

    await assert.rejects(
      recordFullFetchPresence(churchId, 'elvanto', new Set(), {
        complete: true,
        connectionExpectation: { generation: 7 },
      }),
      (error) => error.code === 'SYNC_PLAN_STALE' && error.status === 409,
    );
    assert.equal((await listPersonLinks(churchId, 'elvanto'))[0].missingFullSyncCount, 0);
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
