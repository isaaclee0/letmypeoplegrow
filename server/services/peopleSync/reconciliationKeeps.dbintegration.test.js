'use strict';

// "Keep LMPG as it is": apply remembers the choice, the next review honours
// it, and "Ask again" or accepting brings the difference back / clears it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { applyPeopleSyncPlan } = require('./apply');
const { computePeopleSyncPlan } = require('./plan');
const { loadLocalProjectionState } = require('./localProjectionState');
const { buildReviewContext } = require('./reviewContext');
const { digestPlan, createReviewToken, verifyReviewToken } = require('./planDigest');
const keepRepository = require('./reconciliationKeepRepository');

process.env.SYNC_REVIEW_SECRET ||= 'reconciliation-keeps-disposable-test-secret';
const provider = 'planning_center';

async function seed(churchId) {
  await Database.query(`INSERT INTO people_sync_settings (church_id, authority_provider) VALUES (?, ?) ON CONFLICT(church_id) DO UPDATE SET authority_provider = excluded.authority_provider`, [churchId, provider]);
  for (const [id, name] of [[10, 'First'], [20, 'Second']]) {
    await Database.query(`INSERT INTO families (id, church_id, family_name) VALUES (?, ?, ?)`, [id, churchId, name]);
  }
  for (const [id, name, familyId] of [[1, 'Bruce', 10], [2, 'Bronwyn', 20]]) {
    await Database.query(`INSERT INTO individuals (id, church_id, first_name, last_name, family_id) VALUES (?, ?, ?, 'Smith', ?)`, [id, churchId, name, familyId]);
  }
  for (const [id, external] of [[1, 'bruce'], [2, 'bronwyn']]) {
    await Database.query(`INSERT INTO external_person_links (church_id, provider, external_person_id, individual_id, link_source) VALUES (?, ?, ?, ?, 'manual')`, [churchId, provider, external, id]);
  }
  await Database.query(`INSERT INTO gathering_types (id, church_id, name) VALUES (100, ?, 'Sunday'), (200, ?, 'Midweek')`, [churchId, churchId]);
  await Database.query(`INSERT INTO people_sync_batches (id, church_id, provider, name, gathering_type_id, source_kind, source_external_id, source_name) VALUES (7, ?, ?, 'Sunday list', 100, 'planning_center_list', 'list', 'Sunday list')`, [churchId, provider]);
  await Database.query(`INSERT INTO people_sync_batches (id, church_id, provider, name, gathering_type_id, source_kind, source_external_id, source_name) VALUES (8, ?, ?, 'Members', 200, 'planning_center_list', 'members', 'Members')`, [churchId, provider]);
  await Database.query(`INSERT INTO gathering_lists (church_id, gathering_type_id, individual_id) VALUES (?, 100, 1)`, [churchId]);
  const user = await Database.query(`INSERT INTO users (church_id, email, role) VALUES (?, 'keeper@example.test', 'admin')`, [churchId]);
  return user.insertId;
}

// Bruce and Bronwyn share a Planning Center household but are in separate
// LMPG families. Both are members; only Bronwyn is on the list that feeds
// Sunday, so Bruce's older Sunday entry is offered for removal.
async function review(churchId) {
  const state = await loadLocalProjectionState(churchId, provider);
  const externalPeople = [
    { id: 'bruce', firstName: 'Bruce', lastName: 'Smith', state: 'active', familyId: 'hh', householdIds: ['hh'] },
    { id: 'bronwyn', firstName: 'Bronwyn', lastName: 'Smith', state: 'active', familyId: 'hh', householdIds: ['hh'] },
  ];
  const memberIdsByBatch = new Map([[7, new Set(['bronwyn'])], [8, new Set(['bruce', 'bronwyn'])]]);
  const plan = computePeopleSyncPlan({
    provider, authoritative: true, snapshot: { mode: 'full', complete: true },
    externalPeople, externalFamilies: [{ id: 'hh', name: 'Smith household', memberExternalIds: ['bruce', 'bronwyn'] }],
    localPeople: state.individuals, localFamilies: state.families, personLinks: state.personLinks,
    familyLinks: state.familyLinks, gatheringMemberships: state.gatheringMemberships,
    batches: [
      { id: 7, enabled: true, gatheringTypeId: 100, source: { kind: 'planning_center_list', externalId: 'list', name: 'Sunday list' } },
      { id: 8, enabled: true, gatheringTypeId: 200, source: { kind: 'planning_center_list', externalId: 'members', name: 'Members' } },
    ],
    eligibleByBatch: memberIdsByBatch, memberIdsByBatch,
    matcher: { linked: state.personLinks },
    reconciliationKeeps: state.reconciliationKeeps,
  });
  plan.reviewContext = buildReviewContext({
    plan, externalPeople, localPeople: state.individuals, localFamilies: state.families,
    basePersonLinks: state.personLinks, projectedPersonLinks: state.personLinks,
    baseExclusions: [], projectedExclusions: [], baseHolds: [], projectedHolds: [],
    sourceExternalIds: new Set(externalPeople.map(({ id }) => id)),
  });
  const planDigest = digestPlan(plan);
  const reviewToken = createReviewToken({ operationKind: 'people_sync', churchId, provider, batchId: 7, planDigest, expiresInSeconds: 1800 });
  return {
    churchId, provider, plan, selections: { decisionContractVersion: 2, identityDecisions: {} },
    reviewedApply: { operationKind: 'people_sync', reviewToken, planDigest, batchId: 7, verifyReviewToken },
  };
}

const keepRows = (churchId) => Database.query(
  `SELECT kind, subject_key, created_by FROM people_sync_reconciliation_keeps WHERE church_id = ? ORDER BY kind, subject_key`, [churchId]);

test('keeping both differences remembers them, changes nothing, and the next review leaves them out', async () => {
  await withTestChurchDb(async (churchId) => {
    const userId = await seed(churchId);
    const first = await review(churchId);
    assert.equal(first.plan.familyConflicts.length, 1);
    assert.equal(first.plan.removeFromGathering.length, 1);
    first.selections.keepReconciliationIds = [first.plan.familyConflicts[0].id, first.plan.removeFromGathering[0].id];
    await applyPeopleSyncPlan({ ...first, userId });

    assert.deepEqual((await keepRows(churchId)).map((row) => [row.kind, row.subject_key, row.created_by]), [
      ['gathering_removal', '100:1', userId],
      ['household', 'household:hh', userId],
    ]);
    const people = await Database.query(`SELECT id, family_id FROM individuals WHERE church_id = ? ORDER BY id`, [churchId]);
    assert.deepEqual(people.map((row) => [row.id, row.family_id]), [[1, 10], [2, 20]]);
    assert.equal((await Database.query(`SELECT COUNT(*) AS n FROM gathering_lists WHERE church_id = ? AND gathering_type_id = 100 AND individual_id = 1`, [churchId]))[0].n, 1);

    const next = await review(churchId);
    assert.deepEqual(next.plan.familyConflicts, []);
    assert.deepEqual(next.plan.removeFromGathering, []);
    assert.deepEqual(next.plan.keptReconciliations.map((entry) => entry.bucket).sort(), ['familyConflicts', 'removeFromGathering']);
  });
});

test('Ask again forgets one keep so its difference returns on the next review', async () => {
  await withTestChurchDb(async (churchId) => {
    await seed(churchId);
    const first = await review(churchId);
    first.selections.keepReconciliationIds = [first.plan.familyConflicts[0].id];
    await applyPeopleSyncPlan(first);
    const kept = (await review(churchId)).plan.keptReconciliations[0];

    assert.equal(await keepRepository.deleteKeep({ churchId, provider, keepId: kept.keepId }), true);
    assert.equal(await keepRepository.deleteKeep({ churchId, provider, keepId: kept.keepId }), false);
    assert.equal(await keepRepository.deleteKeep({ churchId, provider: 'elvanto', keepId: kept.keepId }), false);
    const again = await review(churchId);
    assert.equal(again.plan.familyConflicts.length, 1);
    assert.equal(again.plan.keptReconciliations, undefined);
  });
});

test('accepting a difference clears an older keep on the same subject', async () => {
  await withTestChurchDb(async (churchId) => {
    await seed(churchId);
    // A keep made against different facts no longer hides the difference.
    await Database.query(`INSERT INTO people_sync_reconciliation_keeps (church_id, provider, kind, subject_key, fingerprint) VALUES (?, ?, 'household', 'household:hh', ?)`, [churchId, provider, 'f'.repeat(64)]);
    const request = await review(churchId);
    assert.equal(request.plan.familyConflicts.length, 1);
    request.selections.acceptFamilyResolutionIds = [request.plan.familyConflicts[0].id];
    await applyPeopleSyncPlan(request);
    assert.deepEqual(await keepRows(churchId), []);
  });
});

test('keeps are only taken from a signed review', async () => {
  await withTestChurchDb(async (churchId) => {
    await seed(churchId);
    const request = await review(churchId);
    request.selections.keepReconciliationIds = [request.plan.familyConflicts[0].id];
    delete request.reviewedApply;
    await assert.rejects(() => applyPeopleSyncPlan(request), /signed review/);
    assert.deepEqual(await keepRows(churchId), []);
  });
});
