'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchPeople } = require('./matcher');
const { BUCKETS, computePeopleSyncPlan } = require('./plan');
const { digestPlan } = require('./planDigest');
const { digestSourceIdentity } = require('./sourceModel');
const {
  buildReview, applyReviewed, runUnattended, previewAuthoritySwitch, OrchestratorError,
} = require('./orchestrator');

function emptyApplyResult(overrides = {}) {
  const result = {};
  for (const bucket of BUCKETS) result[bucket] = 0;
  result.familyNamesUpdated = 0;
  result.gatheringAssigned = 0;
  result.gatheringRemoved = 0;
  return { ...result, ...overrides };
}

function source(externalId, name = externalId) {
  return { kind: 'elvanto_group', externalId, name };
}

function batch(overrides = {}) {
  return {
    id: 1,
    provider: 'elvanto',
    name: 'Members',
    enabled: true,
    source: source('group-1', 'Members'),
    sourceRevision: 2,
    draftSource: null,
    draftSourceBaseRevision: null,
    draftSourceUpdatedAt: null,
    needsSourceReview: false,
    initialSourceReviewPending: false,
    sourceStatus: 'available',
    sourceStatusCheckedAt: null,
    sourceStatusErrorCode: null,
    defaultPeopleType: 'regular',
    gatheringTypeId: null,
    gatheringAutoRemoveEnabled: false,
    scheduleEnabled: true,
    scheduleFrequency: 'weekly',
    scheduleDay: 1,
    lastExternalWatermark: 'legacy-watermark',
    lastSyncAt: null,
    lastSyncResult: null,
    ...overrides,
  };
}

function person(id, overrides = {}) {
  return {
    id,
    firstName: 'Ada',
    lastName: 'Lovelace',
    state: 'active',
    child: false,
    familyId: null,
    ...overrides,
  };
}

function sourceSnapshot(selectedSource, overrides = {}) {
  const people = overrides.people || [person(`${selectedSource.externalId}-person`)];
  return {
    provider: 'elvanto',
    source: selectedSource,
    complete: true,
    fetchedAt: '2026-07-29T01:00:00.000Z',
    providerRefreshedAt: null,
    memberExternalIds: people.map((item) => item.id),
    people,
    contextPeople: [],
    families: [],
    ...overrides,
  };
}

function makeDeps({
  batches = [batch()],
  authorityState = { active: 'elvanto', pending: null },
  fetchSourceSnapshot,
  lifecycleEligible = (value, settings) => value.state !== 'archived' && value.state !== 'deceased' &&
    (value.state !== 'contact' || settings.includeContacts !== false),
  localIndividuals = [],
  personLinks = [],
  matchReviewState = { exclusions: [], holds: [] },
  gatheringMemberships = [],
  verifyResult = { ok: true },
  extra = {},
} = {}) {
  const events = [];
  const finished = [];
  const failed = [];
  const applied = [];
  const presence = [];
  const availableHealth = [];
  const failedHealth = [];
  const plans = [];
  let nextRunId = 1;
  const adapter = {
    provider: 'elvanto',
    validateConnection: async () => ({ ok: true }),
    listSources: async () => [],
    fetchSourceSnapshot: fetchSourceSnapshot || (async ({ sourceKind, sourceExternalId }) => {
      const selected = source(sourceExternalId);
      selected.kind = sourceKind;
      return sourceSnapshot(selected);
    }),
    isLifecycleEligible: lifecycleEligible,
  };
  const deps = {
    getConnection: async () => ({ connectionStatus: 'connected' }),
    getCredentials: async () => ({ apiKey: 'test-key' }),
    getProvider: () => adapter,
    listBatches: async () => batches,
    getSyncSettings: async () => ({ includeContacts: true, alignPeopleType: true }),
    getAuthority: async () => authorityState,
    getUnattendedProviderEnabled: async () => true,
    beginAuthoritySwitch: async () => ({ active: authorityState.active, pending: 'elvanto' }),
    startRun: async (input) => { events.push('startRun'); return { id: nextRunId++, ...input }; },
    finishRun: async (input) => { events.push('finishRun'); finished.push(input); return input; },
    failRun: async (input) => { events.push('failRun'); failed.push(input); return input; },
    recordActiveSourceAvailable: async (input) => { events.push(`available:${input.batchId}`); availableHealth.push(input); },
    recordActiveSourceFailure: async (input) => { events.push(`failure:${input.batchId}`); failedHealth.push(input); },
    listPersonLinks: async () => personLinks,
    listMatchReviewState: async () => matchReviewState,
    listFamilyLinks: async () => [],
    recordFullFetchPresence: async (...args) => { events.push('presence'); presence.push(args); return {}; },
    listLocalIndividuals: async () => localIndividuals,
    listLocalFamilies: async () => [],
    listGatheringMemberships: async () => gatheringMemberships,
    matchPeople,
    computePeopleSyncPlan: (input) => { plans.push(input); return computePeopleSyncPlan(input); },
    applyPeopleSyncPlan: async (input) => { events.push('apply'); applied.push(input); return emptyApplyResult(); },
    validateSelections: () => ({
      acceptedLinks: [], skipExternalPersonIds: new Set(), acceptedArchiveIndividualIds: new Set(), acceptedFamilyRenameIds: new Set(),
    }),
    digestPlan,
    createReviewToken: ({ planDigest }) => `review:${planDigest}`,
    verifyReviewToken: () => verifyResult,
    notifyReviewRequired: async () => ({ notified: true }),
    ...extra,
  };
  return { deps, events, finished, failed, applied, presence, availableHealth, failedHealth, plans };
}

test('target review substitutes only the target draft source while other enabled batches use active sources', async () => {
  const reads = [];
  const batches = [
    batch({ id: 20, source: source('active-20'), sourceRevision: 7, draftSource: source('draft-20'), draftSourceBaseRevision: 7 }),
    batch({ id: 3, source: source('active-3'), sourceRevision: 4 }),
  ];
  const { deps, availableHealth } = makeDeps({
    batches,
    fetchSourceSnapshot: async (input) => {
      reads.push({ sourceKind: input.sourceKind, sourceExternalId: input.sourceExternalId });
      return sourceSnapshot(source(input.sourceExternalId));
    },
  });

  await buildReview({ churchId: 'church-a', provider: 'elvanto', batchId: 20, trigger: 'manual' }, deps);

  assert.deepEqual(reads, [
    { sourceKind: 'elvanto_group', sourceExternalId: 'draft-20' },
    { sourceKind: 'elvanto_group', sourceExternalId: 'active-3' },
  ]);
  assert.deepEqual(availableHealth.map((entry) => entry.batchId), [3], 'a successful draft read must not overwrite active-source health');
});

test('enabled sources are fetched sequentially', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const order = [];
  const { deps } = makeDeps({
    batches: [batch({ id: 1, source: source('one') }), batch({ id: 2, source: source('two') }), batch({ id: 3, source: source('three') })],
    fetchSourceSnapshot: async ({ sourceExternalId }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(`start:${sourceExternalId}`);
      await new Promise((resolve) => setImmediate(resolve));
      order.push(`end:${sourceExternalId}`);
      inFlight -= 1;
      return sourceSnapshot(source(sourceExternalId));
    },
  });

  await buildReview({ churchId: 'church-a', provider: 'elvanto', trigger: 'manual' }, deps);

  assert.equal(maxInFlight, 1);
  assert.deepEqual(order, ['start:one', 'end:one', 'start:two', 'end:two', 'start:three', 'end:three']);
});

test('duplicate members are normalized once while each batch retains its own member set', async () => {
  const firstShared = person('shared', { firstName: 'First' });
  const laterShared = person('shared', { firstName: 'Later' });
  const matchingInputs = [];
  const { deps, plans } = makeDeps({
    batches: [batch({ id: 1, source: source('one') }), batch({ id: 2, source: source('two') })],
    fetchSourceSnapshot: async ({ sourceExternalId }) => sourceExternalId === 'one'
      ? sourceSnapshot(source('one'), { people: [firstShared, person('one-only')], memberExternalIds: ['shared', 'one-only'] })
      : sourceSnapshot(source('two'), { people: [laterShared, person('two-only')], memberExternalIds: ['shared', 'two-only'] }),
    extra: {
      matchPeople: (input) => {
        matchingInputs.push(input.externalPeople);
        return matchPeople(input);
      },
    },
  });

  await buildReview({ churchId: 'church-a', provider: 'elvanto', trigger: 'manual' }, deps);

  assert.deepEqual(plans[0].externalPeople.map((item) => item.id), ['shared', 'one-only', 'two-only']);
  assert.equal(plans[0].externalPeople[0].firstName, 'First');
  assert.equal(matchingInputs[0][0].firstName, 'First', 'matching and planning must use the same normalized member record');
  assert.deepEqual([...plans[0].eligibleByBatch.get(1)], ['shared', 'one-only']);
  assert.deepEqual([...plans[0].eligibleByBatch.get(2)], ['shared', 'two-only']);
});

test('review preserves the names used to match external and local people', async () => {
  const external = person('external-ada', { firstName: 'Ada', lastName: 'Lovelace' });
  const local = {
    id: 42,
    firstName: 'Ada',
    lastName: 'Lovelace',
    peopleType: 'regular',
    familyId: null,
    isChild: false,
    isActive: true,
  };
  const { deps } = makeDeps({
    localIndividuals: [local],
    fetchSourceSnapshot: async () => sourceSnapshot(source('group-1', 'Members'), {
      people: [external],
      memberExternalIds: [external.id],
    }),
  });

  const review = await buildReview({ churchId: 'church-a', provider: 'elvanto', trigger: 'manual' }, deps);

  assert.deepEqual(review.plan.linkPeople, [{
    id: 'linkPeople:external-ada:42',
    externalPersonId: 'external-ada',
    individualId: 42,
    reason: 'unique_name',
    reviewRequired: false,
  }], 'the normalized names must still drive the matcher');
  assert.deepEqual(review.plan.people, {
    external: { 'external-ada': { firstName: 'Ada', lastName: 'Lovelace', family: { state: 'none' } } },
    local: { '42': { firstName: 'Ada', lastName: 'Lovelace', family: { state: 'none' }, matchEligible: true } },
  }, 'the review response must retain safe display names instead of exposing only IDs');
});

test('review coverage counts distinct unmatched active local regulars without creating plan actions', async () => {
  const localIndividuals = [
    { id: 11, firstName: 'Una', lastName: 'Matched', peopleType: 'regular', familyId: null, isChild: false, isActive: true },
    { id: 12, firstName: 'Vera', lastName: 'Visitor', peopleType: 'local_visitor', familyId: null, isChild: false, isActive: true },
    { id: 13, firstName: 'Ina', lastName: 'Inactive', peopleType: 'regular', familyId: null, isChild: false, isActive: false },
    { id: 14, firstName: 'Mia', lastName: 'Matched', peopleType: 'regular', familyId: null, isChild: false, isActive: true },
  ];
  const { deps } = makeDeps({
    localIndividuals,
    fetchSourceSnapshot: async () => sourceSnapshot(source('group-1'), {
      people: [person('matched', { firstName: 'Mia', lastName: 'Matched' })],
      memberExternalIds: ['matched'],
    }),
    extra: {
      matchPeople: () => ({
        linked: [],
        matches: [{ externalPersonId: 'matched', individualId: 14, reason: 'unique_name' }],
        ambiguous: [],
        unmatchedExternalIds: [],
        unmatchedLocalIds: [11, '11', 12, 13],
        visitorMatches: [],
        archivedMatches: [],
      }),
    },
  });

  const review = await buildReview({ churchId: 'church-a', provider: 'elvanto', trigger: 'manual' }, deps);

  assert.deepEqual(review.coverage, {
    unmatchedActiveLocalRegulars: 1,
  });
  assert.deepEqual(review.plan.unmatchedLocalRegulars, []);
  assert.deepEqual(review.plan.archive, []);
});

test('household context can corroborate a member match but never becomes eligible or actionable', async () => {
  const member = person('member', { firstName: 'Ada', lastName: 'Smith', familyId: 'external-family' });
  const context = person('context', { firstName: 'Bob', lastName: 'Smith', familyId: 'external-family' });
  const locals = [
    { id: 1, firstName: 'Ada', lastName: 'Smith', familyId: 10, peopleType: 'regular', isChild: false, isActive: true },
    { id: 2, firstName: 'Ada', lastName: 'Smith', familyId: 20, peopleType: 'regular', isChild: false, isActive: true },
    { id: 3, firstName: 'Bob', lastName: 'Smith', familyId: 10, peopleType: 'regular', isChild: false, isActive: true },
  ];
  const personLinks = [{ externalPersonId: 'context', individualId: 3, missingFullSyncCount: 0 }];
  const { deps, plans, presence, applied } = makeDeps({
    localIndividuals: locals,
    personLinks,
    fetchSourceSnapshot: async () => sourceSnapshot(source('group-1'), {
      people: [member], memberExternalIds: ['member'], contextPeople: [context],
      families: [{ id: 'external-family', memberExternalIds: ['member', 'context'], primaryContactExternalId: 'context' }],
    }),
  });

  await runUnattended({ churchId: 'church-a', provider: 'elvanto', batchId: 1 }, deps);

  assert.deepEqual([...plans[0].eligibleByBatch.get(1)], ['member']);
  assert.deepEqual(plans[0].externalPeople.map((item) => item.id), ['member']);
  assert.deepEqual(applied[0].plan.linkPeople.map((item) => [item.externalPersonId, item.individualId]), [['member', 1]]);
  for (const bucketName of ['addPeople', 'reactivate', 'addToGathering']) {
    assert.equal(applied[0].plan[bucketName].some((item) => item.externalPersonId === 'context'), false);
  }
  assert.deepEqual([...presence[0][2]], ['member']);
});

test('an eligible member displaces an earlier context-only copy in the review directory', async () => {
  const staleContext = person('shared', { firstName: 'Stale', lastName: 'Context', familyId: null });
  const currentMember = person('shared', { firstName: 'Current', lastName: 'Member', familyId: null });
  const { deps } = makeDeps({
    batches: [batch({ id: 1, source: source('first') }), batch({ id: 2, source: source('second') })],
    fetchSourceSnapshot: async ({ sourceExternalId }) => sourceExternalId === 'first'
      ? sourceSnapshot(source('first'), {
        people: [person('first-member')], memberExternalIds: ['first-member'], contextPeople: [staleContext],
      })
      : sourceSnapshot(source('second'), { people: [currentMember], memberExternalIds: ['shared'] }),
  });

  const review = await buildReview({ churchId: 'church-a', provider: 'elvanto', trigger: 'manual' }, deps);

  assert.deepEqual(review.plan.people.external.shared, {
    firstName: 'Current', lastName: 'Member', family: { state: 'none' },
  });
});

test('review signs durable match context and returns a family-aware directory without exposing raw people', async () => {
  const member = person('ext-1', { firstName: 'Alex', lastName: 'Smith', familyId: 'house-1' });
  const context = person('ext-2', { firstName: 'Jamie', lastName: 'Smith', familyId: 'house-1' });
  const matchInputs = [];
  let signedPlan;
  const { deps } = makeDeps({
    localIndividuals: [
      { id: 7, firstName: 'Alex', lastName: 'Smith', peopleType: 'regular', familyId: null, isChild: false, isActive: true },
      { id: 8, firstName: 'Alex', lastName: 'Smith', peopleType: 'regular', familyId: null, isChild: false, isActive: true },
      { id: 9, firstName: 'Alex', lastName: 'Smith', peopleType: 'regular', familyId: null, isChild: false, isActive: true },
      { id: 10, firstName: 'Durable', lastName: 'Link', peopleType: 'regular', familyId: null, isChild: false, isActive: true },
    ],
    personLinks: [{ externalPersonId: 'old-link', individualId: 10, missingFullSyncCount: 0 }],
    matchReviewState: {
      exclusions: [{ externalPersonId: 'ext-1', individualId: 9 }],
      holds: [{ externalPersonId: 'ext-1', reason: 'deferred' }],
    },
    fetchSourceSnapshot: async () => sourceSnapshot(source('group-1'), {
      people: [member], memberExternalIds: ['ext-1'], contextPeople: [context],
      families: [{ id: 'house-1', name: 'Smith Household', memberExternalIds: ['ext-2', 'ext-1'] }],
    }),
    extra: {
      matchPeople: (input) => { matchInputs.push(input); return matchPeople(input); },
      digestPlan: (plan) => { signedPlan = structuredClone(plan); return 'a'.repeat(64); },
    },
  });

  const review = await buildReview({ churchId: 'church-a', provider: 'elvanto', trigger: 'manual' }, deps);

  assert.deepEqual(matchInputs[0].excludedPairs, new Set(['ext-1\u00009']));
  assert.deepEqual(matchInputs[0].heldExternalIds, new Set(['ext-1']));
  assert.equal(review.decisionContractVersion, 2);
  assert.match(signedPlan.reviewContext.localIdentityDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(signedPlan.reviewContext, {
    version: 2,
    manualCandidateIndividualIds: [7, 8, 9],
    localIdentityDigest: signedPlan.reviewContext.localIdentityDigest,
    identities: {
      'ext-1': {
        suggestedIndividualId: null,
        candidateIndividualIds: [7, 8],
        excludedIndividualIds: [9],
        held: true,
        canCreate: true,
        createPerson: {
          firstName: 'Alex', lastName: 'Smith', isChild: false,
          externalFamilyId: 'house-1', peopleType: 'regular',
        },
      },
    },
  });
  assert.deepEqual(review.plan.people.external['ext-1'].family, {
    state: 'known', name: 'Smith Household',
    members: [{ firstName: 'Jamie', lastName: 'Smith' }], totalOtherMembers: 1,
  });
  assert.equal(review.plan.people.local['10'].matchEligible, false);
});

test('reviewed apply rejects a rebuilt context when holds, exclusions, candidates, or create data change', async () => {
  let reviewState = {
    exclusions: [{ externalPersonId: 'ext-1', individualId: 9 }],
    holds: [{ externalPersonId: 'ext-1', reason: 'deferred' }],
  };
  let fetches = 0;
  let signedDigest;
  const { deps, applied } = makeDeps({
    localIndividuals: [
      { id: 7, firstName: 'Alex', lastName: 'Smith', peopleType: 'regular', familyId: null, isChild: false, isActive: true },
      { id: 8, firstName: 'Alex', lastName: 'Smith', peopleType: 'regular', familyId: null, isChild: false, isActive: true },
      { id: 9, firstName: 'Alex', lastName: 'Smith', peopleType: 'regular', familyId: null, isChild: false, isActive: true },
    ],
    matchReviewState: undefined,
    fetchSourceSnapshot: async () => {
      fetches += 1;
      return sourceSnapshot(source('group-1'), {
        people: [person('ext-1', { firstName: 'Alex', lastName: 'Smith', familyId: fetches === 1 ? 'house-old' : 'house-new' })],
        memberExternalIds: ['ext-1'],
      });
    },
    extra: {
      listMatchReviewState: async () => reviewState,
      digestPlan: (plan) => {
        assert.equal(plan.reviewContext?.version, 2);
        return digestPlan(plan);
      },
      createReviewToken: ({ planDigest }) => { signedDigest = planDigest; return `review:${planDigest}`; },
      verifyReviewToken: (token, { planDigest }) => token === `review:${planDigest}` && planDigest === signedDigest
        ? { ok: true }
        : { ok: false, code: 'SYNC_PLAN_STALE' },
    },
  });

  const review = await buildReview({ churchId: 'church-a', provider: 'elvanto', trigger: 'manual' }, deps);
  reviewState = {
    exclusions: [{ externalPersonId: 'ext-1', individualId: 7 }, { externalPersonId: 'ext-1', individualId: 9 }],
    holds: [],
  };

  await assert.rejects(
    applyReviewed({ churchId: 'church-a', provider: 'elvanto', reviewToken: review.reviewToken, selections: {}, userId: 1 }, deps),
    { code: 'SYNC_PLAN_STALE' }
  );
  assert.equal(applied.length, 0);
});

test('unattended sync holds an unmatched persisted identity for review without creating it and notifies once', async () => {
  const notifications = [];
  const { deps, applied, finished } = makeDeps({
    matchReviewState: {
      exclusions: [],
      holds: [{ externalPersonId: 'held-unmatched', reason: 'deferred' }],
    },
    fetchSourceSnapshot: async () => sourceSnapshot(source('group-1'), {
      people: [person('held-unmatched', { firstName: 'New', lastName: 'Person' })],
      memberExternalIds: ['held-unmatched'],
    }),
    extra: {
      notifyReviewRequired: async (input) => { notifications.push(input); return { notified: true }; },
    },
  });

  const result = await runUnattended({ churchId: 'church-a', provider: 'elvanto', batchId: 1 }, deps);

  assert.equal(result.status, 'review_required');
  assert.equal(result.counts.ambiguousPeople, 1);
  assert.deepEqual(applied[0].plan.addPeople, []);
  assert.deepEqual(applied[0].plan.ambiguousPeople, [{
    id: 'ambiguousPeople:held-unmatched:review_deferred',
    externalPersonId: 'held-unmatched',
    candidateIndividualIds: [],
    reason: 'review_deferred',
  }]);
  assert.equal(finished[0].status, 'review_required');
  assert.deepEqual(notifications, [{
    churchId: 'church-a', provider: 'elvanto', runId: 1,
    counts: { ambiguousPeople: 1, familyConflicts: 0, renameFamily: 0, unmatchedLocalRegulars: 0 },
  }]);
});

test('an unlinked lifecycle-ineligible member cannot match, act, or enter full-fetch presence', async () => {
  const matchingInputs = [];
  const terminal = person('archived', { firstName: 'Grace', lastName: 'Hopper', state: 'archived' });
  const { deps, plans, applied, presence } = makeDeps({
    localIndividuals: [
      { id: 9, firstName: 'Grace', lastName: 'Hopper', familyId: null, peopleType: 'regular', isChild: false, isActive: true },
    ],
    fetchSourceSnapshot: async () => sourceSnapshot(source('group-1'), {
      people: [person('active'), terminal],
      memberExternalIds: ['active', 'archived'],
    }),
    extra: {
      matchPeople: (input) => {
        matchingInputs.push(input.externalPeople);
        return matchPeople(input);
      },
    },
  });

  await runUnattended({ churchId: 'church-a', provider: 'elvanto', batchId: 1 }, deps);

  assert.deepEqual([...plans[0].eligibleByBatch.get(1)], ['active']);
  assert.deepEqual(plans[0].externalPeople.map((item) => item.id), ['active']);
  assert.deepEqual(matchingInputs[0].map((item) => item.id), ['active']);
  assert.equal(BUCKETS.some((bucket) => applied[0].plan[bucket].some((item) => item.externalPersonId === 'archived')), false);
  assert.deepEqual(applied[0].plan.unmatchedLocalRegulars, []);
  assert.deepEqual([...presence[0][2]], ['active']);
  assert.deepEqual([...presence[0][3].ignoredExternalIds], ['archived']);
});

for (const sourceOrder of [
  ['context-source', 'terminal-source'],
  ['terminal-source', 'context-source'],
]) {
  test(`cross-batch context cannot re-admit an unlinked lifecycle-ineligible member (${sourceOrder.join(' then ')})`, async () => {
    const matchingInputs = [];
    const terminal = person('terminal', { firstName: 'Grace', lastName: 'Hopper', state: 'archived' });
    const batches = sourceOrder.map((sourceExternalId, index) => batch({
      id: index + 1,
      source: source(sourceExternalId),
    }));
    const { deps, applied, presence } = makeDeps({
      batches,
      localIndividuals: [
        { id: 9, firstName: 'Grace', lastName: 'Hopper', familyId: null, peopleType: 'regular', isChild: false, isActive: true },
      ],
      fetchSourceSnapshot: async ({ sourceExternalId }) => sourceExternalId === 'context-source'
        ? sourceSnapshot(source('context-source'), {
          people: [person('active-context-source')],
          memberExternalIds: ['active-context-source'],
          contextPeople: [terminal],
        })
        : sourceSnapshot(source('terminal-source'), {
          people: [terminal],
          memberExternalIds: ['terminal'],
        }),
      extra: {
        matchPeople: (input) => {
          matchingInputs.push(input.externalPeople);
          return matchPeople(input);
        },
      },
    });

    await runUnattended({ churchId: 'church-a', provider: 'elvanto', batchId: 1 }, deps);

    assert.equal(matchingInputs[0].some((item) => item.id === 'terminal'), false);
    assert.equal(BUCKETS.some((bucket) => applied[0].plan[bucket].some((item) => item.externalPersonId === 'terminal')), false);
    assert.deepEqual(applied[0].plan.unmatchedLocalRegulars, []);
    assert.equal(presence[0][2].has('terminal'), false);
    assert.equal(presence[0][3].ignoredExternalIds.has('terminal'), true);
  });
}

test('a lifecycle-ineligible existing link is reserved only for safe matching and never archived or presence-counted', async () => {
  const matchingInputs = [];
  const { deps, plans, applied, presence } = makeDeps({
    localIndividuals: [
      { id: 9, firstName: 'Grace', lastName: 'Hopper', familyId: null, peopleType: 'regular', isChild: false, isActive: true },
    ],
    personLinks: [{ externalPersonId: 'archived', individualId: 9, missingFullSyncCount: 1 }],
    fetchSourceSnapshot: async () => sourceSnapshot(source('group-1'), {
      people: [person('archived', { firstName: 'Grace', lastName: 'Hopper', state: 'archived' })],
      memberExternalIds: ['archived'],
    }),
    extra: {
      matchPeople: (input) => {
        matchingInputs.push(input.externalPeople);
        return matchPeople(input);
      },
    },
  });

  await runUnattended({ churchId: 'church-a', provider: 'elvanto', batchId: 1 }, deps);

  assert.deepEqual(matchingInputs[0].map((item) => item.id), ['archived'], 'only an existing link may retain terminal matching context');
  assert.deepEqual(plans[0].externalPeople, []);
  assert.deepEqual(plans[0].personLinks, []);
  assert.equal(BUCKETS.some((bucket) => applied[0].plan[bucket].some((item) => item.externalPersonId === 'archived')), false);
  assert.deepEqual(applied[0].plan.unmatchedLocalRegulars, []);
  assert.deepEqual([...presence[0][2]], []);
  assert.deepEqual([...presence[0][3].ignoredExternalIds], ['archived']);
});

test('a complete empty source is accepted', async () => {
  const { deps, finished } = makeDeps({
    fetchSourceSnapshot: async () => sourceSnapshot(source('group-1'), { people: [], memberExternalIds: [] }),
  });
  const review = await buildReview({ churchId: 'church-a', provider: 'elvanto', batchId: 1, trigger: 'manual' }, deps);
  assert.equal(review.summary.addPeople, 0);
  assert.equal(finished[0].status, 'review_required');
});

for (const failure of [
  { name: 'missing', error: Object.assign(new Error('gone'), { code: 'SYNC_SOURCE_UNAVAILABLE' }) },
  { name: 'incomplete', snapshot: sourceSnapshot(source('group-1'), { complete: false }) },
  { name: 'malformed complete', snapshot: sourceSnapshot(source('group-1', ''), { fetchedAt: null }) },
  { name: 'unsafe provenance', snapshot: sourceSnapshot(source('group-1', 'x'.repeat(501))) },
  { name: 'context-only claimed member', snapshot: sourceSnapshot(source('group-1'), {
    people: [], memberExternalIds: ['context-only'], contextPeople: [person('context-only')],
  }) },
  { name: 'member/context overlap', snapshot: sourceSnapshot(source('group-1'), {
    people: [person('overlap')], memberExternalIds: ['overlap'], contextPeople: [person('overlap')],
  }) },
]) {
  test(`${failure.name} active source fails before planning, apply, and presence while recording health`, async () => {
    const { deps, plans, applied, presence, failedHealth, failed } = makeDeps({
      fetchSourceSnapshot: async () => {
        if (failure.error) throw failure.error;
        return failure.snapshot;
      },
    });
    await assert.rejects(
      buildReview({ churchId: 'church-a', provider: 'elvanto', batchId: 1, trigger: 'manual' }, deps),
      (error) => error.code === (failure.error?.code || 'SYNC_SOURCE_INCOMPLETE')
    );
    assert.equal(plans.length, 0);
    assert.equal(applied.length, 0);
    assert.equal(presence.length, 0);
    assert.equal(failedHealth.length, 1);
    assert.equal(failed.length, 1);
  });
}

for (const mismatch of [
  { name: 'wrong stable ID', snapshot: sourceSnapshot(source('replacement', 'Replacement'), { complete: false }) },
  { name: 'wrong kind', snapshot: sourceSnapshot({ kind: 'elvanto_category', externalId: 'group-1', name: 'Members' }) },
]) {
  test(`${mismatch.name} from an active source is unavailable and records missing-source health`, async () => {
    const { deps, plans, applied, presence, failedHealth, failed } = makeDeps({
      fetchSourceSnapshot: async () => mismatch.snapshot,
    });

    await assert.rejects(
      buildReview({ churchId: 'church-a', provider: 'elvanto', batchId: 1, trigger: 'manual' }, deps),
      (error) => error.code === 'SYNC_SOURCE_UNAVAILABLE'
    );

    assert.equal(plans.length, 0);
    assert.equal(applied.length, 0);
    assert.equal(presence.length, 0);
    assert.equal(failedHealth.length, 1);
    assert.equal(failedHealth[0].code, 'SYNC_SOURCE_UNAVAILABLE');
    assert.equal(failed[0].errorCode, 'SYNC_SOURCE_UNAVAILABLE');
  });
}

test('a draft-source fetch failure leaves active source health untouched', async () => {
  const reviewed = batch({ source: source('active'), sourceRevision: 8, draftSource: source('draft'), draftSourceBaseRevision: 8 });
  const error = Object.assign(new Error('draft missing'), { code: 'SYNC_SOURCE_UNAVAILABLE' });
  const { deps, availableHealth, failedHealth } = makeDeps({ batches: [reviewed], fetchSourceSnapshot: async () => { throw error; } });
  await assert.rejects(
    buildReview({ churchId: 'church-a', provider: 'elvanto', batchId: 1, trigger: 'manual' }, deps),
    (caught) => caught.code === 'SYNC_SOURCE_UNAVAILABLE'
  );
  assert.deepEqual(availableHealth, []);
  assert.deepEqual(failedHealth, []);
});

for (const blocked of [
  { name: 'missing active source', value: batch({ source: null, initialSourceReviewPending: true }), code: 'SYNC_SOURCE_SELECTION_REQUIRED' },
  { name: 'pending draft', value: batch({ draftSource: source('draft'), draftSourceBaseRevision: 2, needsSourceReview: true }), code: 'SYNC_SOURCE_REVIEW_REQUIRED' },
]) {
  test(`unattended sync rejects ${blocked.name} before startRun or adapter calls`, async () => {
    let fetches = 0;
    const { deps, events } = makeDeps({
      batches: [blocked.value],
      fetchSourceSnapshot: async () => { fetches += 1; return sourceSnapshot(source('group-1')); },
    });
    await assert.rejects(
      runUnattended({ churchId: 'church-a', provider: 'elvanto', batchId: 1 }, deps),
      (error) => error instanceof OrchestratorError && error.code === blocked.code
    );
    assert.equal(fetches, 0);
    assert.equal(events.includes('startRun'), false);
  });
}

test('source age is never a run gate', async () => {
  for (const sourceStatusCheckedAt of ['1999-01-01T00:00:00.000Z', null]) {
    const { deps } = makeDeps({ batches: [batch({ sourceStatusCheckedAt })] });
    const review = await buildReview({ churchId: 'church-a', provider: 'elvanto', batchId: 1, trigger: 'manual' }, deps);
    assert.equal(review.snapshot.mode, 'full');
  }
});

test('each later scheduled attempt resolves a missing source again and can recover', async () => {
  let fetches = 0;
  const { deps } = makeDeps({
    batches: [batch({ sourceStatus: 'missing', sourceStatusCheckedAt: '2026-07-28T00:00:00.000Z' })],
    fetchSourceSnapshot: async () => {
      fetches += 1;
      if (fetches === 1) throw Object.assign(new Error('missing'), { code: 'SYNC_SOURCE_UNAVAILABLE' });
      return sourceSnapshot(source('group-1'), { people: [], memberExternalIds: [] });
    },
  });
  await assert.rejects(runUnattended({ churchId: 'church-a', provider: 'elvanto', batchId: 1 }, deps), { code: 'SYNC_SOURCE_UNAVAILABLE' });
  const recovered = await runUnattended({ churchId: 'church-a', provider: 'elvanto', batchId: 1 }, deps);
  assert.equal(recovered.status, 'applied');
  assert.equal(fetches, 2);
});

test('unattended Planning Center auth exhaustion records a safe source error and leaves the roster untouched', async () => {
  const planningCenterSource = { kind: 'planning_center_list', externalId: 'list-1', name: 'Members' };
  const sourceHealth = { status: 'available', errorCode: null };
  let notificationCalls = 0;
  let fetches = 0;
  const { deps, plans, applied: applyCalls } = makeDeps({
    batches: [batch({ provider: 'planning_center', source: planningCenterSource })],
    authorityState: { active: 'planning_center', pending: null },
    fetchSourceSnapshot: async () => {
      fetches += 1;
      if (fetches === 1) throw Object.assign(new Error('Planning Center credentials need reconnection'), { code: 'SYNC_SOURCE_AUTH' });
      return sourceSnapshot(planningCenterSource, { provider: 'planning_center' });
    },
    extra: {
      recordActiveSourceFailure: async ({ code }) => {
        sourceHealth.status = code === 'SYNC_SOURCE_UNAVAILABLE' ? 'missing' : 'error';
        sourceHealth.errorCode = code;
        if (code === 'SYNC_SOURCE_UNAVAILABLE') notificationCalls += 1;
      },
      recordActiveSourceAvailable: async () => {
        sourceHealth.status = 'available';
        sourceHealth.errorCode = null;
      },
    },
  });

  await assert.rejects(
    runUnattended({ churchId: 'church-a', provider: 'planning_center', batchId: 1 }, deps),
    { code: 'SYNC_SOURCE_AUTH' }
  );

  assert.equal(sourceHealth.status, 'error');
  assert.equal(sourceHealth.errorCode, 'SYNC_SOURCE_AUTH');
  assert.equal(notificationCalls, 0);
  assert.equal(plans.length, 0);
  assert.equal(applyCalls.length, 0);

  const recovered = await runUnattended({ churchId: 'church-a', provider: 'planning_center', batchId: 1 }, deps);
  assert.equal(recovered.status, 'applied');
  assert.equal(sourceHealth.status, 'available');
  assert.equal(sourceHealth.errorCode, null);
});

test('review digest binds sorted source identity, revision, draft identity, and snapshot digests', async () => {
  let digested;
  const draft = source('draft-20');
  const batches = [
    batch({ id: 20, source: source('active-20'), sourceRevision: 9, draftSource: draft, draftSourceBaseRevision: 9 }),
    batch({ id: 3, source: source('active-3'), sourceRevision: 4 }),
  ];
  const { deps } = makeDeps({ batches, extra: { digestPlan: (plan) => { digested = structuredClone(plan); return 'a'.repeat(64); } } });
  await buildReview({ churchId: 'church-a', provider: 'elvanto', batchId: 20, trigger: 'manual' }, deps);

  assert.equal(digested.filterContext, undefined);
  assert.equal(digested.sourceContext.activeRevision, 9);
  assert.equal(digested.sourceContext.draftDigest, digestSourceIdentity(draft));
  assert.deepEqual(digested.sourceContext.snapshots.map((item) => item.batchId), [3, 20]);
  assert.deepEqual(Object.keys(digested.sourceContext.snapshots[0]).sort(), ['batchId', 'snapshotDigest', 'sourceExternalId', 'sourceKind']);
  assert.ok(digested.sourceContext.snapshots.every((item) => /^[a-f0-9]{64}$/.test(item.snapshotDigest)));
});

test('reviewed apply sends source promotion CAS data and records member-only full presence once', async () => {
  const draft = source('draft');
  const reviewed = batch({ source: source('active'), sourceRevision: 6, draftSource: draft, draftSourceBaseRevision: 6 });
  const { deps, applied, presence } = makeDeps({ batches: [reviewed] });
  const result = await applyReviewed({
    churchId: 'church-a', provider: 'elvanto', batchId: 1, reviewToken: 'review-token', selections: {}, userId: 5,
  }, deps);

  assert.equal(result.status, 'applied');
  assert.deepEqual(applied[0].sourcePromotion, {
    batchId: 1, expectedBaseRevision: 6, expectedDraftDigest: digestSourceIdentity(draft),
  });
  assert.equal(Object.hasOwn(applied[0], 'filterPromotion'), false);
  assert.equal(applied[0].reviewedApply.reviewToken, 'review-token');
  assert.match(applied[0].reviewedApply.planDigest, /^[a-f0-9]{64}$/);
  assert.equal(presence.length, 1);
});

test('a one-time review replay remains a typed refreshable failure and is recorded on the run', async () => {
  const replayError = Object.assign(
    new Error('This review has already been applied. Refresh before applying another sync.'),
    { code: 'SYNC_REVIEW_ALREADY_APPLIED', status: 409 }
  );
  const { deps, failed } = makeDeps({
    extra: {
      applyPeopleSyncPlan: async () => { throw replayError; },
    },
  });

  await assert.rejects(
    applyReviewed({
      churchId: 'church-a', provider: 'elvanto', batchId: 1,
      reviewToken: 'review-token', selections: {}, userId: 5,
    }, deps),
    (error) => error instanceof OrchestratorError &&
      error.code === 'SYNC_REVIEW_ALREADY_APPLIED' && error.status === 409
  );
  assert.equal(failed.length, 1);
  assert.equal(failed[0].errorCode, 'SYNC_REVIEW_ALREADY_APPLIED');
});

test('scheduled source sync is full-only, ignores legacy watermarks, persists provenance, and records presence once after apply', async () => {
  const { deps, events, finished, presence } = makeDeps({ batches: [batch({ lastExternalWatermark: 'legacy-watermark' })] });
  const result = await runUnattended({ churchId: 'church-a', provider: 'elvanto', batchId: 1, forceFull: false }, deps);

  assert.equal(result.fetchMode, 'full');
  assert.equal(result.externalWatermark, null);
  assert.equal(presence.length, 1);
  assert.ok(events.indexOf('presence') > events.indexOf('apply'));
  assert.equal(finished[0].externalWatermark, null);
  assert.equal(finished[0].sourceProvenance.length, 1);
  assert.equal(Object.hasOwn(result, 'plan'), false);
  assert.equal(Object.hasOwn(result, 'decisionContractVersion'), false);
});

test('previewAuthoritySwitch remains review-only and validates sources before staging mutations', async () => {
  let begins = 0;
  const { deps, applied, presence } = makeDeps({
    authorityState: { active: 'none', pending: null },
    localIndividuals: [
      { id: 51, firstName: 'Una', lastName: 'Matched', peopleType: 'regular', familyId: null, isChild: false, isActive: true },
    ],
    extra: {
      beginAuthoritySwitch: async (_churchId, _provider, previewId) => {
        begins += 1;
        assert.equal(previewId, 'preview-1');
        return { active: 'none', pending: 'elvanto' };
      },
      matchPeople: () => ({
        linked: [], matches: [], ambiguous: [], unmatchedExternalIds: [], unmatchedLocalIds: [51], visitorMatches: [], archivedMatches: [],
      }),
    },
  });
  const review = await previewAuthoritySwitch({
    churchId: 'church-a', provider: 'elvanto', authorityPreviewId: 'preview-1',
  }, deps);
  assert.equal(begins, 1);
  assert.equal(review.authority.pending, 'elvanto');
  assert.equal(review.authorityPreviewId, 'preview-1');
  assert.deepEqual(review.coverage, {
    unmatchedActiveLocalRegulars: 1,
  });
  assert.equal(applied.length, 0);
  assert.equal(presence.length, 0);
});

test('a failed authority preview conditionally cancels only the intent it staged', async () => {
  const cancellations = [];
  const { deps } = makeDeps({
    authorityState: { active: 'none', pending: null },
    extra: {
      beginAuthoritySwitch: async () => ({ active: 'none', pending: 'elvanto' }),
      cancelAuthoritySwitch: async (...args) => { cancellations.push(args); },
      startRun: async () => { throw new Error('run storage unavailable'); },
    },
  });

  await assert.rejects(
    previewAuthoritySwitch({
      churchId: 'church-a', provider: 'elvanto', authorityPreviewId: 'preview-failed',
    }, deps),
    /run storage unavailable/
  );
  assert.deepEqual(cancellations, [['church-a', 'elvanto', 'preview-failed']]);
});

test('a timed-out authority preview cannot stage after slow preconditions finish', async () => {
  const controller = new AbortController();
  let begins = 0;
  let releaseBatches;
  const batchesReady = new Promise((resolve) => { releaseBatches = resolve; });
  const { deps } = makeDeps({
    authorityState: { active: 'none', pending: null },
    extra: {
      listBatches: async () => batchesReady,
      beginAuthoritySwitch: async () => {
        begins += 1;
        return { active: 'none', pending: 'elvanto' };
      },
    },
  });

  const preview = previewAuthoritySwitch({
    churchId: 'church-a', provider: 'elvanto', authorityPreviewId: 'preview-timeout-before-stage',
    signal: controller.signal,
  }, deps);
  controller.abort();
  releaseBatches([batch()]);

  await assert.rejects(preview, (error) => error.code === 'SYNC_ROUTE_TIMEOUT');
  assert.equal(begins, 0);
});

test('a timeout racing authority staging cancels its exact intent after begin completes', async () => {
  const controller = new AbortController();
  const cancellations = [];
  let releaseBegin;
  const beginReady = new Promise((resolve) => { releaseBegin = resolve; });
  let markBeginEntered;
  const beginEntered = new Promise((resolve) => { markBeginEntered = resolve; });
  const { deps } = makeDeps({
    authorityState: { active: 'none', pending: null },
    extra: {
      beginAuthoritySwitch: async () => {
        markBeginEntered();
        await beginReady;
        return { active: 'none', pending: 'elvanto' };
      },
      cancelAuthoritySwitch: async (...args) => { cancellations.push(args); },
    },
  });

  const preview = previewAuthoritySwitch({
    churchId: 'church-a', provider: 'elvanto', authorityPreviewId: 'preview-timeout-during-stage',
    signal: controller.signal,
  }, deps);
  await beginEntered;
  controller.abort();
  releaseBegin();

  await assert.rejects(preview, (error) => error.code === 'SYNC_ROUTE_TIMEOUT');
  assert.deepEqual(cancellations, [['church-a', 'elvanto', 'preview-timeout-during-stage']]);
});
