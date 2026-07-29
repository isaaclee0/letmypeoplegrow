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

test('lifecycle-ineligible source members are excluded from batch eligibility', async () => {
  const { deps, plans } = makeDeps({
    fetchSourceSnapshot: async () => sourceSnapshot(source('group-1'), {
      people: [person('active'), person('archived', { state: 'archived' })],
      memberExternalIds: ['active', 'archived'],
    }),
  });

  await buildReview({ churchId: 'church-a', provider: 'elvanto', batchId: 1, trigger: 'manual' }, deps);

  assert.deepEqual([...plans[0].eligibleByBatch.get(1)], ['active']);
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
  assert.equal(presence.length, 1);
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
});

test('previewAuthoritySwitch remains review-only and validates sources before staging mutations', async () => {
  let begins = 0;
  const { deps, applied, presence } = makeDeps({
    authorityState: { active: 'none', pending: null },
    extra: { beginAuthoritySwitch: async () => { begins += 1; return { active: 'none', pending: 'elvanto' }; } },
  });
  const review = await previewAuthoritySwitch({ churchId: 'church-a', provider: 'elvanto' }, deps);
  assert.equal(begins, 1);
  assert.equal(review.authority.pending, 'elvanto');
  assert.equal(applied.length, 0);
  assert.equal(presence.length, 0);
});
