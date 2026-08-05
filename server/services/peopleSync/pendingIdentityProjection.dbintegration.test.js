'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const {
  buildPendingIdentityObservations,
  replacePendingIdentityObservations,
  listCurrentUnresolvedIdentityCounts,
} = require('./pendingIdentityProjection');

function batch(id, externalId, overrides = {}) {
  return {
    id,
    provider: 'planning_center',
    source: { kind: 'planning_center_list', externalId, name: externalId },
    draftSource: null,
    sourceRevision: 1,
    draftSourceBaseRevision: null,
    ...overrides,
  };
}

async function seedBatch(churchId, externalId) {
  const result = await Database.query(
    `INSERT INTO people_sync_batches
      (church_id, provider, name, source_kind, source_external_id, source_name)
     VALUES (?, 'planning_center', ?, 'planning_center_list', ?, ?)`,
    [churchId, externalId, externalId, externalId],
  );
  return batch(Number(result.insertId), externalId);
}

test('attributes unresolved overlapping identities to every source-matching batch', async () => {
  await withTestChurchDb(async (churchId) => {
    const first = await seedBatch(churchId, 'list-a');
    const second = await seedBatch(churchId, 'list-b');
    const observations = buildPendingIdentityObservations({
      batches: [first, second],
      eligibleByBatch: new Map([
        [first.id, new Set(['shared', 'linked-only'])],
        [second.id, new Set(['shared'])],
      ]),
      personLinks: [{ externalPersonId: 'linked-only', individualId: 91 }],
      holds: [{ externalPersonId: 'shared', reason: 'deferred' }],
    });

    assert.deepEqual(observations.map(({ batchId, items }) => [batchId, items]), [
      [first.id, [{ externalPersonId: 'shared', reason: 'deferred' }]],
      [second.id, [{ externalPersonId: 'shared', reason: 'deferred' }]],
    ]);

    await replacePendingIdentityObservations(churchId, 'planning_center', observations);
    const counts = await listCurrentUnresolvedIdentityCounts(churchId, 'planning_center', [first, second]);
    assert.equal(counts.get(first.id), 1);
    assert.equal(counts.get(second.id), 1);
  });
});

test('hides a projection whose draft source is no longer the visible source', async () => {
  await withTestChurchDb(async (churchId) => {
    const current = await seedBatch(churchId, 'list-a');
    const draft = {
      ...current,
      draftSource: { kind: 'planning_center_list', externalId: 'list-draft', name: 'list-draft' },
      draftSourceBaseRevision: 1,
    };
    const observations = buildPendingIdentityObservations({
      batches: [draft],
      eligibleByBatch: new Map([[draft.id, new Set(['pending'])]]),
      personLinks: [],
      holds: [],
    });
    await replacePendingIdentityObservations(churchId, 'planning_center', observations);

    const counts = await listCurrentUnresolvedIdentityCounts(churchId, 'planning_center', [current]);
    assert.equal(counts.get(current.id), null);
  });
});
