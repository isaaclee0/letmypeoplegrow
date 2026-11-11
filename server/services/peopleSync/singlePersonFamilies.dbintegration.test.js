'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { applyPeopleSyncPlan } = require('./apply');
const { computePeopleSyncPlan } = require('./plan');
const { loadLocalProjectionState } = require('./localProjectionState');
const { buildReviewContext } = require('./reviewContext');
const { digestPlan, createReviewToken, verifyReviewToken } = require('./planDigest');

process.env.SYNC_REVIEW_SECRET ||= 'single-person-family-test-secret';
const provider = 'planning_center';
const betty = { id: 'betty', firstName: 'Betty', lastName: 'Bultman', state: 'active', familyId: null, householdIds: [] };

async function seed(churchId, linked = true) {
  await Database.query(`INSERT INTO people_sync_settings (church_id, authority_provider) VALUES (?, ?) ON CONFLICT(church_id) DO UPDATE SET authority_provider = excluded.authority_provider`, [churchId, provider]);
  await Database.query(`INSERT INTO gathering_types (id, church_id, name) VALUES (100, ?, 'AM')`, [churchId]);
  await Database.query(`INSERT INTO people_sync_batches (id, church_id, provider, name, gathering_type_id, source_kind, source_external_id, source_name) VALUES (7, ?, ?, 'AM', 100, 'planning_center_list', 'am', 'AM')`, [churchId, provider]);
  if (linked) {
    await Database.query(`INSERT INTO individuals (id, church_id, first_name, last_name, planning_center_id) VALUES (1, ?, 'Betty', 'Bultman', 'betty')`, [churchId]);
    await Database.query(`INSERT INTO external_person_links (church_id, provider, external_person_id, individual_id, link_source) VALUES (?, ?, 'betty', 1, 'manual')`, [churchId, provider]);
    await Database.query(`INSERT INTO gathering_lists (church_id, gathering_type_id, individual_id, added_by_sync_batch_id) VALUES (?, 100, 1, 7)`, [churchId]);
  }
}

function sign(churchId, plan) {
  const planDigest = digestPlan(plan);
  return { operationKind: 'people_sync', planDigest, batchId: 7, verifyReviewToken,
    reviewToken: createReviewToken({ operationKind: 'people_sync', churchId, provider, batchId: 7, planDigest, expiresInSeconds: 1800 }) };
}

async function request(churchId, { people = [betty], families = [], matcher, completeSnapshot = true } = {}) {
  const state = await loadLocalProjectionState(churchId, provider);
  const batches = [{ id: 7, enabled: true, gatheringTypeId: 100, source: { kind: 'planning_center_list', externalId: 'am', name: 'AM' } }];
  const eligibleByBatch = new Map([[7, new Set(people.map(p => p.id))]]);
  const input = {
    provider, authoritative: true, snapshot: { mode: 'full', complete: completeSnapshot },
    externalPeople: people, externalFamilies: families,
    localPeople: state.individuals, localFamilies: state.families,
    personLinks: state.personLinks, familyLinks: state.familyLinks, gatheringMemberships: state.gatheringMemberships,
    batches, eligibleByBatch, memberIdsByBatch: eligibleByBatch,
    matcher: matcher || { linked: state.personLinks, unmatchedExternalIds: people.filter(p => !state.personLinks.some(l => l.externalPersonId === p.id)).map(p => p.id) },
  };
  const plan = computePeopleSyncPlan(input);
  plan.reviewContext = buildReviewContext({ ...input, plan, completeSnapshot,
    basePersonLinks: state.personLinks, projectedPersonLinks: state.personLinks,
    sourceExternalIds: new Set(people.map(p => p.id)), baseExclusions: [], baseHolds: [] });
  return { churchId, provider, plan, selections: { decisionContractVersion: 2, identityDecisions: {} }, reviewedApply: sign(churchId, plan) };
}

const rows = (churchId, sql, params = []) => Database.query(sql, [churchId, ...params]);

test('selected personal family is local-only, repeat sync is quiet, and manual display names survive', async () => {
  await withTestChurchDb(async churchId => {
    await seed(churchId);
    const first = await request(churchId);
    first.selections.acceptFamilyResolutionIds = [first.plan.familyConflicts[0].id];
    const result = await applyPeopleSyncPlan(first);
    assert.equal(result.addFamilies, 1);
    assert.equal(result.moveFamily, 1);
    const [family] = await rows(churchId, 'SELECT f.id, f.family_name, f.planning_center_id FROM families f JOIN individuals i ON i.family_id = f.id AND i.church_id = f.church_id WHERE i.church_id = ? AND i.id = 1');
    assert.equal(family.family_name, 'BULTMAN, Betty');
    assert.equal(family.planning_center_id, null);
    assert.equal((await rows(churchId, 'SELECT COUNT(*) n FROM external_family_links WHERE church_id = ?'))[0].n, 0);
    assert.equal((await rows(churchId, 'SELECT COUNT(*) n FROM people_sync_local_households WHERE church_id = ?'))[0].n, 0);
    await Database.query('UPDATE families SET family_name = ? WHERE church_id = ? AND id = ?', ['Betty at home', churchId, family.id]);
    const repeat = await request(churchId);
    assert.deepEqual(repeat.plan.familyConflicts, []);
    assert.deepEqual(repeat.plan.addFamilies, []);
    await applyPeopleSyncPlan(repeat);
    assert.deepEqual(await rows(churchId, 'SELECT id, family_name FROM families WHERE church_id = ?'), [{ id: family.id, family_name: 'Betty at home' }]);
  });
});

test('namesakes get separate personal families in the same sync as creation and gathering assignment', async () => {
  await withTestChurchDb(async churchId => {
    await seed(churchId, false);
    const review = await request(churchId, { people: [betty, { ...betty, id: 'namesake' }] });
    review.selections.identityDecisions = { betty: { outcome: 'create' }, namesake: { outcome: 'create' } };
    const result = await applyPeopleSyncPlan(review);
    assert.equal(result.addFamilies, 2);
    assert.equal(result.addPeople, 2);
    const people = await rows(churchId, 'SELECT family_id FROM individuals WHERE church_id = ? ORDER BY id');
    assert.equal(new Set(people.map(p => p.family_id)).size, 2);
    assert.ok(people.every(p => p.family_id !== null));
    assert.equal((await rows(churchId, 'SELECT COUNT(*) n FROM gathering_lists WHERE church_id = ?'))[0].n, 2);
    assert.equal((await rows(churchId, 'SELECT COUNT(*) n FROM external_family_links WHERE church_id = ?'))[0].n, 0);
    const repeat = await request(churchId, { people: [betty, { ...betty, id: 'namesake' }] });
    assert.deepEqual(repeat.plan.addFamilies, []);
    assert.deepEqual(repeat.plan.familyConflicts, []);
  });
});

test('deferred creation produces no orphan personal family', async () => {
  await withTestChurchDb(async churchId => {
    await seed(churchId, false);
    const review = await request(churchId);
    review.selections.identityDecisions = { betty: { outcome: 'defer' } };
    const result = await applyPeopleSyncPlan(review);
    assert.equal(result.addFamilies, 0);
    assert.equal((await rows(churchId, 'SELECT COUNT(*) n FROM families WHERE church_id = ?'))[0].n, 0);
    assert.equal((await rows(churchId, 'SELECT COUNT(*) n FROM individuals WHERE church_id = ?'))[0].n, 0);
  });
});

test('Create from an ambiguous identity uses its signed default without claiming the candidate', async () => {
  await withTestChurchDb(async churchId => {
    await seed(churchId, false);
    await Database.query(`INSERT INTO individuals (id, church_id, first_name, last_name) VALUES (1, ?, 'Betty', 'Bultman')`, [churchId]);
    const review = await request(churchId, { matcher: { ambiguous: [{ externalPersonId: 'betty', candidateIndividualIds: [1] }] } });
    assert.deepEqual(review.plan.addFamilies, []);
    review.selections.identityDecisions = { betty: { outcome: 'create' } };
    await applyPeopleSyncPlan(review);
    const people = await rows(churchId, 'SELECT id, family_id, planning_center_id FROM individuals WHERE church_id = ? ORDER BY id');
    assert.equal(people[0].family_id, null);
    assert.equal(people[0].planning_center_id, null);
    assert.ok(people[1].family_id);
    assert.equal(people[1].planning_center_id, 'betty');
    assert.equal((await rows(churchId, 'SELECT family_name FROM families WHERE church_id = ?'))[0].family_name, 'BULTMAN, Betty');
  });
});

test('a subsequent real PCO household moves the person out of the default family through normal review', async () => {
  await withTestChurchDb(async churchId => {
    await seed(churchId);
    const first = await request(churchId);
    first.selections.acceptFamilyResolutionIds = [first.plan.familyConflicts[0].id];
    await applyPeopleSyncPlan(first);
    const [old] = await rows(churchId, 'SELECT family_id FROM individuals WHERE church_id = ? AND id = 1');
    await Database.query(`INSERT INTO families (id, church_id, family_name, planning_center_id) VALUES (20, ?, 'Smith household', 'married')`, [churchId]);
    await Database.query(`INSERT INTO individuals (id, church_id, first_name, last_name, family_id, planning_center_id) VALUES (2, ?, 'Sam', 'Smith', 20, 'sam')`, [churchId]);
    await Database.query(`INSERT INTO external_person_links (church_id, provider, external_person_id, individual_id, link_source) VALUES (?, ?, 'sam', 2, 'manual')`, [churchId, provider]);
    await Database.query(`INSERT INTO external_family_links (church_id, provider, external_family_id, family_id, link_source) VALUES (?, ?, 'married', 20, 'manual')`, [churchId, provider]);
    const people = [{ ...betty, familyId: 'married', householdIds: ['married'] }, { id: 'sam', firstName: 'Sam', lastName: 'Smith', state: 'active', familyId: 'married', householdIds: ['married'] }];
    const review = await request(churchId, { people, families: [{ id: 'married', name: 'Smith household', memberExternalIds: ['betty', 'sam'] }] });
    assert.equal(review.plan.familyConflicts[0].resolution.kind, 'household');
    review.selections.acceptFamilyResolutionIds = [review.plan.familyConflicts[0].id];
    await applyPeopleSyncPlan(review);
    assert.equal((await rows(churchId, 'SELECT family_id FROM individuals WHERE church_id = ? AND id = 1'))[0].family_id, 20);
    assert.equal((await rows(churchId, 'SELECT COUNT(*) n FROM families WHERE church_id = ? AND id = ?', [old.family_id]))[0].n, 1);
  });
});

for (const scenario of ['changed-family', 'foreign-person', 'unsigned']) {
  test(`personal family ${scenario} is rejected atomically`, async () => {
    await withTestChurchDb(async churchId => {
      await seed(churchId);
      const review = await request(churchId);
      if (scenario === 'changed-family') {
        await Database.query(`INSERT INTO families (id, church_id, family_name) VALUES (10, ?, 'Changed')`, [churchId]);
        await Database.query('UPDATE individuals SET family_id = 10 WHERE church_id = ? AND id = 1', [churchId]);
      }
      if (scenario === 'foreign-person') {
        await Database.query(`INSERT INTO individuals (id, church_id, first_name, last_name) VALUES (90, 'other-church', 'Private', 'Person')`);
        review.plan.familyConflicts[0].resolution.moves[0].individualId = 90;
        review.reviewedApply = sign(churchId, review.plan);
      }
      if (scenario === 'unsigned') delete review.reviewedApply;
      review.selections.acceptFamilyResolutionIds = [review.plan.familyConflicts[0].id];
      await assert.rejects(applyPeopleSyncPlan(review), /changed|stale|signed|review/i);
      assert.equal((await rows(churchId, 'SELECT COUNT(*) n FROM families WHERE church_id = ?'))[0].n, scenario === 'changed-family' ? 1 : 0);
      assert.equal((await rows(churchId, 'SELECT COUNT(*) n FROM people_sync_review_applications WHERE church_id = ?'))[0].n, 0);
    });
  });
}
