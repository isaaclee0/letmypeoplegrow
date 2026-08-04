'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.SYNC_REVIEW_SECRET = process.env.SYNC_REVIEW_SECRET || 'people-import-orchestrator-unit-secret';

const { BUCKETS } = require('../peopleSync/plan');
const { matchPeople } = require('../peopleSync/matcher');
const { buildReviewContext } = require('../peopleSync/reviewContext');
const {
  digestPlan, createReviewToken, verifyReviewToken,
} = require('../peopleSync/planDigest');
const { computePeopleImportPlan, assertAdditiveImportPlan } = require('./plan');
const {
  previewImport, applyImport, groupMembersByFamily, memberOnlyMatcherResult,
} = require('./orchestrator');

function person(id, overrides = {}) {
  return {
    id, firstName: 'Ada', lastName: 'Lovelace', state: 'active', child: false,
    familyId: null, attributes: {}, ...overrides,
  };
}

function snapshot(overrides = {}) {
  const people = overrides.people || [person('ext-1')];
  return {
    provider: 'elvanto',
    source: { kind: 'all', externalId: 'all', name: 'Everyone', providerRefreshedAt: null },
    complete: true,
    fetchedAt: '2026-08-04T01:02:03.000Z',
    providerRefreshedAt: null,
    memberExternalIds: people.map(({ id }) => id),
    people,
    contextPeople: [],
    families: [],
    ...overrides,
  };
}

function emptyApplyResult(overrides = {}) {
  return {
    ...Object.fromEntries(BUCKETS.map((bucket) => [bucket, 0])),
    familyNamesUpdated: 0,
    gatheringAssigned: 0,
    gatheringRemoved: 0,
    ...overrides,
  };
}

function makeDeps({
  snapshots = [snapshot()],
  authorityStates = [{ active: 'none', pending: null }],
  localStates = [{
    individuals: [], families: [], personLinks: [], familyLinks: [], gatheringMemberships: [],
    matchReviewState: { exclusions: [], holds: [] },
  }],
  connection = { provider: 'elvanto', connectionStatus: 'connected' },
  apply,
  extra = {},
} = {}) {
  const events = [];
  const finished = [];
  const failed = [];
  const applied = [];
  const tokenContexts = [];
  const digestedPlans = [];
  let fetchIndex = 0;
  let authorityIndex = 0;
  let localIndex = 0;
  let runId = 0;
  const adapter = {
    provider: 'elvanto',
    async fetchImportSnapshot(input) {
      events.push('fetch');
      assert.equal(input.churchId, 'church-a');
      assert.deepEqual(input.credentials, { apiKey: 'secret' });
      assert.deepEqual(input.selection, { kind: 'all' });
      return structuredClone(snapshots[Math.min(fetchIndex++, snapshots.length - 1)]);
    },
  };
  const deps = {
    async getConnection() { events.push('connection'); return connection; },
    async getConnectionGeneration() { events.push('generation'); return 17; },
    async getCredentials() { events.push('credentials'); return { apiKey: 'secret' }; },
    async getAuthority() {
      events.push('authority');
      return authorityStates[Math.min(authorityIndex++, authorityStates.length - 1)];
    },
    getProvider() { events.push('provider'); return adapter; },
    async startRun(input) {
      events.push('start');
      assert.deepEqual(input, {
        churchId: 'church-a', provider: 'elvanto', batchId: null,
        trigger: 'people_import', fetchMode: 'full',
      });
      return { id: ++runId };
    },
    async finishRun(input) { events.push('finish'); finished.push(input); },
    async failRun(input) { events.push('fail'); failed.push(input); },
    async loadLocalProjectionState() {
      events.push('local');
      return structuredClone(localStates[Math.min(localIndex++, localStates.length - 1)]);
    },
    matchPeople,
    computePeopleImportPlan,
    assertAdditiveImportPlan,
    buildReviewContext,
    digestPlan(plan) {
      digestedPlans.push(structuredClone(plan));
      return digestPlan(plan);
    },
    createReviewToken(context) {
      tokenContexts.push(context);
      return createReviewToken(context);
    },
    verifyReviewToken,
    async applyPeopleSyncPlan(input) {
      applied.push(input);
      if (apply) return apply(input);
      return emptyApplyResult();
    },
    listBatches() { throw new Error('must not read batches'); },
    createBatch() { throw new Error('must not create batches'); },
    recordActiveSourceAvailable() { throw new Error('must not mutate source health'); },
    recordActiveSourceFailure() { throw new Error('must not mutate source health'); },
    notifyReviewRequired() { throw new Error('must not notify sync review'); },
    refreshBackgroundCheckStatuses() { throw new Error('must not run provider extras'); },
    ...extra,
  };
  return { deps, events, finished, failed, applied, tokenContexts, digestedPlans };
}

const input = { churchId: 'church-a', provider: 'elvanto', selection: { kind: 'all' } };

test('groups family members and removes household-only matcher identities', () => {
  assert.deepEqual(
    [...groupMembersByFamily([
      person('member', { familyId: 'house-1' }),
      person('context', { familyId: 'house-1' }),
      person('none'),
    ])],
    [['house-1', [{ id: 'member' }, { id: 'context' }]]]
  );
  const filtered = memberOnlyMatcherResult({
    linked: [{ externalPersonId: 'context', individualId: 1 }, { externalPersonId: 'member', individualId: 2 }],
    matches: [{ externalPersonId: 'context', individualId: 3 }],
    ambiguous: [{ externalPersonId: 'context' }, { externalPersonId: 'member' }],
    visitorMatches: [{ externalPersonId: 'context' }],
    archivedMatches: [{ externalPersonId: 'member' }],
    unmatchedExternalIds: ['context', 'member'],
    unmatchedLocalIds: [99],
  }, new Set(['member']));

  assert.deepEqual(filtered.linked.map(({ externalPersonId }) => externalPersonId), ['member']);
  assert.deepEqual(filtered.matches, []);
  assert.deepEqual(filtered.ambiguous.map(({ externalPersonId }) => externalPersonId), ['member']);
  assert.deepEqual(filtered.visitorMatches, []);
  assert.deepEqual(filtered.archivedMatches.map(({ externalPersonId }) => externalPersonId), ['member']);
  assert.deepEqual(filtered.unmatchedExternalIds, ['member']);
  assert.deepEqual(filtered.unmatchedLocalIds, [99]);
});

test('preview imports without reading or creating batches', async () => {
  const { deps, events, finished, tokenContexts, digestedPlans } = makeDeps();
  const review = await previewImport(input, deps);

  assert.equal(review.operationKind, 'people_import');
  assert.deepEqual(review.selection, { kind: 'all' });
  assert.equal(review.plan.operationKind, 'people_import');
  assert.equal(review.plan.authoritative, false);
  assert.deepEqual(digestedPlans[0].sourceContext.authorityExpectation, { active: 'none', pending: null });
  assert.equal(JSON.stringify(review).includes('attributes'), false);
  assert.equal(tokenContexts[0].operationKind, 'people_import');
  assert.equal(tokenContexts[0].batchId, null);
  assert.equal(finished[0].status, 'review_required');
  assert.deepEqual(events, [
    'connection', 'generation', 'credentials', 'authority', 'provider', 'start',
    'fetch', 'local', 'finish',
  ]);
});

for (const failure of [
  { name: 'disconnected', connection: null, code: 'SYNC_NOT_CONNECTED' },
  { name: 'invalid', connection: { provider: 'elvanto', connectionStatus: 'invalid' }, code: 'SYNC_CONNECTION_INVALID' },
]) {
  test(`${failure.name} connection is rejected before run creation`, async () => {
    const { deps, events, failed } = makeDeps({ connection: failure.connection });
    await assert.rejects(previewImport(input, deps), { code: failure.code });
    assert.equal(events.includes('start'), false);
    assert.deepEqual(failed, []);
  });
}

test('an incomplete import snapshot fails the audit after run creation', async () => {
  const { deps, events, failed, applied } = makeDeps({ snapshots: [snapshot({ complete: false })] });
  await assert.rejects(previewImport(input, deps), { code: 'SYNC_SOURCE_INCOMPLETE' });
  assert.ok(events.indexOf('start') < events.indexOf('fetch'));
  assert.equal(failed.length, 1);
  assert.equal(failed[0].errorCode, 'SYNC_SOURCE_INCOMPLETE');
  assert.deepEqual(applied, []);
});

test('a snapshot for a different selected source is rejected', async () => {
  const selectedInput = {
    churchId: 'church-a', provider: 'elvanto',
    selection: { kind: 'elvanto_group', externalId: 'group-1' },
  };
  const { deps, failed } = makeDeps({
    snapshots: [snapshot({ source: { kind: 'elvanto_group', externalId: 'group-2', name: 'Other' } })],
    extra: {
      getProvider() {
        return {
          provider: 'elvanto',
          async fetchImportSnapshot() {
            return snapshot({ source: { kind: 'elvanto_group', externalId: 'group-2', name: 'Other' } });
          },
        };
      },
    },
  });
  await assert.rejects(previewImport(selectedInput, deps), { code: 'SYNC_SOURCE_UNAVAILABLE' });
  assert.equal(failed.length, 1);
});

test('active authority forces import creation and signed create data to local visitor', async () => {
  const { deps } = makeDeps({ authorityStates: [{ active: 'planning_center', pending: null }] });
  const review = await previewImport(input, deps);

  assert.deepEqual(review.plan.addPeople.map(({ peopleType, reason }) => ({ peopleType, reason })), [
    { peopleType: 'local_visitor', reason: 'authority_requires_visitor' },
  ]);
  assert.equal(review.plan.reviewContext.identities['ext-1'].createPerson.peopleType, 'local_visitor');
});

test('active authority also forces visitor create data when a suggested match is rejected', async () => {
  const { deps } = makeDeps({
    authorityStates: [{ active: 'planning_center', pending: null }],
    localStates: [{
      individuals: [{
        id: 9, firstName: 'Ada', lastName: 'Lovelace', peopleType: 'regular',
        familyId: null, isChild: false, isActive: true,
      }],
      families: [], personLinks: [], familyLinks: [], gatheringMemberships: [],
      matchReviewState: { exclusions: [], holds: [] },
    }],
  });
  const review = await previewImport(input, deps);

  assert.deepEqual(review.plan.addPeople, []);
  assert.equal(review.plan.reviewContext.identities['ext-1'].suggestedIndividualId, 9);
  assert.equal(review.plan.reviewContext.identities['ext-1'].createPerson.peopleType, 'local_visitor');
});

test('a people-sync token cannot be substituted for an import token', async () => {
  const state = makeDeps();
  await previewImport(input, state.deps);
  const signed = state.tokenContexts[0];
  const syncToken = createReviewToken({ ...signed, operationKind: 'people_sync' });

  await assert.rejects(
    applyImport({ ...input, reviewToken: syncToken, selections: {}, userId: 7 }, state.deps),
    { code: 'SYNC_REVIEW_INVALID' }
  );
  assert.deepEqual(state.applied, []);
  assert.equal(state.failed.length, 1);
});

test('an audit rejection of a token-shaped error retries with a safe fallback message', async () => {
  const auditAttempts = [];
  const state = makeDeps({
    extra: {
      async failRun(request) {
        auditAttempts.push(request);
        if (auditAttempts.length === 1) throw new Error('credential-shaped audit message');
      },
    },
  });
  await previewImport(input, state.deps);
  const signed = state.tokenContexts[0];
  const syncToken = createReviewToken({ ...signed, operationKind: 'people_sync' });

  await assert.rejects(
    applyImport({ ...input, reviewToken: syncToken, selections: {}, userId: 7 }, state.deps),
    { code: 'SYNC_REVIEW_INVALID' }
  );
  assert.equal(auditAttempts.length, 2);
  assert.equal(auditAttempts[1].errorMessage, 'People import failed; see server logs for details.');
});

for (const changed of [
  {
    name: 'pending authority',
    options: { authorityStates: [{ active: 'none', pending: null }, { active: 'none', pending: 'elvanto' }] },
  },
  {
    name: 'active authority even when import actions are identical',
    options: {
      authorityStates: [
        { active: 'planning_center', pending: null },
        { active: 'elvanto', pending: null },
      ],
    },
  },
  {
    name: 'local identity',
    options: { localStates: [
      { individuals: [], families: [], personLinks: [], familyLinks: [], gatheringMemberships: [], matchReviewState: { exclusions: [], holds: [] } },
      { individuals: [{ id: 9, firstName: 'Grace', lastName: 'Hopper', peopleType: 'regular', familyId: null, isChild: false, isActive: true }], families: [], personLinks: [], familyLinks: [], gatheringMemberships: [], matchReviewState: { exclusions: [], holds: [] } },
    ] },
  },
  {
    name: 'provider snapshot',
    options: { snapshots: [
      snapshot(),
      snapshot({ people: [person('ext-1'), person('ext-2', { firstName: 'Grace', lastName: 'Hopper' })] }),
    ] },
  },
]) {
  test(`changed ${changed.name} rejects a reviewed import before apply`, async () => {
    const state = makeDeps(changed.options);
    const review = await previewImport(input, state.deps);
    await assert.rejects(
      applyImport({ ...input, reviewToken: review.reviewToken, selections: {}, userId: 7 }, state.deps),
      { code: 'SYNC_PLAN_STALE' }
    );
    assert.deepEqual(state.applied, []);
    assert.equal(state.failed.length, 1);
  });
}

test('apply is one-time and forwards only additive mutation authority', async () => {
  const claimed = new Set();
  const state = makeDeps({
    apply: async (request) => {
      const token = request.reviewedApply.reviewToken;
      if (claimed.has(token)) {
        const error = new Error('already applied');
        error.code = 'SYNC_REVIEW_ALREADY_APPLIED';
        error.status = 409;
        throw error;
      }
      claimed.add(token);
      return emptyApplyResult({ addPeople: 1 });
    },
  });
  const review = await previewImport(input, state.deps);
  const request = { ...input, reviewToken: review.reviewToken, selections: {}, userId: 7 };
  const result = await applyImport(request, state.deps);

  assert.equal(result.status, 'applied');
  assert.equal(result.applied.addPeople, 1);
  const forwarded = state.applied[0];
  assert.equal(forwarded.activateAuthority, false);
  assert.equal(forwarded.sourcePromotion, null);
  assert.equal(forwarded.sourceExpectations, null);
  assert.deepEqual(forwarded.authorityExpectation, { active: 'none', pending: null });
  assert.deepEqual(forwarded.connectionExpectation, { generation: 17 });
  assert.equal(forwarded.requireConnection, true);
  assert.equal(forwarded.markLinksSeen, false);
  assert.deepEqual([...forwarded.allowedMutationBuckets].sort(), [
    'addFamilies', 'addPeople', 'ambiguousPeople', 'familyConflicts',
    'linkFamilies', 'linkPeople', 'skipped',
  ]);
  assert.equal(forwarded.reviewedApply.operationKind, 'people_import');
  assert.equal(forwarded.reviewedApply.batchId, null);

  await assert.rejects(applyImport(request, state.deps), { code: 'SYNC_REVIEW_ALREADY_APPLIED' });
  assert.equal(state.failed.length, 1);
});
