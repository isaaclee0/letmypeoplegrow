const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { applyPlan } = require('./apply');

// Minimal, self-documenting empty plan shape — every array field applyPlan
// reads, so tests only need to override the fields that matter for that
// scenario (gatheringEligible).
function emptyPlan(overrides = {}) {
  return {
    update: [],
    archive: [],
    reactivate: [],
    add: [],
    link: [],
    restore: [],
    ambiguous: [],
    visitorMatches: [],
    archiveExtras: [],
    unmatchedVisitors: [],
    familyNameUpdates: [],
    gatheringEligible: [],
    pcoPeople: [],
    ...overrides,
  };
}

async function seedGathering(churchId, name) {
  const res = await Database.query(
    `INSERT INTO gathering_types (name, church_id) VALUES (?, ?)`,
    [name, churchId]
  );
  return res.insertId;
}

async function seedIndividual(churchId, firstName, lastName) {
  const res = await Database.query(
    `INSERT INTO individuals (first_name, last_name, church_id, is_active) VALUES (?, ?, ?, 1)`,
    [firstName, lastName, churchId]
  );
  return res.insertId;
}

// A "batch" here only needs to exist as a row in planning_center_sync_batches
// so that gathering_lists.added_by_pco_batch_id (an FK under foreign_keys=ON)
// can legally reference it. applyPlan itself never reads this table — it only
// consumes batchConfig as plain data — so the row's other columns are
// irrelevant; only its id matters.
async function seedBatch(churchId, name) {
  const res = await Database.query(
    `INSERT INTO planning_center_sync_batches (church_id, name) VALUES (?, ?)`,
    [churchId, name]
  );
  return res.insertId;
}

async function seedGatheringListRow(churchId, gatheringTypeId, individualId, addedByPcoBatchId) {
  await Database.query(
    `INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id, added_by_pco_batch_id) VALUES (?, ?, ?, ?)`,
    [gatheringTypeId, individualId, churchId, addedByPcoBatchId]
  );
}

async function getGatheringListRow(churchId, gatheringTypeId, individualId) {
  const rows = await Database.query(
    `SELECT * FROM gathering_lists WHERE gathering_type_id = ? AND individual_id = ? AND church_id = ?`,
    [gatheringTypeId, individualId, churchId]
  );
  return rows[0] || null;
}

// Task 9: a generic people_sync_batches row already linked (via
// legacy_provider_batch_id) to a legacy planning_center_sync_batches row —
// the exact shape backfillProviderNeutralSync produces, and what a batch
// created/updated through the new pcoSync.createBatch/updateBatch looks like
// during the compatibility window.
async function seedGenericBatchForLegacy(churchId, legacyBatchId, gatheringTypeId) {
  const res = await Database.query(
    `INSERT INTO people_sync_batches
       (church_id, provider, name, default_people_type, gathering_type_id, legacy_provider_batch_id)
     VALUES (?, 'planning_center', 'Generic Batch', 'regular', ?, ?)`,
    [churchId, gatheringTypeId, legacyBatchId]
  );
  return res.insertId;
}

test('applyPlan: insert always tags ownership with the batch id, even when auto-remove is off', async () => {
  await withTestChurchDb(async (churchId) => {
    const gatheringTypeId = await seedGathering(churchId, 'Sunday Service');
    const batchId = await seedBatch(churchId, 'Batch A');
    const individualId = await seedIndividual(churchId, 'Ada', 'Lovelace');

    const plan = emptyPlan({ gatheringEligible: [{ individualId, pcoId: 'p1' }] });
    const batchConfig = {
      batchId,
      defaultPeopleType: 'regular',
      gatheringTypeId,
      gatheringAutoRemoveEnabled: false,
    };

    const result = await applyPlan(churchId, plan, null, {}, batchConfig);

    assert.strictEqual(result.errors.length, 0, `expected no errors, got: ${JSON.stringify(result.errors)}`);
    assert.strictEqual(result.gatheringAssigned, 1);

    const row = await getGatheringListRow(churchId, gatheringTypeId, individualId);
    assert.ok(row, 'gathering_lists row should have been created');
    assert.strictEqual(row.added_by_pco_batch_id, batchId, 'inserted row should be tagged with the running batch id');
  });
});

test('applyPlan: removal only deletes rows owned by the running batch, not other batches\' or manual rows', async () => {
  await withTestChurchDb(async (churchId) => {
    const gatheringTypeId = await seedGathering(churchId, 'Sunday Service');
    const batchA = await seedBatch(churchId, 'Batch A');
    const batchB = await seedBatch(churchId, 'Batch B');

    const individualOwnedByA = await seedIndividual(churchId, 'Owned', 'ByA');
    const individualOwnedByB = await seedIndividual(churchId, 'Owned', 'ByB');
    const individualManual = await seedIndividual(churchId, 'Manual', 'Addition');

    await seedGatheringListRow(churchId, gatheringTypeId, individualOwnedByA, batchA);
    await seedGatheringListRow(churchId, gatheringTypeId, individualOwnedByB, batchB);
    await seedGatheringListRow(churchId, gatheringTypeId, individualManual, null);

    const plan = emptyPlan({ gatheringEligible: [] }); // nobody eligible this run
    const batchConfig = {
      batchId: batchA,
      defaultPeopleType: 'regular',
      gatheringTypeId,
      gatheringAutoRemoveEnabled: true,
    };

    const result = await applyPlan(churchId, plan, null, {}, batchConfig);

    assert.strictEqual(result.errors.length, 0, `expected no errors, got: ${JSON.stringify(result.errors)}`);
    assert.strictEqual(result.gatheringRemoved, 1);

    const rowA = await getGatheringListRow(churchId, gatheringTypeId, individualOwnedByA);
    assert.strictEqual(rowA, null, 'batch A\'s own row should be removed');

    const rowB = await getGatheringListRow(churchId, gatheringTypeId, individualOwnedByB);
    assert.ok(rowB, 'batch B\'s row should still be present');
    assert.strictEqual(rowB.added_by_pco_batch_id, batchB, 'batch B\'s row should be unchanged');

    const rowManual = await getGatheringListRow(churchId, gatheringTypeId, individualManual);
    assert.ok(rowManual, 'the manually-added row should still be present');
    assert.strictEqual(rowManual.added_by_pco_batch_id, null, 'the manually-added row should be unchanged');
  });
});

test('applyPlan: gatheringAutoRemoveEnabled false performs zero deletions even when eligibility changed', async () => {
  await withTestChurchDb(async (churchId) => {
    const gatheringTypeId = await seedGathering(churchId, 'Sunday Service');
    const batchId = await seedBatch(churchId, 'Batch A');
    const individualId = await seedIndividual(churchId, 'Still', 'Owned');

    await seedGatheringListRow(churchId, gatheringTypeId, individualId, batchId);

    const plan = emptyPlan({ gatheringEligible: [] }); // would be removed if the toggle were on
    const batchConfig = {
      batchId,
      defaultPeopleType: 'regular',
      gatheringTypeId,
      gatheringAutoRemoveEnabled: false,
    };

    const result = await applyPlan(churchId, plan, null, {}, batchConfig);

    assert.strictEqual(result.errors.length, 0, `expected no errors, got: ${JSON.stringify(result.errors)}`);
    assert.strictEqual(result.gatheringRemoved, 0);

    const row = await getGatheringListRow(churchId, gatheringTypeId, individualId);
    assert.ok(row, 'row should still be present since auto-remove is disabled');
    assert.strictEqual(row.added_by_pco_batch_id, batchId);
  });
});

test('applyPlan: a person still in the eligible set is left alone', async () => {
  await withTestChurchDb(async (churchId) => {
    const gatheringTypeId = await seedGathering(churchId, 'Sunday Service');
    const batchId = await seedBatch(churchId, 'Batch A');
    const individualId = await seedIndividual(churchId, 'Still', 'Eligible');

    await seedGatheringListRow(churchId, gatheringTypeId, individualId, batchId);

    const plan = emptyPlan({ gatheringEligible: [{ individualId, pcoId: 'p1' }] }); // still eligible
    const batchConfig = {
      batchId,
      defaultPeopleType: 'regular',
      gatheringTypeId,
      gatheringAutoRemoveEnabled: true,
    };

    const result = await applyPlan(churchId, plan, null, {}, batchConfig);

    assert.strictEqual(result.errors.length, 0, `expected no errors, got: ${JSON.stringify(result.errors)}`);
    assert.strictEqual(result.gatheringRemoved, 0);

    const row = await getGatheringListRow(churchId, gatheringTypeId, individualId);
    assert.ok(row, 'row should still be present since the individual is still eligible');
    assert.strictEqual(row.added_by_pco_batch_id, batchId);
  });
});

test('applyPlan: insert never steals ownership of a row another batch (or a manual addition) already owns', async () => {
  await withTestChurchDb(async (churchId) => {
    const gatheringTypeId = await seedGathering(churchId, 'Sunday Service');
    // The individual is already on the roster via a manual addition (no owning
    // batch). A different, newly-run batch now also considers them eligible.
    const individualId = await seedIndividual(churchId, 'Manually', 'Added');
    await seedGatheringListRow(churchId, gatheringTypeId, individualId, null);

    const newBatchId = await seedBatch(churchId, 'Batch C');
    const plan = emptyPlan({ gatheringEligible: [{ individualId, pcoId: 'p1' }] });
    const batchConfig = {
      batchId: newBatchId,
      defaultPeopleType: 'regular',
      gatheringTypeId,
      gatheringAutoRemoveEnabled: true,
    };

    const result = await applyPlan(churchId, plan, null, {}, batchConfig);

    assert.strictEqual(result.errors.length, 0, `expected no errors, got: ${JSON.stringify(result.errors)}`);
    // ON CONFLICT DO NOTHING means the existing row's affectedRows is 0, so
    // this must NOT be counted as a fresh assignment.
    assert.strictEqual(result.gatheringAssigned, 0);

    const row = await getGatheringListRow(churchId, gatheringTypeId, individualId);
    assert.ok(row, 'row should still be present');
    assert.strictEqual(row.added_by_pco_batch_id, null, 'ownership must not be reassigned to the new batch by an insert attempt');
  });
});

// ─── Task 9: PCO apply dual-writes into the generic external_person_links /
// external_family_links tables and (for gathering provenance)
// added_by_sync_batch_id, alongside the legacy individuals.planning_center_id /
// families.planning_center_id / added_by_pco_batch_id columns it has always
// written. These must never diverge — a "reviewed" apply (auto-match or a
// reviewer's manual pick) links a person in both places. ─────────────────────

test('applyPlan (link): writes both external_person_links and individuals.planning_center_id', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId, 'Ada', 'Lovelace');
    const plan = emptyPlan({ link: [{ individualId, pcoId: 'pco-ada-1' }] });

    const result = await applyPlan(churchId, plan, null, {}, {});

    assert.strictEqual(result.errors.length, 0, `expected no errors, got: ${JSON.stringify(result.errors)}`);
    assert.strictEqual(result.linked, 1);

    const individualRows = await Database.query(
      'SELECT planning_center_id FROM individuals WHERE id = ? AND church_id = ?', [individualId, churchId]
    );
    assert.strictEqual(individualRows[0].planning_center_id, 'pco-ada-1');

    const linkRows = await Database.query(
      `SELECT * FROM external_person_links WHERE church_id = ? AND provider = 'planning_center' AND individual_id = ?`,
      [churchId, individualId]
    );
    assert.strictEqual(linkRows.length, 1);
    assert.strictEqual(linkRows[0].external_person_id, 'pco-ada-1');
    assert.strictEqual(linkRows[0].link_source, 'matched');
  });
});

test('applyPlan (ambiguous manual link): writes external_person_links with link_source "manual"', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId, 'Manual', 'Pick');
    const plan = emptyPlan({ ambiguous: [{ individualId, candidates: [] }] });
    const selections = { ambiguous: { [individualId]: 'pco-manual-1' } };

    const result = await applyPlan(churchId, plan, null, selections, {});

    assert.strictEqual(result.errors.length, 0, `expected no errors, got: ${JSON.stringify(result.errors)}`);
    assert.strictEqual(result.linked, 1);

    const individualRows = await Database.query(
      'SELECT planning_center_id FROM individuals WHERE id = ? AND church_id = ?', [individualId, churchId]
    );
    assert.strictEqual(individualRows[0].planning_center_id, 'pco-manual-1');

    const linkRows = await Database.query(
      `SELECT * FROM external_person_links WHERE church_id = ? AND provider = 'planning_center' AND individual_id = ?`,
      [churchId, individualId]
    );
    assert.strictEqual(linkRows.length, 1);
    assert.strictEqual(linkRows[0].link_source, 'manual');
  });
});

test('applyPlan (add): writes external_family_links and external_person_links for newly created household members', async () => {
  await withTestChurchDb(async (churchId) => {
    const plan = emptyPlan({
      add: [
        { pcoId: 'p-parent', householdId: 'house-1', firstName: 'Grace', lastName: 'Hopper', isChild: false },
        { pcoId: 'p-child', householdId: 'house-1', firstName: 'Junior', lastName: 'Hopper', isChild: true },
      ],
    });

    const result = await applyPlan(churchId, plan, null, {}, { defaultPeopleType: 'regular' });

    assert.strictEqual(result.errors.length, 0, `expected no errors, got: ${JSON.stringify(result.errors)}`);
    assert.strictEqual(result.added, 2);

    const familyLinkRows = await Database.query(
      `SELECT * FROM external_family_links WHERE church_id = ? AND provider = 'planning_center' AND external_family_id = ?`,
      [churchId, 'house-1']
    );
    assert.strictEqual(familyLinkRows.length, 1);
    assert.strictEqual(familyLinkRows[0].link_source, 'created');

    const personLinkRows = await Database.query(
      `SELECT * FROM external_person_links WHERE church_id = ? AND provider = 'planning_center' ORDER BY external_person_id`,
      [churchId]
    );
    assert.strictEqual(personLinkRows.length, 2);
    assert.deepEqual(personLinkRows.map((r) => r.external_person_id).sort(), ['p-child', 'p-parent']);
    assert.ok(personLinkRows.every((r) => r.link_source === 'created'));
  });
});

test('applyPlan (gathering assignment): writes both generic and legacy PCO provenance for a legacy-backed batch', async () => {
  await withTestChurchDb(async (churchId) => {
    const gatheringTypeId = await seedGathering(churchId, 'Sunday Service');
    const legacyBatchId = await seedBatch(churchId, 'Batch A');
    const syncBatchId = await seedGenericBatchForLegacy(churchId, legacyBatchId, gatheringTypeId);
    const individualId = await seedIndividual(churchId, 'Provenance', 'Test');

    const plan = emptyPlan({ gatheringEligible: [{ individualId, pcoId: 'p1' }] });
    const batchConfig = {
      batchId: legacyBatchId,
      syncBatchId,
      defaultPeopleType: 'regular',
      gatheringTypeId,
      gatheringAutoRemoveEnabled: false,
    };

    const result = await applyPlan(churchId, plan, null, {}, batchConfig);

    assert.strictEqual(result.errors.length, 0, `expected no errors, got: ${JSON.stringify(result.errors)}`);
    assert.strictEqual(result.gatheringAssigned, 1);

    const row = await getGatheringListRow(churchId, gatheringTypeId, individualId);
    assert.ok(row);
    assert.strictEqual(row.added_by_pco_batch_id, legacyBatchId, 'legacy provenance column should still be set');
    assert.strictEqual(row.added_by_sync_batch_id, syncBatchId, 'generic provenance column should also be set');
  });
});

test('applyPlan: result object retains the current summary field set', async () => {
  await withTestChurchDb(async (churchId) => {
    const result = await applyPlan(churchId, emptyPlan(), null, {}, {});
    assert.deepEqual(Object.keys(result).sort(), [
      'added', 'archived', 'backgroundCheckSynced', 'errors', 'familyNamesUpdated',
      'gatheringAssigned', 'gatheringRemoved', 'linked', 'reactivated', 'updated',
    ].sort());
  });
});

test('applyPlan: a background-check sync failure is isolated — pushed to errors, does not abort the rest of the run', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId, 'Isolated', 'Case');

    // A malformed pcoPeople entry (null) makes syncBackgroundCheckStatuses throw
    // partway through its internal loop (it has no try/catch of its own — see
    // backgroundCheckSync.js). This is a real, reproducible failure mode, not a
    // mock: applyPlan must catch it and keep going with every other operation
    // in the same run, the same way a link/add/archive failure would.
    const plan = emptyPlan({
      update: [{ individualId, firstName: 'Isolated', lastName: 'Renamed', isChild: false }],
      pcoPeople: [null],
    });

    const result = await applyPlan(churchId, plan, null, {}, {});

    assert.strictEqual(result.backgroundCheckSynced, 0, 'should stay at its initialized value when the sync call fails');
    assert.strictEqual(result.updated, 1, 'other operations in the same run must still complete');
    const bgErrors = result.errors.filter((e) => e.type === 'backgroundCheckSync');
    assert.strictEqual(bgErrors.length, 1, `expected exactly one backgroundCheckSync error, got: ${JSON.stringify(result.errors)}`);
  });
});
