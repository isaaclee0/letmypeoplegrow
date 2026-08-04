'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { loadLocalProjectionState } = require('./localProjectionState');

async function seedProjection(churchId, {
  firstName,
  lastName,
  familyName,
  externalId,
  filler = false,
} = {}) {
  const family = await Database.queryForChurch(
    churchId,
    `INSERT INTO families (church_id, family_name, family_identifier, planning_center_id)
     VALUES (?, ?, ?, ?)`,
    [churchId, familyName, `${familyName}-identifier`, `${externalId}-family-compatibility`]
  );
  const familyId = Number(family.insertId);
  const individual = await Database.queryForChurch(
    churchId,
    `INSERT INTO individuals
       (church_id, first_name, last_name, people_type, family_id, is_child, is_active, planning_center_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [churchId, firstName, lastName, filler ? 'local_visitor' : 'regular', familyId, filler ? 1 : 0, filler ? 0 : 1, `${externalId}-compatibility`]
  );
  const individualId = Number(individual.insertId);
  const gathering = await Database.queryForChurch(
    churchId,
    'INSERT INTO gathering_types (church_id, name) VALUES (?, ?)',
    [churchId, `${familyName} Gathering`]
  );
  const gatheringTypeId = Number(gathering.insertId);
  const syncBatch = await Database.queryForChurch(
    churchId,
    `INSERT INTO people_sync_batches
       (church_id, provider, name, source_kind, source_external_id, source_name)
     VALUES (?, 'elvanto', ?, 'elvanto_group', ?, ?)`,
    [churchId, `${familyName} Batch`, `${externalId}-source`, `${familyName} Source`]
  );
  const syncBatchId = Number(syncBatch.insertId);

  await Database.queryForChurch(
    churchId,
    `INSERT INTO gathering_lists (church_id, gathering_type_id, individual_id, added_by_sync_batch_id)
     VALUES (?, ?, ?, ?)`,
    [churchId, gatheringTypeId, individualId, filler ? null : syncBatchId]
  );
  const personLink = await Database.queryForChurch(
    churchId,
    `INSERT INTO external_person_links
       (church_id, provider, external_person_id, individual_id, link_source, review_declined, linked_at, last_seen_at)
     VALUES (?, 'elvanto', ?, ?, 'matched', ?, '2026-08-04 00:00:00', '2026-08-04 00:00:01')`,
    [churchId, externalId, individualId, filler ? 1 : 0]
  );
  const familyLink = await Database.queryForChurch(
    churchId,
    `INSERT INTO external_family_links
       (church_id, provider, external_family_id, family_id, link_source, linked_at, last_seen_at)
     VALUES (?, 'elvanto', ?, ?, 'created', '2026-08-04 00:00:02', '2026-08-04 00:00:03')`,
    [churchId, externalId, familyId]
  );
  await Database.queryForChurch(
    churchId,
    `INSERT INTO people_sync_match_exclusions
       (church_id, provider, external_person_id, individual_id)
     VALUES (?, 'elvanto', ?, ?)`,
    [churchId, externalId, individualId]
  );
  await Database.queryForChurch(
    churchId,
    `INSERT INTO people_sync_match_holds
       (church_id, provider, external_person_id, reason)
     VALUES (?, 'elvanto', ?, 'deferred')`,
    [churchId, externalId]
  );

  return {
    familyId, individualId, gatheringTypeId, syncBatchId,
    personLinkId: Number(personLink.insertId), familyLinkId: Number(familyLink.insertId),
  };
}

test('local projection state stays within its requested church when provider IDs overlap', async () => {
  // Catches any local projection query that omits church_id and leaks a
  // same-provider external identity from another church into this sync.
  await withTestChurchDb(async (churchA) => {
    const churchB = `${churchA}_other`;
    Database.getChurchDb(churchB);
    const projectionA = await seedProjection(churchA, {
      firstName: 'Ada', lastName: 'Lovelace', familyName: 'Lovelace', externalId: 'shared-external-id',
    });
    await seedProjection(churchB, {
      firstName: 'Filler', lastName: 'Person', familyName: 'Filler', externalId: 'filler-external-id', filler: true,
    });
    const projectionB = await seedProjection(churchB, {
      firstName: 'Grace', lastName: 'Hopper', familyName: 'Hopper', externalId: 'shared-external-id',
    });

    assert.notEqual(projectionA.individualId, projectionB.individualId);
    assert.notEqual(projectionA.familyId, projectionB.familyId);

    const state = await loadLocalProjectionState(churchA, 'elvanto');

    assert.deepEqual(state.individuals, [{
      id: projectionA.individualId,
      firstName: 'Ada', lastName: 'Lovelace', peopleType: 'regular', familyId: projectionA.familyId,
      isChild: false, isActive: true, planningCenterId: 'shared-external-id-compatibility',
    }]);
    assert.deepEqual(state.families, [{
      id: projectionA.familyId,
      familyName: 'Lovelace', familyIdentifier: 'Lovelace-identifier',
      planningCenterId: 'shared-external-id-family-compatibility',
    }]);
    assert.deepEqual(state.personLinks, [{
      id: projectionA.personLinkId,
      churchId: churchA,
      provider: 'elvanto',
      externalPersonId: 'shared-external-id',
      individualId: projectionA.individualId,
      linkSource: 'matched',
      linkedAt: '2026-08-04 00:00:00',
      lastSeenAt: '2026-08-04 00:00:01',
      reviewDeclined: false,
    }]);
    assert.deepEqual(state.familyLinks, [{
      id: projectionA.familyLinkId,
      churchId: churchA,
      provider: 'elvanto',
      externalFamilyId: 'shared-external-id',
      familyId: projectionA.familyId,
      linkSource: 'created',
      linkedAt: '2026-08-04 00:00:02',
      lastSeenAt: '2026-08-04 00:00:03',
    }]);
    assert.deepEqual(state.gatheringMemberships, [{
      gatheringTypeId: projectionA.gatheringTypeId, individualId: projectionA.individualId, addedBySyncBatchId: projectionA.syncBatchId,
    }]);
    assert.deepEqual(state.matchReviewState, {
      exclusions: [{ externalPersonId: 'shared-external-id', individualId: projectionA.individualId }],
      holds: [{ externalPersonId: 'shared-external-id', reason: 'deferred' }],
    });
  });
});
