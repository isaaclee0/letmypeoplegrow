const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { applyPeopleSyncPlan } = require('./apply');
const { BUCKETS } = require('./plan');

// Minimal, self-documenting empty plan shape — every bucket applyPeopleSyncPlan
// reads, so tests only need to override the buckets that matter for that
// scenario. Mirrors computePeopleSyncPlan's own output shape (see plan.js).
function emptyPlan(overrides = {}) {
  const plan = { provider: overrides.provider || 'elvanto', authoritative: overrides.authoritative !== false };
  for (const bucket of BUCKETS) plan[bucket] = [];
  return { ...plan, ...overrides };
}

async function seedIndividual(churchId, overrides = {}) {
  const result = await Database.query(
    `INSERT INTO individuals (church_id, first_name, last_name, family_id, people_type, is_active, planning_center_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      churchId, overrides.firstName || 'Ada', overrides.lastName || 'Lovelace', overrides.familyId || null,
      overrides.peopleType || 'regular', overrides.isActive === false ? 0 : 1, overrides.planningCenterId || null,
    ]
  );
  return Number(result.insertId);
}

async function seedFamily(churchId, familyName = 'Lovelace') {
  const result = await Database.query(
    `INSERT INTO families (church_id, family_name) VALUES (?, ?)`, [churchId, familyName]
  );
  return Number(result.insertId);
}

async function seedGatheringType(churchId, name = 'Sunday Service') {
  const result = await Database.query(
    `INSERT INTO gathering_types (name, church_id) VALUES (?, ?)`, [name, churchId]
  );
  return Number(result.insertId);
}

async function seedSyncBatch(churchId, provider, name = 'Members') {
  const result = await Database.query(
    `INSERT INTO people_sync_batches (church_id, provider, name) VALUES (?, ?, ?)`,
    [churchId, provider, name]
  );
  return Number(result.insertId);
}

async function seedGatheringListRow(churchId, gatheringTypeId, individualId, addedBySyncBatchId) {
  await Database.query(
    `INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id, added_by_sync_batch_id)
     VALUES (?, ?, ?, ?)`,
    [gatheringTypeId, individualId, churchId, addedBySyncBatchId]
  );
}

async function setAuthority(churchId, provider) {
  await Database.query(
    `INSERT INTO people_sync_settings (church_id, authority_provider) VALUES (?, ?)
     ON CONFLICT(church_id) DO UPDATE SET authority_provider = excluded.authority_provider`,
    [churchId, provider]
  );
}

async function counts(churchId) {
  const [individuals] = await Database.query('SELECT COUNT(*) AS n FROM individuals WHERE church_id = ?', [churchId]);
  const [families] = await Database.query('SELECT COUNT(*) AS n FROM families WHERE church_id = ?', [churchId]);
  const [links] = await Database.query('SELECT COUNT(*) AS n FROM external_person_links WHERE church_id = ?', [churchId]);
  return { individuals: Number(individuals.n), families: Number(families.n), links: Number(links.n) };
}

test('link creation writes external_person_links and dual-writes the legacy PCO id only for planning_center', async () => {
  await withTestChurchDb(async (churchId) => {
    const pcoIndividualId = await seedIndividual(churchId, { firstName: 'PCO' });
    const elvantoIndividualId = await seedIndividual(churchId, { firstName: 'Elvanto' });

    await applyPeopleSyncPlan({
      churchId, provider: 'planning_center',
      plan: emptyPlan({ provider: 'planning_center', linkPeople: [
        { id: 'linkPeople:pco-1', externalPersonId: 'pco-1', individualId: pcoIndividualId, reviewRequired: false },
      ] }),
    });
    await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({ provider: 'elvanto', linkPeople: [
        { id: 'linkPeople:elvanto-1', externalPersonId: 'elvanto-1', individualId: elvantoIndividualId, reviewRequired: false },
      ] }),
    });

    const [pcoRow] = await Database.query('SELECT planning_center_id FROM individuals WHERE id = ?', [pcoIndividualId]);
    const [elvantoRow] = await Database.query('SELECT planning_center_id FROM individuals WHERE id = ?', [elvantoIndividualId]);
    assert.equal(pcoRow.planning_center_id, 'pco-1');
    assert.equal(elvantoRow.planning_center_id, null);

    const links = await Database.query(
      'SELECT provider, external_person_id, individual_id FROM external_person_links WHERE church_id = ? ORDER BY provider',
      [churchId]
    );
    assert.deepEqual(links, [
      { provider: 'elvanto', external_person_id: 'elvanto-1', individual_id: elvantoIndividualId },
      { provider: 'planning_center', external_person_id: 'pco-1', individual_id: pcoIndividualId },
    ]);
  });
});

test('person, family, and link creation commit together', async () => {
  await withTestChurchDb(async (churchId) => {
    const result = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto', userId: null,
      plan: emptyPlan({
        addFamilies: [{ id: 'addFamilies:fam-x', familyName: 'Ada Lovelace Household', externalFamilyId: 'fam-x' }],
        addPeople: [{
          id: 'addPeople:ext-1', externalPersonId: 'ext-1', firstName: 'Ada', lastName: 'Lovelace',
          isChild: false, familyId: null, peopleType: 'regular',
        }],
      }),
    });

    assert.equal(result.addFamilies, 1);
    assert.equal(result.addPeople, 1);
    const { individuals, families } = await counts(churchId);
    assert.equal(individuals, 1);
    assert.equal(families, 1);
    const [familyLink] = await Database.query(
      'SELECT external_family_id, family_id FROM external_family_links WHERE church_id = ?', [churchId]
    );
    assert.equal(familyLink.external_family_id, 'fam-x');
    const [personLink] = await Database.query(
      'SELECT external_person_id FROM external_person_links WHERE church_id = ?', [churchId]
    );
    assert.equal(personLink.external_person_id, 'ext-1');
  });
});

test('a forced link collision rolls back every newly created person and family from this call', async () => {
  await withTestChurchDb(async (churchId) => {
    const before = await counts(churchId);
    assert.deepEqual(before, { individuals: 0, families: 0, links: 0 });

    await assert.rejects(applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        addFamilies: [{ id: 'addFamilies:fam-x', familyName: 'New Family' }],
        // Two additions that collide on the SAME externalPersonId: the first
        // creates its individual and link successfully; the second creates
        // its individual but then fails to link (external_person_id already
        // claimed by a different individual_id) — forcing the whole
        // transaction, including everything above, to roll back.
        addPeople: [
          { id: 'addPeople:1', externalPersonId: 'ext-dup', firstName: 'First', lastName: 'Person', isChild: false, familyId: null, peopleType: 'regular' },
          { id: 'addPeople:2', externalPersonId: 'ext-dup', firstName: 'Second', lastName: 'Person', isChild: false, familyId: null, peopleType: 'regular' },
        ],
      }),
    }), /link collision/i);

    const after = await counts(churchId);
    assert.deepEqual(after, { individuals: 0, families: 0, links: 0 });
  });
});

test('managed field updates ignore an isChild change whose externalValue is null', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId, { firstName: 'Old' });
    await Database.query('UPDATE individuals SET is_child = 1 WHERE id = ?', [individualId]);

    await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        updateManagedFields: [{
          id: 'updateManagedFields:x', externalPersonId: 'ext-1', individualId,
          changes: [
            { field: 'firstName', localValue: 'Old', externalValue: 'New' },
            { field: 'isChild', localValue: true, externalValue: null },
          ],
        }],
      }),
    });

    const [row] = await Database.query('SELECT first_name, is_child FROM individuals WHERE id = ?', [individualId]);
    assert.equal(row.first_name, 'New');
    assert.equal(row.is_child, 1);
  });
});

test('type alignment and archive/reactivate transitions apply as instructed', async () => {
  await withTestChurchDb(async (churchId) => {
    const toPromote = await seedIndividual(churchId, { peopleType: 'local_visitor' });
    const toDemote = await seedIndividual(churchId, { peopleType: 'regular' });
    const toArchive = await seedIndividual(churchId);
    const toReactivate = await seedIndividual(churchId, { isActive: false });

    const result = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        promoteToRegular: [{ id: 'p', externalPersonId: 'e1', individualId: toPromote }],
        demoteToLocalVisitor: [{ id: 'd', externalPersonId: 'e2', individualId: toDemote }],
        archive: [{ id: 'a', externalPersonId: 'e3', individualId: toArchive, reason: 'provider_state_archived' }],
        reactivate: [{ id: 'r', externalPersonId: 'e4', individualId: toReactivate }],
      }),
    });

    assert.equal(result.promoteToRegular, 1);
    assert.equal(result.demoteToLocalVisitor, 1);
    assert.equal(result.archive, 1);
    assert.equal(result.reactivate, 1);

    const rows = await Database.query(
      'SELECT id, people_type, is_active FROM individuals WHERE church_id = ? ORDER BY id', [churchId]
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get(toPromote).people_type, 'regular');
    assert.equal(byId.get(toDemote).people_type, 'local_visitor');
    assert.equal(byId.get(toArchive).is_active, 0);
    assert.equal(byId.get(toReactivate).is_active, 1);
  });
});

test('a non-authoritative plan cannot modify a record locked by the active authority', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId, { firstName: 'Locked' });
    await Database.query(
      `INSERT INTO external_person_links (church_id, provider, external_person_id, individual_id, link_source)
       VALUES (?, 'planning_center', 'pco-1', ?, 'matched')`,
      [churchId, individualId]
    );
    await setAuthority(churchId, 'planning_center');

    await assert.rejects(applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        authoritative: false,
        updateManagedFields: [{
          id: 'u', externalPersonId: 'elvanto-1', individualId,
          changes: [{ field: 'firstName', localValue: 'Locked', externalValue: 'Renamed' }],
        }],
      }),
    }), /managed by the active people-sync authority/i);

    const [row] = await Database.query('SELECT first_name FROM individuals WHERE id = ?', [individualId]);
    assert.equal(row.first_name, 'Locked');
  });
});

test('an authoritative plan for the SAME provider may still modify its own linked record', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId, { firstName: 'Old' });
    await Database.query(
      `INSERT INTO external_person_links (church_id, provider, external_person_id, individual_id, link_source)
       VALUES (?, 'elvanto', 'elvanto-1', ?, 'matched')`,
      [churchId, individualId]
    );
    await setAuthority(churchId, 'elvanto');

    await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        authoritative: true,
        updateManagedFields: [{
          id: 'u', externalPersonId: 'elvanto-1', individualId,
          changes: [{ field: 'firstName', localValue: 'Old', externalValue: 'New' }],
        }],
      }),
    });

    const [row] = await Database.query('SELECT first_name FROM individuals WHERE id = ?', [individualId]);
    assert.equal(row.first_name, 'New');
  });
});

test('gathering roster insert uses added_by_sync_batch_id, not the legacy PCO batch column', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId);
    const gatheringTypeId = await seedGatheringType(churchId);
    const batchId = await seedSyncBatch(churchId, 'elvanto');

    const result = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        addToGathering: [{
          id: 'addToGathering:x', batchId, gatheringTypeId, externalPersonId: 'ext-1', individualId,
        }],
      }),
    });

    assert.equal(result.addToGathering, 1);
    assert.equal(result.gatheringAssigned, 1);
    const [row] = await Database.query(
      'SELECT added_by_sync_batch_id, added_by_pco_batch_id FROM gathering_lists WHERE gathering_type_id = ? AND individual_id = ?',
      [gatheringTypeId, individualId]
    );
    assert.equal(row.added_by_sync_batch_id, batchId);
    assert.equal(row.added_by_pco_batch_id, null);
  });
});

test('a manual gathering row and another batch\'s row are never removed by this batch\'s removal', async () => {
  await withTestChurchDb(async (churchId) => {
    const gatheringTypeId = await seedGatheringType(churchId);
    const ownerBatchId = await seedSyncBatch(churchId, 'elvanto', 'Owner');
    const otherBatchId = await seedSyncBatch(churchId, 'elvanto', 'Other');
    const manualIndividualId = await seedIndividual(churchId, { firstName: 'Manual' });
    const otherBatchIndividualId = await seedIndividual(churchId, { firstName: 'OtherBatch' });
    await seedGatheringListRow(churchId, gatheringTypeId, manualIndividualId, null);
    await seedGatheringListRow(churchId, gatheringTypeId, otherBatchIndividualId, otherBatchId);

    const result = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        // This batch's removal action names individuals it does NOT actually
        // own on the roster (manual, and another batch's) — the DELETE's own
        // WHERE clause (added_by_sync_batch_id = ownerBatchId) must leave both untouched.
        removeFromGathering: [
          { id: 'removeFromGathering:manual', batchId: ownerBatchId, gatheringTypeId, individualId: manualIndividualId },
          { id: 'removeFromGathering:other', batchId: ownerBatchId, gatheringTypeId, individualId: otherBatchIndividualId },
        ],
      }),
    });

    assert.equal(result.gatheringRemoved, 0);
    const rows = await Database.query(
      'SELECT individual_id FROM gathering_lists WHERE gathering_type_id = ? ORDER BY individual_id', [gatheringTypeId]
    );
    assert.deepEqual(rows.map((r) => r.individual_id).sort((a, b) => a - b),
      [manualIndividualId, otherBatchIndividualId].sort((a, b) => a - b));
  });
});

test('an owner batch removes its own row when no longer eligible', async () => {
  await withTestChurchDb(async (churchId) => {
    const gatheringTypeId = await seedGatheringType(churchId);
    const ownerBatchId = await seedSyncBatch(churchId, 'elvanto', 'Owner');
    const individualId = await seedIndividual(churchId);
    await seedGatheringListRow(churchId, gatheringTypeId, individualId, ownerBatchId);

    const result = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        removeFromGathering: [{ id: 'removeFromGathering:x', batchId: ownerBatchId, gatheringTypeId, individualId }],
      }),
    });

    assert.equal(result.removeFromGathering, 1);
    assert.equal(result.gatheringRemoved, 1);
    const rows = await Database.query('SELECT * FROM gathering_lists WHERE gathering_type_id = ?', [gatheringTypeId]);
    assert.deepEqual(rows, []);
  });
});

test('an owner batch does not remove a row while this same plan still adds that person to the gathering', async () => {
  await withTestChurchDb(async (churchId) => {
    const gatheringTypeId = await seedGatheringType(churchId);
    const ownerBatchId = await seedSyncBatch(churchId, 'elvanto', 'Owner');
    const otherBatchId = await seedSyncBatch(churchId, 'elvanto', 'StillQualifies');
    const individualId = await seedIndividual(churchId);
    await seedGatheringListRow(churchId, gatheringTypeId, individualId, ownerBatchId);

    // A hand-built plan standing in for the scenario where a second enabled
    // batch still qualifies this same person for this same gathering: the
    // plan simultaneously proposes keeping them (addToGathering, sourced from
    // the other batch) and the owner batch removing its own row. Apply's own
    // internal consistency guard (on top of plan.js already never producing
    // this combination for a real plan) must prefer "stays" over "removed".
    const result = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        addToGathering: [{
          id: 'addToGathering:x', batchId: otherBatchId, gatheringTypeId, externalPersonId: 'ext-1', individualId,
        }],
        removeFromGathering: [{ id: 'removeFromGathering:x', batchId: ownerBatchId, gatheringTypeId, individualId }],
      }),
    });

    assert.equal(result.removeFromGathering, 0);
    assert.equal(result.gatheringRemoved, 0);
    const rows = await Database.query('SELECT individual_id FROM gathering_lists WHERE gathering_type_id = ?', [gatheringTypeId]);
    assert.deepEqual(rows, [{ individual_id: individualId }]);
  });
});

test('an accepted ambiguous selection is applied as a manual link', async () => {
  await withTestChurchDb(async (churchId) => {
    const candidateA = await seedIndividual(churchId, { firstName: 'A' });
    const candidateB = await seedIndividual(churchId, { firstName: 'B' });

    const result = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        ambiguousPeople: [{
          id: 'ambiguousPeople:ext-1:x', externalPersonId: 'ext-1',
          candidateIndividualIds: [candidateA, candidateB], reason: 'duplicate_name',
        }],
      }),
      selections: { ambiguous: { 'ext-1': candidateB } },
    });

    assert.equal(result.linkPeople, 1);
    const [link] = await Database.query('SELECT individual_id, link_source FROM external_person_links WHERE church_id = ?', [churchId]);
    assert.equal(link.individual_id, candidateB);
    assert.equal(link.link_source, 'manual');
  });
});

test('skipping an addPeople selection leaves that person uncreated', async () => {
  await withTestChurchDb(async (churchId) => {
    const result = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        addPeople: [
          { id: 'addPeople:keep', externalPersonId: 'keep-1', firstName: 'Keep', lastName: 'Me', isChild: false, familyId: null, peopleType: 'regular' },
          { id: 'addPeople:skip', externalPersonId: 'skip-1', firstName: 'Skip', lastName: 'Me', isChild: false, familyId: null, peopleType: 'regular' },
        ],
      }),
      selections: { skipExternalPersonIds: ['skip-1'] },
    });

    assert.equal(result.addPeople, 1);
    const rows = await Database.query('SELECT first_name FROM individuals WHERE church_id = ?', [churchId]);
    assert.deepEqual(rows.map((r) => r.first_name), ['Keep']);
  });
});

test('a family rename only applies when explicitly accepted, and never invents a name', async () => {
  await withTestChurchDb(async (churchId) => {
    const familyId = await seedFamily(churchId, 'Old Name');

    const notAccepted = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({ renameFamily: [{ id: 'renameFamily:x', familyId, familyName: 'New Name' }] }),
    });
    assert.equal(notAccepted.renameFamily, 0);
    assert.equal(notAccepted.familyNamesUpdated, 0);

    const accepted = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({ renameFamily: [{ id: 'renameFamily:x', familyId, familyName: 'New Name' }] }),
      selections: { acceptFamilyRenameIds: ['renameFamily:x'] },
    });
    assert.equal(accepted.renameFamily, 1);
    assert.equal(accepted.familyNamesUpdated, 1);

    const [row] = await Database.query('SELECT family_name FROM families WHERE id = ?', [familyId]);
    assert.equal(row.family_name, 'New Name');

    await assert.rejects(applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({ renameFamily: [{ id: 'renameFamily:y', familyId, familyName: '   ' }] }),
      selections: { acceptFamilyRenameIds: ['renameFamily:y'] },
    }), /missing a reviewed family name/i);
  });
});

test('moveFamily reassigns an individual to an existing family in this church only', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId);
    const familyId = await seedFamily(churchId, 'New Family');

    const result = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({ moveFamily: [{ id: 'moveFamily:x', individualId, familyId }] }),
    });

    assert.equal(result.moveFamily, 1);
    const [row] = await Database.query('SELECT family_id FROM individuals WHERE id = ?', [individualId]);
    assert.equal(row.family_id, familyId);
  });
});

test('moveFamily rejects a family id from another church', async () => {
  await withTestChurchDb(async (churchId) => {
    const otherChurchId = `${churchId}_other`;
    Database.getChurchDb(otherChurchId);
    await Database.queryForChurch(otherChurchId, `INSERT INTO church_settings (church_id, church_name) VALUES (?, 'Other')`, [otherChurchId]);
    const otherFamilyId = await Database.queryForChurch(
      otherChurchId, `INSERT INTO families (church_id, family_name) VALUES (?, 'Other Family')`, [otherChurchId]
    ).then((r) => Number(r.insertId));
    const individualId = await seedIndividual(churchId);

    await assert.rejects(applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({ moveFamily: [{ id: 'moveFamily:x', individualId, familyId: otherFamilyId }] }),
    }), /outside this church/i);
  });
});

test('addPeople rejects a familyId that does not belong to this church', async () => {
  await withTestChurchDb(async (churchId) => {
    const otherChurchId = `${churchId}_other`;
    Database.getChurchDb(otherChurchId);
    await Database.queryForChurch(otherChurchId, `INSERT INTO church_settings (church_id, church_name) VALUES (?, 'Other')`, [otherChurchId]);
    const otherFamilyId = await Database.queryForChurch(
      otherChurchId, `INSERT INTO families (church_id, family_name) VALUES (?, 'Other Family')`, [otherChurchId]
    ).then((r) => Number(r.insertId));

    await assert.rejects(applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        addPeople: [{
          id: 'addPeople:x', externalPersonId: 'ext-1', firstName: 'A', lastName: 'B',
          isChild: false, familyId: otherFamilyId, peopleType: 'regular',
        }],
      }),
    }), /outside this church/i);

    const { individuals } = await counts(churchId);
    assert.equal(individuals, 0);
  });
});

test('applyPeopleSyncPlan rejects a plan computed for a different provider', async () => {
  await withTestChurchDb(async (churchId) => {
    await assert.rejects(applyPeopleSyncPlan({
      churchId, provider: 'elvanto', plan: emptyPlan({ provider: 'planning_center' }),
    }), /computed for provider/i);
  });
});

test('applyPeopleSyncPlan rejects an unsupported provider', async () => {
  await withTestChurchDb(async (churchId) => {
    await assert.rejects(applyPeopleSyncPlan({
      churchId, provider: 'salesforce', plan: emptyPlan({ provider: 'salesforce' }),
    }), /unsupported people-sync provider/i);
  });
});

test('addFamilies dual-writes the legacy PCO family id only for planning_center', async () => {
  await withTestChurchDb(async (churchId) => {
    const result = await applyPeopleSyncPlan({
      churchId, provider: 'planning_center',
      plan: emptyPlan({
        provider: 'planning_center',
        addFamilies: [{ id: 'addFamilies:x', familyName: 'PCO Family', externalFamilyId: 'pco-fam-1' }],
      }),
    });
    assert.equal(result.addFamilies, 1);
    const [row] = await Database.query('SELECT planning_center_id FROM families WHERE church_id = ?', [churchId]);
    assert.equal(row.planning_center_id, 'pco-fam-1');
  });
});

test('result counts reconcile with the plan\'s own bucket sizes for a straightforward plan', async () => {
  await withTestChurchDb(async (churchId) => {
    const linked = await seedIndividual(churchId);
    const plan = emptyPlan({
      linkPeople: [{ id: 'linkPeople:x', externalPersonId: 'ext-1', individualId: linked, reviewRequired: false }],
      addPeople: [{ id: 'addPeople:x', externalPersonId: 'ext-2', firstName: 'New', lastName: 'Person', isChild: false, familyId: null, peopleType: 'regular' }],
    });
    const result = await applyPeopleSyncPlan({ churchId, provider: 'elvanto', plan });

    assert.equal(result.linkPeople, plan.linkPeople.length);
    assert.equal(result.addPeople, plan.addPeople.length);
    // Purely-informational review buckets are never mutated directly by apply.
    assert.equal(result.ambiguousPeople, 0);
    assert.equal(result.familyConflicts, 0);
    assert.equal(result.unmatchedLocalRegulars, 0);
    assert.equal(result.skipped, 0);
  });
});
