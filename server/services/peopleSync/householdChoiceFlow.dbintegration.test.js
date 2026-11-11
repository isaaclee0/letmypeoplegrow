'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const connectionStore = require('./connectionStore');
const batchRepository = require('./batchRepository');
const { digestSourceIdentity } = require('./sourceModel');
const orchestrator = require('./orchestrator');

process.env.SYNC_REVIEW_SECRET ||= 'household-choice-integration-secret';
process.env.INTEGRATION_CREDENTIALS_KEY ||= Buffer.alloc(32, 5).toString('base64');

async function fixture(churchId) {
  await connectionStore.upsertConnection({ churchId, provider: 'planning_center', authType: 'oauth',
    credentials: { accessToken: 'offline-test-token' }, connectedBy: null, metadata: {} });
  await Database.query('UPDATE people_sync_settings SET authority_provider = ? WHERE church_id = ?', ['planning_center', churchId]);
  for (const [id, name, external] of [[10, 'First local family', 'a'], [20, 'Second local family', 'b']]) {
    await Database.query('INSERT INTO families (id, church_id, family_name, planning_center_id) VALUES (?, ?, ?, ?)', [id, churchId, name, external]);
    await Database.query("INSERT INTO external_family_links (church_id, provider, external_family_id, family_id, link_source) VALUES (?, 'planning_center', ?, ?, 'manual')", [churchId, external, id]);
  }
  for (const [id, external, firstName] of [[1, 'alex', 'Alex'], [2, 'blair', 'Blair'], [3, 'casey', 'Casey']]) {
    await Database.query("INSERT INTO individuals (id, church_id, first_name, last_name, family_id, planning_center_id, people_type) VALUES (?, ?, ?, 'Example', 10, ?, 'regular')", [id, churchId, firstName, external]);
    await Database.query("INSERT INTO external_person_links (church_id, provider, external_person_id, individual_id, link_source) VALUES (?, 'planning_center', ?, ?, 'manual')", [churchId, external, id]);
  }
  const source = { kind: 'planning_center_list', externalId: 'list', name: 'Sunday' };
  const created = await batchRepository.createBatch({ churchId, provider: 'planning_center', name: 'Sunday', initialDraftSource: source });
  const batch = await batchRepository.promoteSourceDraftWithConnection(Database.getChurchDb(churchId), {
    churchId, provider: 'planning_center', batchId: created.id,
    expectedBaseRevision: created.draftSourceBaseRevision, expectedDraftDigest: digestSourceIdentity(created.draftSource),
  });
  const person = (id, firstName, householdIds) => ({ id, firstName, lastName: 'Example', familyId: householdIds[0], householdIds, state: 'active', child: false });
  const snapshot = {
    provider: 'planning_center', source, complete: true, fetchedAt: '2026-11-07T01:00:00.000Z', providerRefreshedAt: null,
    memberExternalIds: ['alex', 'blair', 'casey'],
    people: [person('alex', 'Alex', ['a', 'b']), person('blair', 'Blair', ['a', 'b']), person('casey', 'Casey', ['a'])],
    contextPeople: [person('outside', 'Outside', ['b'])],
    families: [
      { id: 'a', name: 'Same household name', memberExternalIds: ['alex', 'blair', 'casey'], householdMemberExternalIds: ['alex', 'blair', 'casey'] },
      { id: 'b', name: 'Same household name', memberExternalIds: ['alex', 'blair', 'outside'], householdMemberExternalIds: ['alex', 'blair', 'outside'] },
    ],
  };
  const deps = {
    getProvider: () => ({ fetchSourceSnapshot: async () => snapshot, isLifecycleEligible: (p) => p.state === 'active' }),
    refreshBackgroundCheckStatuses: async () => ({}), refreshMedicalNoteStatuses: async () => ({}),
  };
  const input = { churchId, provider: 'planning_center', batchId: batch.id, trigger: 'manual' };
  return { input, deps, snapshot };
}

function selections(review) {
  return { decisionContractVersion: 2, identityDecisions: {}, householdChoices: review.plan.householdChoices.edits,
    acceptFamilyResolutionIds: [] };
}
const placements = (churchId) => Database.query('SELECT id, family_id FROM individuals WHERE church_id = ? ORDER BY id', [churchId]);
const prefs = (churchId) => Database.query('SELECT external_person_id, individual_id, family_id FROM people_sync_local_households WHERE church_id = ? ORDER BY external_person_id', [churchId]);
async function preview(input, deps, edit) {
  const base = await orchestrator.buildReview(input, deps);
  assert.equal(base.plan.householdChoices.version, 2);
  const group = base.plan.householdChoices.groups[0];
  return orchestrator.previewHouseholdChoices({ ...input, baseReviewToken: base.reviewToken,
    householdChoices: { [group.id]: edit } }, deps);
}

function changePcoHouseholds(snapshot) {
  for (const person of snapshot.people.slice(0, 2)) {
    person.familyId = 'changed'; person.householdIds = ['changed'];
  }
  snapshot.families = [
    { id: 'a', name: 'Original', memberExternalIds: ['casey'] },
    { id: 'changed', name: 'PCO changed', memberExternalIds: ['alex', 'blair'] },
  ];
}

test('unchanged multiple PCO households respect a signed keep but marriage produces a fresh reviewed move', async () => {
  await withTestChurchDb(async (churchId) => {
    const { input, deps, snapshot } = await fixture(churchId);
    const base = await orchestrator.buildReview(input, deps);
    assert.equal(base.plan.householdChoices.groups.length, 1);
    assert.equal(base.plan.familyConflicts.length, 0);
    assert.deepEqual(base.plan.householdChoices.groups[0].selectedDestination, { kind: 'keep' });
    const reviewed = await preview(input, deps, { destination: { kind: 'keep' } });
    assert.equal((await prefs(churchId)).length, 0, 'preview never saves preferences');
    const applied = await orchestrator.applyReviewed({ ...input, reviewToken: reviewed.reviewToken, selections: selections(reviewed) }, deps);
    assert.notEqual(applied.refreshRequired, true);
    assert.equal((await prefs(churchId)).length, 2);
    const unchanged = await orchestrator.buildReview(input, deps);
    assert.equal(unchanged.plan.familyConflicts.length, 0);
    changePcoHouseholds(snapshot);
    const next = await orchestrator.buildReview(input, deps);
    assert.ok(next.plan.householdChoices.groups[0].sourceChanged);
    const marriage = next.plan.familyConflicts.find(a => a.externalFamilyId === 'changed');
    assert.equal(marriage.resolution.moves.length, 2);
    await orchestrator.runUnattended({ ...input, trigger: 'scheduled' }, { ...deps, getUnattendedProviderEnabled: async () => true, notifyReviewRequired: async () => ({}) });
    assert.deepEqual((await placements(churchId)).map(p => p.family_id), [10, 10, 10], 'PCO changes remain review-required');
    await orchestrator.applyReviewed({ ...input, reviewToken: next.reviewToken,
      selections: { ...selections(next), acceptFamilyResolutionIds: [marriage.id] } }, deps);
    const moved = await placements(churchId);
    assert.notEqual(moved[0].family_id, 10);
    assert.equal(moved[1].family_id, moved[0].family_id);
    assert.equal(moved[2].family_id, 10);
    const afterMarriage = await orchestrator.buildReview(input, deps);
    assert.equal(afterMarriage.plan.familyConflicts.length, 0);
    assert.equal(afterMarriage.plan.householdChoices.groups[0].invalidReason, null);
    assert.ok((await prefs(churchId)).every(p => p.family_id === moved[0].family_id));
  });
});

test('a local existing household can be selected independently of its PCO ownership without claiming a provider link', async () => {
  await withTestChurchDb(async (churchId) => {
    const { input, deps, snapshot } = await fixture(churchId);
    await Database.query("UPDATE families SET planning_center_id = 'unrelated-pco' WHERE church_id = ? AND id = 20", [churchId]);
    const linksBefore = await Database.query('SELECT * FROM external_family_links WHERE church_id = ? ORDER BY id', [churchId]);
    const reviewed = await preview(input, deps, { destination: { kind: 'existing', familyId: 20 }, displayName: 'Our local household' });
    assert.deepEqual((await placements(churchId)).map(p => p.family_id), [10, 10, 10]);
    await orchestrator.applyReviewed({ ...input, reviewToken: reviewed.reviewToken, selections: selections(reviewed) }, deps);
    assert.deepEqual((await placements(churchId)).map(p => p.family_id), [20, 20, 10]);
    assert.equal((await Database.query('SELECT family_name FROM families WHERE church_id = ? AND id = 20', [churchId]))[0].family_name, 'Our local household');
    assert.deepEqual(await Database.query('SELECT * FROM external_family_links WHERE church_id = ? ORDER BY id', [churchId]), linksBefore);
    assert.ok((await prefs(churchId)).every(p => p.family_id === 20));
    const next = await orchestrator.buildReview(input, deps);
    assert.equal(next.plan.familyConflicts.length, 0);
    assert.equal(next.plan.householdChoices.groups[0].displayName, 'Our local household');
  });
});

test('creating a local household moves only the card members, creates no provider link, and is remembered', async () => {
  await withTestChurchDb(async (churchId) => {
    const { input, deps } = await fixture(churchId);
    const reviewed = await preview(input, deps, { destination: { kind: 'create' }, displayName: 'New local household' });
    await orchestrator.applyReviewed({ ...input, reviewToken: reviewed.reviewToken, selections: selections(reviewed) }, deps);
    const [family] = await Database.query("SELECT id, planning_center_id FROM families WHERE church_id = ? AND family_name = 'New local household'", [churchId]);
    assert.ok(family.id);
    assert.equal(family.planning_center_id, null);
    assert.deepEqual((await placements(churchId)).map(p => p.family_id), [family.id, family.id, 10]);
    assert.equal((await Database.query('SELECT COUNT(*) n FROM external_family_links WHERE church_id = ?', [churchId]))[0].n, 2);
    assert.equal((await placements(churchId)).length, 3, 'outside-source relatives were not imported');
    assert.ok((await prefs(churchId)).every(p => p.family_id === family.id));
    const next = await orchestrator.buildReview(input, deps);
    assert.equal(next.plan.familyConflicts.length, 0);
  });
});

test('a keep can rename the existing local household without selecting PCO and forgetting never moves people', async () => {
  await withTestChurchDb(async (churchId) => {
    const { input, deps } = await fixture(churchId);
    const renamed = await preview(input, deps, { destination: { kind: 'keep' }, displayName: 'Local display name' });
    await orchestrator.applyReviewed({ ...input, reviewToken: renamed.reviewToken, selections: selections(renamed) }, deps);
    assert.equal((await Database.query('SELECT family_name FROM families WHERE church_id = ? AND id = 10', [churchId]))[0].family_name, 'Local display name');
    const forgotten = await preview(input, deps, { destination: { kind: 'forget' } });
    await orchestrator.applyReviewed({ ...input, reviewToken: forgotten.reviewToken, selections: selections(forgotten) }, deps);
    assert.equal((await prefs(churchId)).length, 0);
    assert.deepEqual((await placements(churchId)).map(p => p.family_id), [10, 10, 10]);
  });
});

test('tampering, stale PCO evidence and foreign-church targets cannot apply a local choice', async () => {
  await withTestChurchDb(async (churchId) => {
    const { input, deps, snapshot } = await fixture(churchId);
    const reviewed = await preview(input, deps, { destination: { kind: 'existing', familyId: 20 } });
    const id = Object.keys(reviewed.plan.householdChoices.edits)[0];
    await assert.rejects(orchestrator.applyReviewed({ ...input, reviewToken: reviewed.reviewToken,
      selections: { ...selections(reviewed), householdChoices: { [id]: { destination: { kind: 'keep' } } } } }, deps), { code: 'SYNC_PLAN_STALE' });
    const foreign = await Database.query("INSERT INTO families (church_id, family_name) VALUES ('another-church', 'Foreign')");
    await assert.rejects(preview(input, deps, { destination: { kind: 'existing', familyId: foreign.insertId } }), { code: 'SYNC_SELECTIONS_INVALID' });
    changePcoHouseholds(snapshot);
    await assert.rejects(orchestrator.applyReviewed({ ...input, reviewToken: reviewed.reviewToken, selections: selections(reviewed) }, deps),
      e => ['SYNC_PLAN_STALE', 'SYNC_SELECTIONS_INVALID'].includes(e.code));
    assert.equal((await prefs(churchId)).length, 0);
    assert.deepEqual((await placements(churchId)).map(p => p.family_id), [10, 10, 10]);
  });
});

test('a local placement race rolls back every choice and the review claim', async () => {
  await withTestChurchDb(async (churchId) => {
    const { input, deps } = await fixture(churchId);
    const reviewed = await preview(input, deps, { destination: { kind: 'existing', familyId: 20 }, displayName: 'Reviewed name' });
    const { applyPeopleSyncPlan } = require('./apply');
    await assert.rejects(orchestrator.applyReviewed({ ...input, reviewToken: reviewed.reviewToken,
      selections: selections(reviewed) }, { ...deps, applyPeopleSyncPlan: async args => {
        await Database.query('UPDATE individuals SET family_id = 20 WHERE church_id = ? AND id = 1', [churchId]);
        return applyPeopleSyncPlan(args);
      } }), { code: 'SYNC_PLAN_STALE' });
    assert.equal((await prefs(churchId)).length, 0);
    assert.equal((await Database.query('SELECT family_name FROM families WHERE church_id = ? AND id = 20', [churchId]))[0].family_name, 'Second local family');
    await Database.query('UPDATE individuals SET family_id = 10 WHERE church_id = ? AND id = 1', [churchId]);
    await orchestrator.applyReviewed({ ...input, reviewToken: reviewed.reviewToken, selections: selections(reviewed) }, deps);
    assert.equal((await prefs(churchId)).length, 2);
  });
});

test('two cards can choose and rename the same local household in one apply', async () => {
  await withTestChurchDb(async (churchId) => {
    const { input, deps, snapshot } = await fixture(churchId);
    snapshot.people[1].householdIds.push('c');
    snapshot.families.push({ id: 'c', name: 'Third provider household', memberExternalIds: ['blair'], householdMemberExternalIds: ['blair'] });
    const base = await orchestrator.buildReview(input, deps);
    assert.equal(base.plan.householdChoices.groups.length, 2);
    const householdChoices = Object.fromEntries(base.plan.householdChoices.groups.map(g => [g.id,
      { destination: { kind: 'existing', familyId: 20 }, displayName: 'Shared local family' }]));
    const reviewed = await orchestrator.previewHouseholdChoices({ ...input, baseReviewToken: base.reviewToken, householdChoices }, deps);
    await orchestrator.applyReviewed({ ...input, reviewToken: reviewed.reviewToken, selections: selections(reviewed) }, deps);
    assert.deepEqual((await placements(churchId)).map(p => p.family_id), [20, 20, 10]);
    assert.equal((await Database.query('SELECT family_name FROM families WHERE church_id = ? AND id = 20', [churchId]))[0].family_name, 'Shared local family');
    assert.equal((await prefs(churchId)).length, 2);
  });
});

test('accepting a changed PCO household refreshes saved members already at its destination too', async () => {
  await withTestChurchDb(async (churchId) => {
    const { input, deps, snapshot } = await fixture(churchId);
    await Database.query('UPDATE individuals SET family_id = 20 WHERE church_id = ? AND id = 2', [churchId]);
    const kept = await preview(input, deps, { destination: { kind: 'keep' } });
    await orchestrator.applyReviewed({ ...input, reviewToken: kept.reviewToken, selections: selections(kept) }, deps);
    for (const person of snapshot.people.slice(0, 2)) { person.householdIds = ['b']; person.familyId = 'b'; }
    snapshot.families[0].memberExternalIds = ['casey'];
    snapshot.families[0].householdMemberExternalIds = ['casey'];
    const changed = await orchestrator.buildReview(input, deps);
    const action = changed.plan.familyConflicts.find(a => a.externalFamilyId === 'b');
    assert.equal(action.resolution.moves.length, 1);
    await orchestrator.applyReviewed({ ...input, reviewToken: changed.reviewToken,
      selections: { ...selections(changed), acceptFamilyResolutionIds: [action.id] } }, deps);
    const next = await orchestrator.buildReview(input, deps);
    assert.equal(next.plan.householdChoices.groups[0].invalidReason, null);
    assert.equal(next.plan.familyConflicts.length, 0);
  });
});
