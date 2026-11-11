'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const connectionStore = require('./connectionStore');
const batchRepository = require('./batchRepository');
const authority = require('./authority');
const orchestrator = require('./orchestrator');
const { applyPeopleSyncPlan } = require('./apply');
const { digestSourceIdentity } = require('./sourceModel');
const { createReviewToken } = require('./planDigest');

process.env.SYNC_REVIEW_SECRET ||= 'integration-review-disposable-secret';
process.env.INTEGRATION_CREDENTIALS_KEY ||= Buffer.alloc(32, 5).toString('base64');
const provider = 'planning_center';
const source = (id) => ({ kind: 'planning_center_list', externalId: id, name: id });
const person = (id, firstName, lastName) => ({ id, firstName, lastName, state: 'active', child: false, familyId: null, householdIds: [] });
const snapshot = (selectedSource, people = []) => ({ provider, source: selectedSource, complete: true, fetchedAt: '2026-11-07T00:00:00Z', providerRefreshedAt: null,
  people, memberExternalIds: people.map(({ id }) => id), contextPeople: [], families: [] });

async function fixture(churchId, { drafts = true, empty = false, linked = false, initial = false } = {}) {
  await connectionStore.upsertConnection({ churchId, provider, authType: 'oauth', credentials: { accessToken: 'offline' }, connectedBy: null, metadata: {} });
  await Database.query('UPDATE people_sync_settings SET authority_provider = ? WHERE church_id = ?', [provider, churchId]);
  if (!empty) {
    await Database.query("INSERT INTO individuals(id,church_id,first_name,last_name,people_type,is_active) VALUES(1,?,'Ada','Reed','regular',1),(2,?,'Ben','Blue','regular',1)", [churchId, churchId]);
    if (linked) for (const [externalId, individualId] of [['shared', 1], ['evening-only', 2]]) {
      await Database.query("INSERT INTO external_person_links(church_id,provider,external_person_id,individual_id,link_source) VALUES(?,?,?,?, 'manual')", [churchId, provider, externalId, individualId]);
      await Database.query('UPDATE individuals SET planning_center_id = ? WHERE church_id = ? AND id = ?', [externalId, churchId, individualId]);
    }
  }
  const shared = person('shared', 'Ada', 'Reed');
  const eveningOnly = person('evening-only', 'Ben', 'Blue');
  const snapshots = new Map();
  const batches = [];
  for (const [index, name] of ['morning', 'evening'].entries()) {
    const gathering = await Database.query('INSERT INTO gathering_types(church_id,name) VALUES(?,?)', [churchId, name]);
    const activeSource = source(drafts && !initial ? `${name}-old` : name);
    const created = await batchRepository.createBatch({ churchId, provider, name, initialDraftSource: activeSource, gatheringTypeId: Number(gathering.insertId) });
    let batch = created;
    if (!initial) {
      batch = await batchRepository.promoteSourceDraftWithConnection(Database.getChurchDb(churchId), { churchId, provider, batchId: created.id,
        expectedBaseRevision: created.draftSourceBaseRevision, expectedDraftDigest: digestSourceIdentity(activeSource) });
      if (drafts) batch = await batchRepository.saveSourceDraft({ churchId, provider, batchId: batch.id, source: source(name) });
    }
    batches.push(batch);
    snapshots.set(activeSource.externalId, snapshot(activeSource, drafts && !initial ? [] : empty ? [] : index ? [shared, eveningOnly] : [shared]));
    snapshots.set(name, snapshot(source(name), empty ? [] : index ? [shared, eveningOnly] : [shared]));
  }
  const calls = [];
  let directoryReads = 0;
  const deps = { getProvider: () => ({
    fetchSourceSnapshot: async ({ sourceExternalId }) => { calls.push(sourceExternalId); return structuredClone(snapshots.get(sourceExternalId)); },
    fetchReconciliationSnapshot: async () => { directoryReads++; return snapshot({ kind: 'all', externalId: 'all', name: 'Everyone' }); },
    isLifecycleEligible: (entry) => entry.state === 'active',
  }), refreshBackgroundCheckStatuses: async () => ({}), refreshMedicalNoteStatuses: async () => ({}) };
  const input = { churchId, provider, batchId: null, trigger: 'manual' };
  return { input, deps, batches, snapshots, calls, get directoryReads() { return directoryReads; } };
}
function selections(review) {
  return { decisionContractVersion: 2, identityDecisions: Object.fromEntries(Object.entries(review.plan.reviewContext.identities)
    .map(([id, identity]) => [id, { outcome: identity.suggestedIndividualId ? 'accept' : 'create' }])) };
}
const apply = (state, review, extra = {}) => orchestrator.applyReviewed({ ...state.input, operationKind: 'people_sync', reviewToken: review.reviewToken, selections: selections(review), ...extra }, state.deps);

async function sourceRows(churchId) {
  return Database.query('SELECT id,source_external_id,draft_source_external_id,source_revision FROM people_sync_batches WHERE church_id = ? ORDER BY id', [churchId]);
}

test('integration review includes every proposed draft and presents shared identities once with both gatherings', async () => withTestChurchDb(async (churchId) => {
  const state = await fixture(churchId);
  const review = await orchestrator.buildReview(state.input, state.deps);
  assert.deepEqual(state.calls, ['morning', 'evening']);
  assert.deepEqual(Object.keys(review.plan.reviewContext.identities).sort(), ['evening-only', 'shared']);
  assert.equal(review.plan.linkPeople.filter(({ externalPersonId }) => externalPersonId === 'shared').length, 1);
  assert.equal(review.plan.addToGathering.filter(({ externalPersonId }) => externalPersonId === 'shared').length, 2);
  assert.equal(review.plan.sourceContext.promotions.length, 2);
  assert.equal(review.plan.sourceContext.requireExactBatchSet, true);
  assert.match(review.plan.sourceContext.participatingBatchSourceDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(review.plan.sourceContext.reviewedLists, state.batches.map((batch) => ({
    batchId: batch.id, name: batch.name, gatheringTypeId: batch.gatheringTypeId,
    activeSource: batch.source, selectedSource: batch.draftSource, isDraft: true,
  })));
  assert.equal(state.directoryReads, 0, 'draft source reviews cannot infer absence from settled active sources');
  const result = await apply(state, review);
  assert.equal(result.applied.linkPeople, 2);
  assert.equal((await Database.query('SELECT * FROM gathering_lists WHERE church_id = ?', [churchId])).length, 3);
  assert.deepEqual((await sourceRows(churchId)).map(({ source_external_id, draft_source_external_id }) => [source_external_id, draft_source_external_id]), [['morning', null], ['evening', null]]);
}));

test('source-only integration review signs and applies multiple initial drafts with no roster actions', async () => withTestChurchDb(async (churchId) => {
  const state = await fixture(churchId, { empty: true, initial: true });
  const review = await orchestrator.buildReview(state.input, state.deps);
  assert.deepEqual(review.plan.linkPeople, []);
  assert.deepEqual(review.plan.addPeople, []);
  assert.equal(review.plan.sourceContext.promotions.length, 2);
  await apply(state, review);
  assert.ok((await sourceRows(churchId)).every((row) => row.source_external_id && row.draft_source_external_id === null));
}));

test('combined link-correction and household previews work in null scope and cover a second-list identity', async () => withTestChurchDb(async (churchId) => {
  const state = await fixture(churchId, { linked: true });
  const base = await orchestrator.buildReview(state.input, state.deps);
  const correction = await orchestrator.previewLinkCorrections({ ...state.input, baseReviewToken: base.reviewToken,
    linkCorrections: { 'evening-only': { outcome: 'unlink', fromIndividualId: 2 } } }, state.deps);
  assert.deepEqual(correction.plan.reviewContext.linkCorrections, [{ externalPersonId: 'evening-only', outcome: 'unlink', fromIndividualId: 2 }]);
  const household = await orchestrator.previewHouseholdChoices({ ...state.input, baseReviewToken: base.reviewToken, householdChoices: {} }, state.deps);
  assert.equal(household.plan.sourceContext.promotions.length, 2);
  assert.deepEqual(household.plan.sourceContext.reviewedLists, base.plan.sourceContext.reviewedLists);
  assert.equal(household.plan.householdChoices.version, 2);
}));

test('one household decision covers overlapping list members and applies with all gathering changes', async () => withTestChurchDb(async (churchId) => {
  const state = await fixture(churchId, { linked: true });
  for (const name of ['morning', 'evening']) {
    const entry = state.snapshots.get(name);
    entry.people = entry.people.map((member) => ({ ...member, householdIds: ['a', 'b'], familyId: 'a' }));
    if (name === 'morning') entry.contextPeople = [{ ...person('evening-only', 'Ben', 'Blue'), householdIds: ['a', 'b'], familyId: 'a' }];
    entry.families = ['a', 'b'].map((id) => ({ id, name: `Household ${id}`,
      memberExternalIds: ['shared', 'evening-only'], householdMemberExternalIds: ['shared', 'evening-only'] }));
  }
  const base = await orchestrator.buildReview(state.input, state.deps);
  assert.equal(base.plan.householdChoices.groups.length, 1);
  const [group] = base.plan.householdChoices.groups;
  assert.deepEqual(group.people.map(({ externalPersonId }) => externalPersonId).sort(), ['evening-only', 'shared']);
  const householdChoices = { [group.id]: { destination: { kind: 'create' }, displayName: 'Our local family' } };
  const review = await orchestrator.previewHouseholdChoices({ ...state.input, baseReviewToken: base.reviewToken, householdChoices }, state.deps);
  assert.equal(review.plan.householdChoices.decisions.length, 1);
  await apply(state, review, { selections: { ...selections(review), householdChoices } });
  const families = await Database.query('SELECT family_id FROM individuals WHERE church_id = ? ORDER BY id', [churchId]);
  assert.ok(families[0].family_id);
  assert.equal(families[0].family_id, families[1].family_id);
  assert.equal((await Database.query('SELECT * FROM people_sync_local_households WHERE church_id = ?', [churchId])).length, 2);
  assert.equal((await Database.query('SELECT * FROM gathering_lists WHERE church_id = ?', [churchId])).length, 3);
  assert.ok((await sourceRows(churchId)).every((row) => row.draft_source_external_id === null));
}));

test('disabled source drafts are excluded from the combined review and remain unpromoted', async () => withTestChurchDb(async (churchId) => {
  const state = await fixture(churchId);
  const disabled = await batchRepository.createBatch({ churchId, provider, name: 'Disabled list', enabled: false, initialDraftSource: source('disabled') });
  const review = await orchestrator.buildReview(state.input, state.deps);
  assert.deepEqual(state.calls, ['morning', 'evening']);
  assert.deepEqual(review.plan.sourceContext.reviewedLists.map(({ batchId }) => batchId), state.batches.map(({ id }) => id));
  await apply(state, review);
  const untouched = (await sourceRows(churchId)).find(({ id }) => id === disabled.id);
  assert.equal(untouched.source_external_id, null);
  assert.equal(untouched.draft_source_external_id, 'disabled');
}));

test('an unexpectedly enabled retired batch blocks integration review before any provider read', async () => withTestChurchDb(async (churchId) => {
  const state = await fixture(churchId);
  await Database.query('UPDATE people_sync_batches SET legacy_provider_batch_id = 91 WHERE church_id = ? AND id = ?', [churchId, state.batches[1].id]);
  await assert.rejects(() => orchestrator.buildReview(state.input, state.deps), { code: 'PCO_LEGACY_BATCH_RETIRED' });
  assert.deepEqual(state.calls, []);
  assert.ok((await sourceRows(churchId)).every((row) => row.draft_source_external_id !== null));
}));

test('batch-scoped review still selects only its own draft while other batches retain active sources', async () => withTestChurchDb(async (churchId) => {
  const state = await fixture(churchId);
  const review = await orchestrator.buildReview({ ...state.input, batchId: state.batches[0].id }, state.deps);
  assert.deepEqual(state.calls, ['morning', 'evening-old']);
  await orchestrator.applyReviewed({ ...state.input, batchId: state.batches[0].id, reviewToken: review.reviewToken, selections: selections(review) }, state.deps);
  const rows = await sourceRows(churchId);
  assert.deepEqual(rows.map(({ source_external_id, draft_source_external_id }) => [source_external_id, draft_source_external_id]), [['morning', null], ['evening-old', 'evening']]);
}));

for (const change of ['new-enabled', 'disabled', 'changed-active', 'changed-draft']) test(`${change} source set race invalidates a combined review atomically`, async () => withTestChurchDb(async (churchId) => {
  const state = await fixture(churchId);
  const review = await orchestrator.buildReview(state.input, state.deps);
  const before = await sourceRows(churchId);
  const raced = { ...state.deps, applyPeopleSyncPlan: async (args) => {
    if (change === 'new-enabled') await batchRepository.createBatch({ churchId, provider, name: 'New list', initialDraftSource: source('new') });
    if (change === 'disabled') await batchRepository.updateBatch({ churchId, provider, batchId: state.batches[1].id, enabled: false });
    if (change === 'changed-active') await Database.query("UPDATE people_sync_batches SET source_external_id = 'different-old' WHERE church_id = ? AND id = ?", [churchId, state.batches[1].id]);
    if (change === 'changed-draft') await batchRepository.saveSourceDraft({ churchId, provider, batchId: state.batches[1].id, source: source('different-draft') });
    return applyPeopleSyncPlan(args);
  } };
  await assert.rejects(() => orchestrator.applyReviewed({ ...state.input, operationKind: 'people_sync', reviewToken: review.reviewToken, selections: selections(review) }, raced), { code: 'SYNC_PLAN_STALE' });
  assert.deepEqual(await Database.query('SELECT * FROM external_person_links WHERE church_id = ?', [churchId]), []);
  assert.deepEqual(await Database.query('SELECT * FROM gathering_lists WHERE church_id = ?', [churchId]), []);
  assert.equal((await sourceRows(churchId))[0].source_revision, before[0].source_revision);
  assert.equal((await sourceRows(churchId))[0].draft_source_external_id, 'morning');
}));

test('an active-source identity change before apply stales even when selected draft content is unchanged', async () => withTestChurchDb(async (churchId) => {
  const state = await fixture(churchId);
  const review = await orchestrator.buildReview(state.input, state.deps);
  await Database.query("UPDATE people_sync_batches SET source_external_id='new-old-source' WHERE church_id=? AND id=?", [churchId, state.batches[1].id]);
  await assert.rejects(() => apply(state, review), { code: 'SYNC_PLAN_STALE' });
  assert.deepEqual(await Database.query('SELECT * FROM external_person_links WHERE church_id = ?', [churchId]), []);
}));

test('changing a displayed reviewed list name requires a new integration review', async () => withTestChurchDb(async (churchId) => {
  const state = await fixture(churchId);
  const review = await orchestrator.buildReview(state.input, state.deps);
  await Database.query("UPDATE people_sync_batches SET name = 'Renamed evening list' WHERE church_id = ? AND id = ?", [churchId, state.batches[1].id]);
  await assert.rejects(() => apply(state, review), { code: 'SYNC_PLAN_STALE' });
  assert.deepEqual(await Database.query('SELECT * FROM external_person_links WHERE church_id = ?', [churchId]), []);
}));

test('a late promotion failure rolls back every earlier promotion and roster change', async () => withTestChurchDb(async (churchId) => {
  const state = await fixture(churchId);
  const review = await orchestrator.buildReview(state.input, state.deps);
  const before = await sourceRows(churchId);
  Database.getChurchDb(churchId).exec(`CREATE TRIGGER reject_second_promotion BEFORE UPDATE OF source_kind ON people_sync_batches WHEN OLD.id = ${state.batches[1].id} AND NEW.draft_source_external_id IS NULL BEGIN SELECT RAISE(ABORT, 'test promotion failure'); END;`);
  await assert.rejects(() => apply(state, review), /test promotion failure/);
  assert.deepEqual(await sourceRows(churchId), before);
  assert.deepEqual(await Database.query('SELECT * FROM external_person_links WHERE church_id = ?', [churchId]), []);
  assert.deepEqual(await Database.query('SELECT * FROM gathering_lists WHERE church_id = ?', [churchId]), []);
  Database.getChurchDb(churchId).exec('DROP TRIGGER reject_second_promotion');
  await apply(state, review);
  assert.ok((await sourceRows(churchId)).every((row) => row.draft_source_external_id === null));
}));

test('incomplete second source fails without promoting any draft or changing the roster', async () => withTestChurchDb(async (churchId) => {
  const state = await fixture(churchId);
  state.snapshots.get('evening').complete = false;
  const before = await sourceRows(churchId);
  await assert.rejects(() => orchestrator.buildReview(state.input, state.deps), { code: 'SYNC_SOURCE_INCOMPLETE' });
  assert.deepEqual(await sourceRows(churchId), before);
  assert.deepEqual(await Database.query('SELECT * FROM external_person_links WHERE church_id = ?', [churchId]), []);
}));

test('batch and integration tokens cannot cross apply or preview scopes', async () => withTestChurchDb(async (churchId) => {
  const state = await fixture(churchId, { drafts: false });
  const combined = await orchestrator.buildReview(state.input, state.deps);
  const batchInput = { ...state.input, batchId: state.batches[0].id };
  const single = await orchestrator.buildReview(batchInput, state.deps);
  await assert.rejects(() => apply(state, single), { code: 'SYNC_REVIEW_INVALID' });
  await assert.rejects(() => orchestrator.applyReviewed({ ...batchInput, reviewToken: combined.reviewToken, selections: selections(combined) }, state.deps), { code: 'SYNC_REVIEW_INVALID' });
  await assert.rejects(() => orchestrator.previewHouseholdChoices({ ...state.input, baseReviewToken: single.reviewToken, householdChoices: {} }, state.deps), { code: 'SYNC_REVIEW_INVALID' });
  await assert.rejects(() => orchestrator.previewLinkCorrections({ ...batchInput, baseReviewToken: combined.reviewToken, linkCorrections: {} }, state.deps), { code: 'SYNC_REVIEW_INVALID' });
}));

test('integration apply remains people-sync and preserves an existing authority intent', async () => withTestChurchDb(async (churchId) => {
  const state = await fixture(churchId, { drafts: false });
  await Database.query('UPDATE people_sync_settings SET pending_authority_provider = ? WHERE church_id = ?', [provider, churchId]);
  await Database.query('INSERT INTO people_sync_authority_preview_intents(church_id,provider,authority_preview_id) VALUES(?,?,?)', [churchId, provider, 'preserve-this-intent']);
  const review = await orchestrator.buildReview(state.input, state.deps);
  await apply(state, review);
  assert.deepEqual(await authority.getAuthority(churchId), { active: provider, pending: provider });
  assert.equal((await authority.getAuthorityPreviewIntent(churchId)).authorityPreviewId, 'preserve-this-intent');
}));

test('integration apply and preview reject authority-switch tokens without activating or clearing pending authority', async () => withTestChurchDb(async (churchId) => {
  const state = await fixture(churchId, { drafts: false });
  await Database.query("UPDATE people_sync_settings SET pending_authority_provider='elvanto' WHERE church_id=?", [churchId]);
  const token = createReviewToken({ operationKind: 'authority_switch', churchId, provider, batchId: null, planDigest: 'a'.repeat(64), expiresInSeconds: 300 });
  await assert.rejects(() => orchestrator.applyReviewed({ ...state.input, operationKind: 'people_sync', reviewToken: token, selections: { decisionContractVersion: 2, identityDecisions: {} } }, state.deps), { code: 'SYNC_REVIEW_INVALID' });
  await assert.rejects(() => orchestrator.previewHouseholdChoices({ ...state.input, baseReviewToken: token, householdChoices: {} }, state.deps), { code: 'SYNC_REVIEW_INVALID' });
  assert.deepEqual(await authority.getAuthority(churchId), { active: provider, pending: 'elvanto' });
  assert.deepEqual(await Database.query('SELECT * FROM external_person_links WHERE church_id = ?', [churchId]), []);
}));
