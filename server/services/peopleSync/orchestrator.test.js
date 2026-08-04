'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchPeople } = require('./matcher');
const { BUCKETS, computePeopleSyncPlan } = require('./plan');
const { digestPlan, digestReviewToken } = require('./planDigest');
const { digestSourceIdentity } = require('./sourceModel');
const {
  buildReview, applyReviewed, runUnattended, previewAuthoritySwitch, previewLinkCorrections, OrchestratorError,
  isCompleteSourceSnapshot, sameSourceIdentity, snapshotDigestInput,
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

function localPerson(id, firstName, lastName, overrides = {}) {
  return {
    id, firstName, lastName, peopleType: 'regular', familyId: null,
    isChild: false, isActive: true, ...overrides,
  };
}

function personLink(externalPersonId, individualId, overrides = {}) {
  return { externalPersonId, individualId, missingFullSyncCount: 0, linkSource: 'matched', ...overrides };
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

test('exports the pure source snapshot validators used by import orchestration', () => {
  const selected = source('group-1', 'Members');
  const complete = sourceSnapshot(selected, {
    people: [person('member')],
    memberExternalIds: ['member'],
    contextPeople: [person('context')],
  });

  assert.equal(isCompleteSourceSnapshot(complete, 'elvanto'), true);
  assert.equal(isCompleteSourceSnapshot({ ...complete, complete: false }, 'elvanto'), false);
  assert.equal(isCompleteSourceSnapshot({ ...complete, memberExternalIds: ['missing'] }, 'elvanto'), false);
  assert.equal(sameSourceIdentity(complete.source, selected), true);
  assert.equal(sameSourceIdentity(complete.source, source('other')), false);
  assert.deepEqual(snapshotDigestInput(complete).context[0].name, 'Ada\u0000Lovelace');
});

function makeDeps({
  batches = [batch()],
  authorityState = { active: 'elvanto', pending: null },
  fetchSourceSnapshot,
  lifecycleEligible = (value, settings) => value.state !== 'archived' && value.state !== 'deceased' &&
    (value.state !== 'contact' || settings.includeContacts !== false),
  localIndividuals = [],
  localFamilies = [],
  personLinks = [],
  familyLinks = [],
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
    getConnectionGeneration: async () => 17,
    getCredentials: async () => ({ apiKey: 'test-key' }),
    getProvider: () => adapter,
    listBatches: async () => batches,
    getSyncSettings: async () => ({ includeContacts: true, alignPeopleType: true }),
    getAuthority: async () => authorityState,
    getUnattendedProviderEnabled: async () => true,
    beginAuthoritySwitch: async () => ({ active: authorityState.active, pending: 'elvanto' }),
    cancelAuthoritySwitch: async () => ({ active: authorityState.active, pending: null }),
    startRun: async (input) => { events.push('startRun'); return { id: nextRunId++, ...input }; },
    finishRun: async (input) => { events.push('finishRun'); finished.push(input); return input; },
    failRun: async (input) => { events.push('failRun'); failed.push(input); return input; },
    recordActiveSourceAvailable: async (input) => { events.push(`available:${input.batchId}`); availableHealth.push(input); },
    recordActiveSourceFailure: async (input) => { events.push(`failure:${input.batchId}`); failedHealth.push(input); },
    loadLocalProjectionState: async () => ({
      individuals: localIndividuals,
      families: localFamilies,
      personLinks,
      familyLinks,
      gatheringMemberships,
      matchReviewState,
    }),
    recordFullFetchPresence: async (...args) => { events.push('presence'); presence.push(args); return {}; },
    matchPeople,
    computePeopleSyncPlan: (input) => { plans.push(input); return computePeopleSyncPlan(input); },
    applyPeopleSyncPlan: async (input) => {
      if (input.reviewedApply) {
        assert.equal(input.reviewedApply.operationKind,
          input.activateAuthority ? 'authority_switch' : 'people_sync');
      }
      events.push('apply');
      applied.push(input);
      return emptyApplyResult();
    },
    validateSelections: () => ({
      acceptedLinks: [], skipExternalPersonIds: new Set(), acceptedArchiveIndividualIds: new Set(), acceptedFamilyRenameIds: new Set(),
    }),
    digestPlan,
    createReviewToken: ({ operationKind, planDigest }) => {
      assert.ok(['people_sync', 'authority_switch'].includes(operationKind));
      return `review:${planDigest}`;
    },
    verifyReviewToken: (_token, expected) => {
      assert.ok(['people_sync', 'authority_switch'].includes(expected.operationKind));
      return verifyResult;
    },
    isReviewTokenApplied: async () => false,
    notifyReviewRequired: async () => ({ notified: true }),
    refreshBackgroundCheckStatuses: async () => ({
      fetchedAt: '2026-08-03T05:00:00.000Z',
      updated: 0, cleared: 0, notCleared: 0, unknown: 0,
    }),
    ...extra,
  };
  return { deps, events, finished, failed, applied, presence, availableHealth, failedHealth, plans };
}

function pcoApplyDeps(extra = {}) {
  const pcoSource = { kind: 'planning_center_list', externalId: 'list-1', name: 'Members' };
  return makeDeps({
    batches: [batch({ id: 1, provider: 'planning_center', source: pcoSource })],
    authorityState: { active: 'planning_center', pending: null },
    extra: {
      getProvider: () => ({
        provider: 'planning_center',
        validateConnection: async () => ({ ok: true }),
        listSources: async () => [],
        fetchSourceSnapshot: async () => ({
          provider: 'planning_center', source: pcoSource, complete: true,
          fetchedAt: '2026-08-03T04:00:00.000Z', providerRefreshedAt: null,
          memberExternalIds: ['pco-1'],
          people: [person('pco-1')], contextPeople: [], families: [],
        }),
        isLifecycleEligible: () => true,
      }),
      ...extra,
    },
  });
}

test('reviewed PCO apply refreshes supplementary background checks after roster apply', async () => {
  const order = [];
  const refreshedChurches = [];
  const { deps, finished } = pcoApplyDeps({
    applyPeopleSyncPlan: async () => { order.push('apply'); return emptyApplyResult(); },
    refreshBackgroundCheckStatuses: async (churchId) => {
      order.push('background');
      refreshedChurches.push(churchId);
      return { fetchedAt: '2026-08-03T05:00:00.000Z', updated: 7, cleared: 3, notCleared: 2, unknown: 2 };
    },
  });
  const result = await applyReviewed({
    churchId: 'church-a', provider: 'planning_center', batchId: 1,
    reviewToken: 'valid-review', selections: {}, userId: 1,
    onCriticalCommit: () => { order.push('commit'); },
  }, deps);

  assert.deepEqual(order, ['apply', 'commit', 'background']);
  assert.deepEqual(refreshedChurches, ['church-a']);
  assert.equal(result.applied.backgroundCheckSynced, 7);
  assert.equal(result.applied.backgroundCheckSyncFailed, 0);
  assert.equal(finished[0].counts.backgroundCheckSynced, 7);
});

test('unattended PCO apply refreshes background checks once', async () => {
  let refreshes = 0;
  const { deps } = pcoApplyDeps({
    refreshBackgroundCheckStatuses: async () => {
      refreshes += 1;
      return { fetchedAt: '2026-08-03T05:00:00.000Z', updated: 5, cleared: 5, notCleared: 0, unknown: 0 };
    },
  });
  const result = await runUnattended({
    churchId: 'church-a', provider: 'planning_center', batchId: 1,
  }, deps);

  assert.equal(refreshes, 1);
  assert.equal(result.counts.backgroundCheckSynced, 5);
  assert.equal(result.counts.backgroundCheckSyncFailed, 0);
});

test('background-check failure cannot fail an already-applied PCO run', async () => {
  const { deps, finished, failed } = pcoApplyDeps({
    refreshBackgroundCheckStatuses: async () => { throw new Error('supplementary read failed'); },
  });
  const result = await runUnattended({
    churchId: 'church-a', provider: 'planning_center', batchId: 1,
  }, deps);

  assert.equal(result.status, 'applied');
  assert.equal(result.counts.backgroundCheckSynced, 0);
  assert.equal(result.counts.backgroundCheckSyncFailed, 1);
  assert.equal(finished[0].status, 'applied');
  assert.equal(finished[0].counts.backgroundCheckSyncFailed, 1);
  assert.equal(failed.length, 0);
});

test('Elvanto apply and PCO preview do not refresh background checks', async () => {
  let refreshes = 0;
  const elvanto = makeDeps({ extra: {
    refreshBackgroundCheckStatuses: async () => { refreshes += 1; },
  } });
  await runUnattended({ churchId: 'church-a', provider: 'elvanto', batchId: 1 }, elvanto.deps);

  const pco = pcoApplyDeps({
    refreshBackgroundCheckStatuses: async () => { refreshes += 1; },
  });
  await buildReview({
    churchId: 'church-a', provider: 'planning_center', batchId: 1, trigger: 'manual',
  }, pco.deps);

  assert.equal(refreshes, 0);
});

test('failed PCO roster apply does not fetch supplementary background checks', async () => {
  let refreshes = 0;
  const applyError = Object.assign(new Error('transaction aborted'), { code: 'SYNC_PLAN_STALE', status: 409 });
  const { deps, finished, failed } = pcoApplyDeps({
    applyPeopleSyncPlan: async () => { throw applyError; },
    refreshBackgroundCheckStatuses: async () => { refreshes += 1; },
  });

  await assert.rejects(
    applyReviewed({
      churchId: 'church-a', provider: 'planning_center', batchId: 1,
      reviewToken: 'valid-review', selections: {}, userId: 1,
    }, deps),
    (error) => error instanceof OrchestratorError && error.code === 'SYNC_PLAN_STALE' && error.status === 409,
  );

  assert.equal(refreshes, 0);
  assert.equal(finished.length, 0);
  assert.equal(failed.length, 1);
});

function correctionPreviewDeps() {
  const providerReads = [];
  const started = [];
  const created = [];
  const tokenLineage = new Map();
  const external = person('ext-a', { firstName: 'External', lastName: 'Person' });
  const sourceState = { providerRefreshedAt: '2026-07-28T01:00:00.000Z' };
  const localIndividuals = [
    localPerson(10, 'Wrong', 'Person'),
    localPerson(20, 'External', 'Person'),
    localPerson(30, 'Spare', 'Person'),
  ];
  const personLinks = [personLink('ext-a', 10)];
  let expectedBaseDigest = null;
  const validBaseToken = 'base-review-token';
  const { deps, applied, presence } = makeDeps({
    localIndividuals,
    personLinks,
    fetchSourceSnapshot: async () => {
      providerReads.push('ext-a');
      return sourceSnapshot(source('group-1'), {
        people: [structuredClone(external)], memberExternalIds: ['ext-a'],
        providerRefreshedAt: sourceState.providerRefreshedAt,
      });
    },
    extra: {
      startRun: async (input) => {
        started.push(input);
        return { id: started.length, ...input };
      },
      createReviewToken: ({ operationKind, planDigest, basePlanDigest, rootReviewTokenDigest }) => {
        assert.equal(operationKind, 'people_sync');
        created.push(planDigest);
        const token = `review:${planDigest}`;
        if (basePlanDigest) tokenLineage.set(token, { basePlanDigest, rootReviewTokenDigest });
        return token;
      },
      verifyReviewToken: (token, { operationKind, planDigest }) => {
        assert.equal(operationKind, 'people_sync');
        if (token === 'invalid-base-token') return { ok: false, code: 'SYNC_REVIEW_INVALID' };
        if (token === 'expired-base-token') return { ok: false, code: 'SYNC_REVIEW_EXPIRED' };
        if (token === 'stale-base-token') return { ok: false, code: 'SYNC_PLAN_STALE' };
        if (token === validBaseToken) {
          if (expectedBaseDigest === null) expectedBaseDigest = planDigest;
          return planDigest === expectedBaseDigest
            ? { ok: true, payload: {} }
            : { ok: false, code: 'SYNC_PLAN_STALE' };
        }
        return token === `review:${planDigest}`
          ? { ok: true, payload: {
            rootReviewTokenDigest: tokenLineage.get(token)?.rootReviewTokenDigest,
          } }
          : { ok: false, code: 'SYNC_PLAN_STALE' };
      },
      verifyReviewTokenLineage: (token, { operationKind, basePlanDigest }) => {
        assert.equal(operationKind, 'people_sync');
        if (token === validBaseToken) {
          if (expectedBaseDigest === null) expectedBaseDigest = basePlanDigest;
          return basePlanDigest === expectedBaseDigest
            ? { ok: true }
            : { ok: false, code: 'SYNC_PLAN_STALE' };
        }
        return tokenLineage.get(token)?.basePlanDigest === basePlanDigest
          ? { ok: true }
          : { ok: false, code: 'SYNC_PLAN_STALE' };
      },
    },
  });
  deps.validBaseToken = validBaseToken;
  return {
    deps, providerReads, started, created, applied, presence, external, sourceState, personLinks,
  };
}

test('correction preview verifies the base review then signs the corrected plan without another provider read', async () => {
  const { deps, providerReads, started } = correctionPreviewDeps();
  const preview = await previewLinkCorrections({
    churchId: 'church-a', provider: 'elvanto', batchId: 1,
    baseReviewToken: deps.validBaseToken,
    linkCorrections: { 'ext-a': { outcome: 'relink', fromIndividualId: 10, individualId: 20 } },
  }, deps);
  assert.equal(providerReads.length, 1);
  assert.equal(started.length, 0, 'interactive correction previews must not create audit-run noise');
  assert.match(preview.reviewToken, /^review:/);
  assert.equal(preview.plan.reviewContext.linkCorrections[0].individualId, 20);
  assert.equal(Object.hasOwn(preview, 'runId'), false);
  assert.equal(preview.decisionContractVersion, 2);
  assert.deepEqual(Object.keys(preview).sort(), [
    'coverage', 'decisionContractVersion', 'plan', 'reviewToken', 'snapshot', 'summary',
  ]);
});

test('correction preview accepts a base token issued by buildReview without creating another audit run', async () => {
  const { deps, providerReads, started } = correctionPreviewDeps();
  const base = await buildReview({
    churchId: 'church-a', provider: 'elvanto', batchId: 1, trigger: 'manual',
  }, deps);
  assert.equal(started.length, 1);

  const preview = await previewLinkCorrections({
    churchId: 'church-a', provider: 'elvanto', batchId: 1,
    baseReviewToken: base.reviewToken,
    linkCorrections: { 'ext-a': { outcome: 'relink', fromIndividualId: 10, individualId: 20 } },
  }, deps);

  assert.equal(started.length, 1, 'the correction preview must not add an audit run');
  assert.equal(providerReads.length, 2, 'one build read plus one correction-preview read');
  assert.equal(preview.plan.reviewContext.linkCorrections[0].individualId, 20);
});

for (const invalidBase of [
  { token: 'invalid-base-token', code: 'SYNC_REVIEW_INVALID', status: 400 },
  { token: 'expired-base-token', code: 'SYNC_REVIEW_EXPIRED', status: 409 },
  { token: 'stale-base-token', code: 'SYNC_PLAN_STALE', status: 409 },
]) {
  test(`correction preview rejects a ${invalidBase.code} base review before signing`, async () => {
    const { deps, created, started } = correctionPreviewDeps();

    await assert.rejects(
      previewLinkCorrections({
        churchId: 'church-a', provider: 'elvanto', batchId: 1,
        baseReviewToken: invalidBase.token,
        linkCorrections: { 'ext-a': { outcome: 'unlink', fromIndividualId: 10 } },
      }, deps),
      (error) => error instanceof OrchestratorError &&
        error.code === invalidBase.code && error.status === invalidBase.status
    );
    assert.equal(created.length, 0);
    assert.equal(started.length, 0);
  });
}

test('correction preview verifies the base token before parsing submitted corrections', async () => {
  const { deps, created } = correctionPreviewDeps();

  await assert.rejects(
    previewLinkCorrections({
      churchId: 'church-a', provider: 'elvanto', batchId: 1,
      baseReviewToken: 'invalid-base-token', linkCorrections: 'malformed',
    }, deps),
    { code: 'SYNC_REVIEW_INVALID' }
  );
  assert.equal(created.length, 0);
});

test('correction preview rejects invalid established-link corrections after base verification', async () => {
  const { deps, created } = correctionPreviewDeps();

  await assert.rejects(
    previewLinkCorrections({
      churchId: 'church-a', provider: 'elvanto', batchId: 1,
      baseReviewToken: deps.validBaseToken,
      linkCorrections: { 'ext-a': { outcome: 'relink', fromIndividualId: 999, individualId: 20 } },
    }, deps),
    (error) => error instanceof OrchestratorError &&
      error.code === 'SYNC_SELECTIONS_INVALID' && error.status === 400 &&
      /stale established link.*ext-a/i.test(error.message)
  );
  assert.equal(created.length, 0);
});

test('correction preview cannot mint a descendant from an already-applied base token', async () => {
  const checked = [];
  const { deps, created } = correctionPreviewDeps();
  deps.isReviewTokenApplied = async (input) => {
    checked.push(input);
    return true;
  };

  await assert.rejects(
    previewLinkCorrections({
      churchId: 'church-a', provider: 'elvanto', batchId: 1,
      baseReviewToken: deps.validBaseToken,
      linkCorrections: { 'ext-a': { outcome: 'unlink', fromIndividualId: 10 } },
    }, deps),
    (error) => error instanceof OrchestratorError &&
      error.code === 'SYNC_REVIEW_ALREADY_APPLIED' && error.status === 409,
  );
  assert.deepEqual(checked, [{
    churchId: 'church-a', provider: 'elvanto', reviewToken: deps.validBaseToken,
    rootReviewTokenDigest: digestReviewToken(deps.validBaseToken),
  }]);
  assert.equal(created.length, 0);
});

test('an empty corrected descendant cannot launder an already-applied root into a new lineage', async () => {
  const { deps, created } = correctionPreviewDeps();
  const first = await previewLinkCorrections({
    churchId: 'church-a', provider: 'elvanto', batchId: 1,
    baseReviewToken: deps.validBaseToken,
    linkCorrections: {},
  }, deps);
  const originalRootDigest = digestReviewToken(deps.validBaseToken);
  const checked = [];
  deps.isReviewTokenApplied = async (input) => {
    checked.push(input);
    return input.rootReviewTokenDigest === originalRootDigest;
  };

  await assert.rejects(
    previewLinkCorrections({
      churchId: 'church-a', provider: 'elvanto', batchId: 1,
      baseReviewToken: first.reviewToken,
      linkCorrections: {},
    }, deps),
    (error) => error instanceof OrchestratorError &&
      error.code === 'SYNC_REVIEW_ALREADY_APPLIED' && error.status === 409,
  );
  assert.equal(checked[0].rootReviewTokenDigest, originalRootDigest);
  assert.equal(created.length, 1, 'an applied root must not sign a second empty descendant');
});

test('correction preview makes a base token stale when only the provider source snapshot changes', async () => {
  const { deps, sourceState, created } = correctionPreviewDeps();
  await previewLinkCorrections({
    churchId: 'church-a', provider: 'elvanto', batchId: 1,
    baseReviewToken: deps.validBaseToken, linkCorrections: {},
  }, deps);
  sourceState.providerRefreshedAt = '2026-07-29T01:00:00.000Z';

  await assert.rejects(
    previewLinkCorrections({
      churchId: 'church-a', provider: 'elvanto', batchId: 1,
      baseReviewToken: deps.validBaseToken,
      linkCorrections: { 'ext-a': { outcome: 'unlink', fromIndividualId: 10 } },
    }, deps),
    { code: 'SYNC_PLAN_STALE' }
  );
  assert.equal(created.length, 1, 'a stale base must not sign a second projection');
});

test('correction preview makes a base token stale when the durable local link changes', async () => {
  const { deps, personLinks, created } = correctionPreviewDeps();
  await previewLinkCorrections({
    churchId: 'church-a', provider: 'elvanto', batchId: 1,
    baseReviewToken: deps.validBaseToken, linkCorrections: {},
  }, deps);
  personLinks.splice(0, 1, personLink('ext-a', 20));

  await assert.rejects(
    previewLinkCorrections({
      churchId: 'church-a', provider: 'elvanto', batchId: 1,
      baseReviewToken: deps.validBaseToken,
      linkCorrections: { 'ext-a': { outcome: 'unlink', fromIndividualId: 10 } },
    }, deps),
    { code: 'SYNC_PLAN_STALE' }
  );
  assert.equal(created.length, 1, 'a stale base must not sign a second projection');
});

test('equivalent correction maps produce the same canonical corrected plan digest', async () => {
  const { deps, created } = correctionPreviewDeps();
  const first = await previewLinkCorrections({
    churchId: 'church-a', provider: 'elvanto', batchId: 1,
    baseReviewToken: deps.validBaseToken,
    linkCorrections: { 'ext-a': { outcome: 'relink', fromIndividualId: 10, individualId: 20 } },
  }, deps);
  const second = await previewLinkCorrections({
    churchId: 'church-a', provider: 'elvanto', batchId: 1,
    baseReviewToken: deps.validBaseToken,
    linkCorrections: [{ individualId: 20, outcome: 'relink', fromIndividualId: 10, externalPersonId: 'ext-a' }],
  }, deps);

  assert.equal(created[0], created[1]);
  assert.deepEqual(second.plan.reviewContext.linkCorrections, [
    { externalPersonId: 'ext-a', fromIndividualId: 10, outcome: 'relink', individualId: 20 },
  ]);
});

test('plan digest retains canonical established-link corrections independently of other plan actions', () => {
  const base = {
    provider: 'elvanto',
    authoritative: true,
    snapshot: { fetchedAt: '2026-07-29T01:00:00.000Z', mode: 'full' },
    reviewContext: {
      version: 2,
      correctionContractVersion: 1,
      linkCorrections: [
        { externalPersonId: 'ext-a', fromIndividualId: 10, outcome: 'relink', individualId: 20 },
      ],
    },
  };
  const equivalent = {
    reviewContext: {
      linkCorrections: [
        { individualId: 20, outcome: 'relink', fromIndividualId: 10, externalPersonId: 'ext-a' },
      ],
      correctionContractVersion: 1,
      version: 2,
    },
    snapshot: { mode: 'full', fetchedAt: '2026-07-30T01:00:00.000Z' },
    authoritative: true,
    provider: 'elvanto',
  };
  const changed = structuredClone(base);
  changed.reviewContext.linkCorrections[0].individualId = 30;

  assert.equal(digestPlan(equivalent), digestPlan(base));
  assert.notEqual(digestPlan(changed), digestPlan(base));
});

test('a relink projection manages the new local person from one provider read without clearing null fields', async () => {
  const providerReads = [];
  const external = person('ext-a', { firstName: null, lastName: 'Correct' });
  const { deps } = makeDeps({
    localIndividuals: [
      localPerson(10, 'Wrong', 'Target'),
      localPerson(20, 'Known', 'Old'),
    ],
    personLinks: [personLink('ext-a', 10)],
    fetchSourceSnapshot: async () => {
      providerReads.push('ext-a');
      return sourceSnapshot(source('group-1'), { people: [external], memberExternalIds: ['ext-a'] });
    },
  });

  const review = await buildReview({
    churchId: 'church-a', provider: 'elvanto', batchId: 1, trigger: 'manual',
    linkCorrections: { 'ext-a': { outcome: 'relink', fromIndividualId: 10, individualId: 20 } },
  }, deps);

  assert.equal(providerReads.length, 1);
  assert.deepEqual(review.plan.updateManagedFields, [{
    id: 'updateManagedFields:ext-a:20', externalPersonId: 'ext-a', individualId: 20,
    changes: [{ field: 'lastName', localValue: 'Old', externalValue: 'Correct' }],
    reason: 'provider_managed_fields', reviewRequired: false,
  }]);
  assert.deepEqual(review.plan.reviewContext.linkCorrections, [
    { externalPersonId: 'ext-a', fromIndividualId: 10, outcome: 'relink', individualId: 20 },
  ]);
});

test('an unlink projection defers the source identity without removing it from source presence', async () => {
  const providerReads = [];
  const external = person('ext-a', { firstName: 'External', lastName: 'Person' });
  const { deps, plans } = makeDeps({
    batches: [batch({ gatheringTypeId: 100 })],
    localIndividuals: [localPerson(10, 'Local', 'Person', {
      peopleType: 'local_visitor', isActive: false,
    })],
    personLinks: [personLink('ext-a', 10)],
    fetchSourceSnapshot: async () => {
      providerReads.push('ext-a');
      return sourceSnapshot(source('group-1'), { people: [external], memberExternalIds: ['ext-a'] });
    },
  });

  const review = await buildReview({
    churchId: 'church-a', provider: 'elvanto', batchId: 1, trigger: 'manual',
    linkCorrections: { 'ext-a': { outcome: 'unlink', fromIndividualId: 10 } },
  }, deps);

  assert.equal(providerReads.length, 1);
  for (const bucketName of [
    'linkPeople', 'addPeople', 'updateManagedFields', 'promoteToRegular',
    'demoteToLocalVisitor', 'archive', 'reactivate', 'addToGathering',
  ]) {
    assert.equal(review.plan[bucketName].some((action) => action.externalPersonId === 'ext-a'), false,
      `${bucketName} must not act on a deliberately unlinked identity`);
  }
  assert.deepEqual(review.plan.skipped, [{
    id: 'skipped:ext-a:link_correction_deferred',
    externalPersonId: 'ext-a', reason: 'link_correction_deferred',
  }]);
  assert.deepEqual(plans[0].externalPeople.map(({ id }) => id), ['ext-a']);
  assert.deepEqual([...plans[0].eligibleByBatch.get(1)], ['ext-a']);
});

test('a reviewed corrected unlink does not schedule durable presence accounting', async () => {
  const { deps, presence } = correctionPreviewDeps();
  const linkCorrections = {
    'ext-a': { outcome: 'unlink', fromIndividualId: 10 },
  };
  const preview = await previewLinkCorrections({
    churchId: 'church-a', provider: 'elvanto', batchId: 1,
    baseReviewToken: deps.validBaseToken,
    linkCorrections,
  }, deps);

  await applyReviewed({
    churchId: 'church-a', provider: 'elvanto', batchId: 1,
    reviewToken: preview.reviewToken,
    selections: { linkCorrections },
    userId: 1,
  }, deps);

  assert.equal(presence.length, 0);
});

test('a batch review cannot correct an established identity owned by another enabled batch source', async () => {
  const { deps } = makeDeps({
    batches: [batch({ id: 1, source: source('one') }), batch({ id: 2, source: source('two') })],
    localIndividuals: [localPerson(10, 'One', 'Person'), localPerson(20, 'Two', 'Person')],
    personLinks: [personLink('ext-two', 20)],
    fetchSourceSnapshot: async ({ sourceExternalId }) => sourceExternalId === 'one'
      ? sourceSnapshot(source('one'), { people: [person('ext-one')], memberExternalIds: ['ext-one'] })
      : sourceSnapshot(source('two'), { people: [person('ext-two')], memberExternalIds: ['ext-two'] }),
  });

  await assert.rejects(
    buildReview({
      churchId: 'church-a', provider: 'elvanto', batchId: 1, trigger: 'manual',
      linkCorrections: { 'ext-two': { outcome: 'unlink', fromIndividualId: 20 } },
    }, deps),
    /outside the reviewed source.*ext-two/i
  );
});

test('pipeline acquisition delegates church-scoped local reads to the projection-state loader', async () => {
  const calls = [];
  const { deps } = makeDeps({
    extra: {
      loadLocalProjectionState: async (churchId, provider) => {
        calls.push([churchId, provider]);
        return {
          individuals: [], families: [], personLinks: [], familyLinks: [], gatheringMemberships: [],
          matchReviewState: { exclusions: [], holds: [] },
        };
      },
    },
  });

  await buildReview({ churchId: 'church-a', provider: 'elvanto', batchId: 1, trigger: 'manual' }, deps);

  assert.deepEqual(calls, [['church-a', 'elvanto']]);
});

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
  assert.deepEqual(availableHealth[0].connectionExpectation, { generation: 17 });
});

test('target review ignores other initial source drafts until they are reviewed', async () => {
  const reads = [];
  const batches = [
    batch({ id: 20, source: null, initialSourceReviewPending: true, draftSource: source('am-draft'), draftSourceBaseRevision: 1 }),
    batch({ id: 21, source: null, initialSourceReviewPending: true, draftSource: source('pm-draft'), draftSourceBaseRevision: 1 }),
  ];
  const { deps, finished } = makeDeps({
    batches,
    fetchSourceSnapshot: async (input) => {
      reads.push(input.sourceExternalId);
      return sourceSnapshot(source(input.sourceExternalId));
    },
  });

  await buildReview({ churchId: 'church-a', provider: 'elvanto', batchId: 20, trigger: 'manual' }, deps);

  assert.deepEqual(reads, ['am-draft']);
  assert.equal(finished[0].status, 'review_required');
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

test('Elvanto reconciliation snapshots the durable connection generation before reading credentials', async () => {
  // Reading in this order prevents old credentials from ever being paired
  // with a newer generation when a reconnect commits between the two reads.
  const reads = [];
  const { deps } = makeDeps({
    extra: {
      getConnectionGeneration: async () => { reads.push('generation'); return 23; },
      getCredentials: async () => { reads.push('credentials'); return { apiKey: 'test-key' }; },
    },
  });

  await buildReview({ churchId: 'church-a', provider: 'elvanto', trigger: 'manual' }, deps);

  assert.deepEqual(reads, ['generation', 'credentials']);
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

test('Elvanto local-only count ignores source matches and Planning Center compatibility IDs', async () => {
  const localIndividuals = [
    localPerson(11, 'Durable', 'Elvanto'),
    localPerson(12, 'Legacy', 'Planning Center', { planningCenterId: 'pco-legacy' }),
    localPerson(13, 'Source', 'Match'),
    localPerson(14, 'Inactive', 'Regular', { isActive: false }),
    localPerson(15, 'Local', 'Visitor', { peopleType: 'local_visitor' }),
  ];
  const { deps } = makeDeps({
    localIndividuals,
    personLinks: [personLink('elvanto-linked', 11)],
    fetchSourceSnapshot: async () => sourceSnapshot(source('group-1'), {
      people: [person('source-match', { firstName: 'Source', lastName: 'Match' })],
      memberExternalIds: ['source-match'],
    }),
  });

  const review = await buildReview({
    churchId: 'church-a', provider: 'elvanto', trigger: 'manual',
  }, deps);

  assert.equal(review.coverage.unlinkedActiveLocalRegulars, 2);
});

test('Planning Center local-only count honours compatibility IDs and PCO-scoped durable links', async () => {
  const selectedSource = { kind: 'planning_center_list', externalId: 'list-1', name: 'Members' };
  const localIndividuals = [
    localPerson(21, 'Other', 'Provider'),
    localPerson(22, 'Legacy', 'Planning Center', { planningCenterId: 'pco-legacy' }),
    localPerson(23, 'Durable', 'Planning Center'),
    localPerson(24, 'Unlinked', 'Planning Center'),
    localPerson(25, 'Inactive', 'Planning Center', { isActive: false }),
  ];
  const { deps } = makeDeps({
    batches: [batch({ provider: 'planning_center', source: selectedSource })],
    authorityState: { active: 'planning_center', pending: null },
    localIndividuals,
    personLinks: [personLink('pco-linked', 23)],
    extra: {
      getProvider: () => ({
        provider: 'planning_center',
        fetchSourceSnapshot: async () => ({
          provider: 'planning_center',
          source: selectedSource,
          complete: true,
          fetchedAt: '2026-08-03T01:00:00.000Z',
          providerRefreshedAt: null,
          memberExternalIds: [],
          people: [],
          contextPeople: [],
          families: [],
        }),
        isLifecycleEligible: () => true,
      }),
    },
  });

  const review = await buildReview({
    churchId: 'church-a', provider: 'planning_center', trigger: 'manual',
  }, deps);

  assert.equal(review.coverage.unlinkedActiveLocalRegulars, 2);
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
  const localFamilies = [
    { id: 10, familyName: 'Smith, Bob' },
    { id: 20, familyName: 'Other Smiths' },
  ];
  const familyLinks = [];
  const { deps, plans, presence, applied } = makeDeps({
    localIndividuals: locals,
    localFamilies,
    personLinks,
    familyLinks,
    fetchSourceSnapshot: async () => sourceSnapshot(source('group-1'), {
      people: [member], memberExternalIds: ['member'], contextPeople: [context],
      families: [{ id: 'external-family', memberExternalIds: ['member', 'context'], primaryContactExternalId: 'context' }],
    }),
  });

  await runUnattended({ churchId: 'church-a', provider: 'elvanto', batchId: 1 }, deps);

  assert.deepEqual([...plans[0].eligibleByBatch.get(1)], ['member']);
  assert.deepEqual(plans[0].externalPeople.map((item) => item.id), ['member']);
  assert.deepEqual(plans[0].externalFamilies, [{
    id: 'external-family', memberExternalIds: ['member', 'context'],
    primaryContactExternalId: 'context',
  }]);
  assert.deepEqual(plans[0].householdPeople.map((item) => item.id).sort(), ['context', 'member']);
  assert.deepEqual(plans[0].localFamilies, localFamilies);
  assert.deepEqual(plans[0].familyLinks, familyLinks);
  assert.deepEqual(applied[0].plan.linkPeople.map((item) => [item.externalPersonId, item.individualId]), [['member', 1]]);
  for (const bucketName of ['addPeople', 'reactivate', 'addToGathering']) {
    assert.equal(applied[0].plan[bucketName].some((item) => item.externalPersonId === 'context'), false);
  }
  assert.equal(presence.length, 0);
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
    correctionContractVersion: 1,
    manualCandidateIndividualIds: [7, 8, 9],
    localIdentityDigest: signedPlan.reviewContext.localIdentityDigest,
    establishedLinks: {},
    projectedEstablishedLinks: {},
    linkCorrections: [],
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
      loadLocalProjectionState: async () => ({
        individuals: [
          { id: 7, firstName: 'Alex', lastName: 'Smith', peopleType: 'regular', familyId: null, isChild: false, isActive: true },
          { id: 8, firstName: 'Alex', lastName: 'Smith', peopleType: 'regular', familyId: null, isChild: false, isActive: true },
          { id: 9, firstName: 'Alex', lastName: 'Smith', peopleType: 'regular', familyId: null, isChild: false, isActive: true },
        ],
        families: [], personLinks: [], familyLinks: [], gatheringMemberships: [], matchReviewState: reviewState,
      }),
      digestPlan: (plan) => {
        assert.equal(plan.reviewContext?.version, 2);
        return digestPlan(plan);
      },
      createReviewToken: ({ operationKind, planDigest }) => {
        assert.equal(operationKind, 'people_sync');
        signedDigest = planDigest;
        return `review:${planDigest}`;
      },
      verifyReviewToken: (token, { operationKind, planDigest }) => {
        assert.equal(operationKind, 'people_sync');
        return token === `review:${planDigest}` && planDigest === signedDigest
          ? { ok: true }
          : { ok: false, code: 'SYNC_PLAN_STALE' };
      },
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

test('reviewed apply rebuilds the signed corrected projection from submitted link corrections', async () => {
  const { deps, applied } = correctionPreviewDeps();
  const linkCorrections = {
    'ext-a': { outcome: 'relink', fromIndividualId: 10, individualId: 20 },
  };
  const preview = await previewLinkCorrections({
    churchId: 'church-a', provider: 'elvanto', batchId: 1,
    baseReviewToken: deps.validBaseToken, linkCorrections,
  }, deps);

  const result = await applyReviewed({
    churchId: 'church-a', provider: 'elvanto', batchId: 1,
    reviewToken: preview.reviewToken, selections: { linkCorrections }, userId: 1,
  }, deps);

  assert.equal(result.status, 'applied');
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0].plan.reviewContext.linkCorrections, [
    { externalPersonId: 'ext-a', fromIndividualId: 10, outcome: 'relink', individualId: 20 },
  ]);
});

test('a corrected apply token becomes stale when the submitted correction set differs', async () => {
  const { deps, applied } = correctionPreviewDeps();
  const preview = await previewLinkCorrections({
    churchId: 'church-a', provider: 'elvanto', batchId: 1,
    baseReviewToken: deps.validBaseToken,
    linkCorrections: { 'ext-a': { outcome: 'relink', fromIndividualId: 10, individualId: 20 } },
  }, deps);

  await assert.rejects(
    applyReviewed({
      churchId: 'church-a', provider: 'elvanto', batchId: 1,
      reviewToken: preview.reviewToken,
      selections: {
        linkCorrections: { 'ext-a': { outcome: 'relink', fromIndividualId: 10, individualId: 30 } },
      },
      userId: 1,
    }, deps),
    { code: 'SYNC_PLAN_STALE' }
  );
  assert.equal(applied.length, 0);
});

test('reviewed apply types malformed correction projection as a selection error when its base is current', async () => {
  const { deps, applied } = correctionPreviewDeps();

  await assert.rejects(
    applyReviewed({
      churchId: 'church-a', provider: 'elvanto', batchId: 1,
      reviewToken: deps.validBaseToken,
      selections: {
        linkCorrections: {
          'ext-a': { outcome: 'relink', fromIndividualId: 10, individualId: 0 },
        },
      },
      userId: 1,
    }, deps),
    (error) => error instanceof OrchestratorError &&
      error.code === 'SYNC_SELECTIONS_INVALID' && error.status === 400,
  );
  assert.equal(applied.length, 0);
});

test('reviewed apply does not treat present falsey correction payloads as omitted', async () => {
  for (const linkCorrections of [null, false, 0, '']) {
    const { deps, applied } = correctionPreviewDeps();
    await assert.rejects(
      applyReviewed({
        churchId: 'church-a', provider: 'elvanto', batchId: 1,
        reviewToken: deps.validBaseToken,
        selections: { linkCorrections },
        userId: 1,
      }, deps),
      (error) => error instanceof OrchestratorError &&
        error.code === 'SYNC_SELECTIONS_INVALID' && error.status === 400,
      String(linkCorrections),
    );
    assert.equal(applied.length, 0);
  }
});

test('reviewed apply keeps a changed correction base typed as a stale plan', async () => {
  const { deps, personLinks, applied } = correctionPreviewDeps();
  const linkCorrections = {
    'ext-a': { outcome: 'relink', fromIndividualId: 10, individualId: 20 },
  };
  const preview = await previewLinkCorrections({
    churchId: 'church-a', provider: 'elvanto', batchId: 1,
    baseReviewToken: deps.validBaseToken,
    linkCorrections,
  }, deps);
  personLinks.splice(0, 1, personLink('ext-a', 30));

  await assert.rejects(
    applyReviewed({
      churchId: 'church-a', provider: 'elvanto', batchId: 1,
      reviewToken: preview.reviewToken,
      selections: { linkCorrections },
      userId: 1,
    }, deps),
    (error) => error instanceof OrchestratorError &&
      error.code === 'SYNC_PLAN_STALE' && error.status === 409,
  );
  assert.equal(applied.length, 0);
});

test('an old base review token remains valid only when the submitted correction set is empty', async () => {
  const { deps, applied } = correctionPreviewDeps();
  const baseApply = await applyReviewed({
    churchId: 'church-a', provider: 'elvanto', batchId: 1,
    reviewToken: deps.validBaseToken, selections: {}, userId: 1,
  }, deps);
  assert.equal(baseApply.status, 'applied');

  await assert.rejects(
    applyReviewed({
      churchId: 'church-a', provider: 'elvanto', batchId: 1,
      reviewToken: deps.validBaseToken,
      selections: {
        linkCorrections: { 'ext-a': { outcome: 'unlink', fromIndividualId: 10 } },
      },
      userId: 1,
    }, deps),
    { code: 'SYNC_PLAN_STALE' }
  );
  assert.equal(applied.length, 1);
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
    counts: { archive: 0, ambiguousPeople: 1, familyConflicts: 0, renameFamily: 0, unmatchedLocalRegulars: 0 },
  }]);
});

test('an unlinked lifecycle-ineligible member cannot match or act', async () => {
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
  assert.deepEqual(plans[0].externalPeople.map((item) => item.id), ['active', 'archived']);
  assert.deepEqual(matchingInputs[0].map((item) => item.id), ['active']);
  assert.equal(BUCKETS.some((bucket) => applied[0].plan[bucket].some((item) => item.externalPersonId === 'archived')), false);
  assert.deepEqual(applied[0].plan.unmatchedLocalRegulars, []);
  assert.equal(presence.length, 0);
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
    assert.equal(presence.length, 0);
  });
}

test('a linked terminal member reaches planning through its durable identity and proposes archive', async () => {
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
  assert.deepEqual(plans[0].externalPeople.map((item) => item.id), ['archived']);
  assert.deepEqual(plans[0].personLinks, [{ externalPersonId: 'archived', individualId: 9 }]);
  assert.deepEqual(applied[0].plan.archive, [{
    id: 'archive:archived:9', externalPersonId: 'archived', individualId: 9,
    reason: 'provider_state_archived',
  }]);
  assert.deepEqual(applied[0].plan.unmatchedLocalRegulars, []);
  assert.equal(presence.length, 0);
});

test('a complete empty source is accepted', async () => {
  const { deps, finished } = makeDeps({
    fetchSourceSnapshot: async () => sourceSnapshot(source('group-1'), { people: [], memberExternalIds: [] }),
  });
  const review = await buildReview({ churchId: 'church-a', provider: 'elvanto', batchId: 1, trigger: 'manual' }, deps);
  assert.equal(review.summary.addPeople, 0);
  assert.equal(finished[0].status, 'review_required');
});

test('a prepared batch rejects ordinary manual review before starting an audit run or fetching the provider', async () => {
  let fetches = 0;
  const { deps, events } = makeDeps({
    authorityState: { active: 'planning_center', pending: null },
    fetchSourceSnapshot: async () => { fetches += 1; return sourceSnapshot(source('group-1')); },
  });

  await assert.rejects(
    buildReview({ churchId: 'church-a', provider: 'elvanto', batchId: 1, trigger: 'manual' }, deps),
    (error) => error instanceof OrchestratorError &&
      error.code === 'SYNC_BATCH_PREPARED' && error.status === 409 &&
      error.message === 'This batch is prepared for a different people source. Switch source of truth before reviewing or running it.'
  );
  assert.equal(events.includes('startRun'), false);
  assert.equal(fetches, 0);
});

test('a prepared batch rejects ordinary reviewed apply before starting an audit run or fetching the provider', async () => {
  let fetches = 0;
  const { deps, events } = makeDeps({
    authorityState: { active: 'planning_center', pending: null },
    fetchSourceSnapshot: async () => { fetches += 1; return sourceSnapshot(source('group-1')); },
  });

  await assert.rejects(
    applyReviewed({
      churchId: 'church-a', provider: 'elvanto', batchId: 1,
      reviewToken: 'review-token', selections: {}, userId: 5,
    }, deps),
    (error) => error instanceof OrchestratorError &&
      error.code === 'SYNC_BATCH_PREPARED' && error.status === 409
  );
  assert.equal(events.includes('startRun'), false);
  assert.equal(fetches, 0);
});

test('a batch-specific apply remains prepared and blocked while an authority preview targets its provider', async () => {
  let fetches = 0;
  const { deps, events } = makeDeps({
    authorityState: { active: 'planning_center', pending: 'elvanto' },
    fetchSourceSnapshot: async () => { fetches += 1; return sourceSnapshot(source('group-1')); },
    extra: { getAuthorityPreviewIntent: async () => null },
  });

  await assert.rejects(
    applyReviewed({
      churchId: 'church-a', provider: 'elvanto', batchId: 1,
      reviewToken: 'review-token', selections: {}, userId: 5,
    }, deps),
    (error) => error instanceof OrchestratorError && error.code === 'SYNC_BATCH_PREPARED' && error.status === 409
  );
  assert.equal(events.includes('startRun'), false);
  assert.equal(fetches, 0);
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
  const { deps, failedHealth } = makeDeps({
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
  assert.deepEqual(failedHealth[0].connectionExpectation, { generation: 17 });
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
  assert.equal(digested.sourceContext.connectionGeneration, 17);
  assert.equal(digested.sourceContext.activeRevision, 9);
  assert.equal(digested.sourceContext.draftDigest, digestSourceIdentity(draft));
  assert.deepEqual(digested.sourceContext.snapshots.map((item) => item.batchId), [3, 20]);
  assert.deepEqual(Object.keys(digested.sourceContext.snapshots[0]).sort(), [
    'batchId', 'snapshotDigest', 'sourceExternalId', 'sourceKind', 'sourceRevision',
  ]);
  assert.deepEqual(digested.sourceContext.snapshots.map((item) => item.sourceRevision), [4, 9]);
  assert.ok(digested.sourceContext.snapshots.every((item) => /^[a-f0-9]{64}$/.test(item.snapshotDigest)));
});

test('Planning Center review source context omits the Elvanto-only connection generation', async () => {
  let digested;
  const planningCenterSource = { kind: 'planning_center_list', externalId: 'list-1', name: 'Members' };
  const { deps } = makeDeps({
    batches: [batch({ provider: 'planning_center', source: planningCenterSource })],
    authorityState: { active: 'planning_center', pending: null },
    fetchSourceSnapshot: async () => sourceSnapshot(planningCenterSource, { provider: 'planning_center' }),
    extra: {
      getConnectionGeneration: async () => { throw new Error('Planning Center must not read an Elvanto generation'); },
      digestPlan: (plan) => { digested = structuredClone(plan); return 'a'.repeat(64); },
    },
  });

  await buildReview({
    churchId: 'church-a', provider: 'planning_center', batchId: 1, trigger: 'manual',
  }, deps);

  assert.equal(Object.hasOwn(digested.sourceContext, 'connectionGeneration'), false);
});

test('reviewed apply sends source promotion CAS data without scheduling a presence write', async () => {
  const draft = source('draft');
  const reviewed = batch({ source: source('active'), sourceRevision: 6, draftSource: draft, draftSourceBaseRevision: 6 });
  const { deps, applied, presence } = makeDeps({ batches: [reviewed] });
  const result = await applyReviewed({
    churchId: 'church-a', provider: 'elvanto', batchId: 1, reviewToken: 'review-token', selections: {}, userId: 5,
  }, deps);

  assert.equal(result.status, 'applied');
  assert.deepEqual(applied[0].sourcePromotions, [{
    batchId: 1, expectedBaseRevision: 6, expectedDraftDigest: digestSourceIdentity(draft),
  }]);
  assert.deepEqual(applied[0].authorityExpectation, { active: 'elvanto', pending: null });
  assert.deepEqual(applied[0].sourceExpectations, [{
    batchId: 1,
    sourceRevision: 6,
    activeSourceDigest: digestSourceIdentity(source('active')),
    draftSourceDigest: digestSourceIdentity(draft),
    draftSourceBaseRevision: 6,
    selectedSource: 'draft',
  }]);
  assert.equal(applied[0].requireConnection, true);
  assert.deepEqual(applied[0].connectionExpectation, { generation: 17 });
  assert.equal(Object.hasOwn(applied[0], 'filterPromotion'), false);
  assert.equal(applied[0].reviewedApply.reviewToken, 'review-token');
  assert.match(applied[0].reviewedApply.planDigest, /^[a-f0-9]{64}$/);
  assert.equal(presence.length, 0);
});

test('legacy authority apply requires no owned intent and does not schedule a presence write', async () => {
  const { deps, applied, presence } = makeDeps({
    authorityState: { active: 'none', pending: 'elvanto' },
    extra: {
      getAuthorityPreviewIntent: async () => null,
    },
  });

  await applyReviewed({
    churchId: 'church-a', provider: 'elvanto', batchId: null,
    reviewToken: 'legacy-review-token', selections: {}, userId: 5,
  }, deps);

  assert.equal(applied[0].activateAuthority, true);
  assert.equal(applied[0].authorityPreviewId, null);
  assert.deepEqual(applied[0].authorityExpectation, {
    active: 'none', pending: 'elvanto', authorityPreviewId: null,
  });
  assert.equal(presence.length, 0);
});

test('authority apply rebuilds every draft-aware candidate and sends all signed promotions atomically', async () => {
  const firstDraft = source('draft-20');
  const secondDraft = source('draft-3');
  const fetched = [];
  const batches = [
    batch({ id: 20, source: null, sourceRevision: 0, draftSource: firstDraft, draftSourceBaseRevision: 0 }),
    batch({ id: 3, source: source('active-3'), sourceRevision: 4, draftSource: secondDraft, draftSourceBaseRevision: 4 }),
  ];
  const { deps, applied } = makeDeps({
    batches,
    authorityState: { active: 'none', pending: 'elvanto' },
    fetchSourceSnapshot: async ({ sourceExternalId }) => {
      fetched.push(sourceExternalId);
      return sourceSnapshot(source(sourceExternalId), { people: [], memberExternalIds: [] });
    },
    extra: {
      getAuthorityPreviewIntent: async () => ({ provider: 'elvanto', authorityPreviewId: 'authority-preview-1' }),
    },
  });

  await applyReviewed({
    churchId: 'church-a', provider: 'elvanto', batchId: null,
    reviewToken: 'authority-review-token', selections: {}, userId: 5,
  }, deps);

  assert.deepEqual(fetched, ['draft-3', 'draft-20']);
  assert.deepEqual(applied[0].sourcePromotions, [
    { batchId: 3, expectedBaseRevision: 4, expectedDraftDigest: digestSourceIdentity(secondDraft) },
    { batchId: 20, expectedBaseRevision: 0, expectedDraftDigest: digestSourceIdentity(firstDraft) },
  ]);
  assert.deepEqual(applied[0].plan.sourceContext.promotions, applied[0].sourcePromotions);
  assert.equal(applied[0].plan.authorityPreviewId, 'authority-preview-1');
  assert.equal(applied[0].activateAuthority, true);
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

test('a connection removed before transactional apply remains a typed safe failure', async () => {
  const disconnected = Object.assign(
    new Error('A usable Elvanto connection is required to apply this reconciliation.'),
    { code: 'SYNC_NOT_CONNECTED', status: 409 }
  );
  const { deps, failed } = makeDeps({
    extra: {
      applyPeopleSyncPlan: async () => { throw disconnected; },
    },
  });

  await assert.rejects(
    applyReviewed({
      churchId: 'church-a', provider: 'elvanto', batchId: 1,
      reviewToken: 'review-token', selections: {}, userId: 5,
    }, deps),
    (error) => error instanceof OrchestratorError &&
      error.code === 'SYNC_NOT_CONNECTED' && error.status === 409
  );
  assert.equal(failed[0].errorCode, 'SYNC_NOT_CONNECTED');
});

test('scheduled source sync is full-only, persists provenance, and does not schedule a presence write', async () => {
  const { deps, events, finished, presence, applied } = makeDeps({ batches: [batch({ lastExternalWatermark: 'legacy-watermark' })] });
  const result = await runUnattended({ churchId: 'church-a', provider: 'elvanto', batchId: 1, forceFull: false }, deps);

  assert.equal(result.fetchMode, 'full');
  assert.equal(result.externalWatermark, null);
  assert.equal(presence.length, 0);
  assert.deepEqual(applied[0].authorityExpectation, { active: 'elvanto', pending: null });
  assert.deepEqual(applied[0].connectionExpectation, { generation: 17 });
  assert.deepEqual(applied[0].sourceExpectations, [{
    batchId: 1,
    sourceRevision: 2,
    activeSourceDigest: digestSourceIdentity(source('group-1', 'Members')),
    draftSourceDigest: null,
    draftSourceBaseRevision: null,
    selectedSource: 'active',
  }]);
  assert.equal(events.includes('presence'), false);
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
    unlinkedActiveLocalRegulars: 1,
  });
  assert.equal(applied.length, 0);
  assert.equal(presence.length, 0);
});

test('authority preview uses an initial source draft and signs its promotion without active-source health writes', async () => {
  const initialDraft = source('initial-draft');
  let digested;
  let tokenContext;
  const fetched = [];
  const { deps, finished, availableHealth, failedHealth } = makeDeps({
    batches: [batch({
      source: null,
      sourceRevision: 0,
      draftSource: initialDraft,
      draftSourceBaseRevision: 0,
    })],
    authorityState: { active: 'none', pending: null },
    fetchSourceSnapshot: async ({ sourceExternalId }) => {
      fetched.push(sourceExternalId);
      return sourceSnapshot(source(sourceExternalId));
    },
    extra: {
      digestPlan: (plan) => { digested = structuredClone(plan); return 'a'.repeat(64); },
      createReviewToken: (context) => { tokenContext = context; return 'authority-review'; },
    },
  });

  await previewAuthoritySwitch({
    churchId: 'church-a', provider: 'elvanto', authorityPreviewId: 'initial-preview',
  }, deps);

  assert.deepEqual(fetched, ['initial-draft']);
  assert.deepEqual(finished[0].sourceProvenance.map(({ batchId, sourceExternalId }) => ({
    batchId, sourceExternalId,
  })), [{ batchId: 1, sourceExternalId: 'initial-draft' }]);
  assert.deepEqual(digested.sourceContext.promotions, [{
    batchId: 1,
    expectedBaseRevision: 0,
    expectedDraftDigest: digestSourceIdentity(initialDraft),
  }]);
  assert.match(digested.sourceContext.participatingBatchSourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(tokenContext.operationKind, 'authority_switch');
  assert.deepEqual(availableHealth, []);
  assert.deepEqual(failedHealth, []);
});

test('authority preview fetches and signs every initial draft in deterministic batch order', async () => {
  const drafts = [source('draft-20'), source('draft-3')];
  let digested;
  const fetched = [];
  const { deps, finished, availableHealth } = makeDeps({
    batches: [
      batch({ id: 20, source: null, sourceRevision: 5, draftSource: drafts[0], draftSourceBaseRevision: 5 }),
      batch({ id: 3, source: null, sourceRevision: 2, draftSource: drafts[1], draftSourceBaseRevision: 2 }),
    ],
    authorityState: { active: 'none', pending: null },
    fetchSourceSnapshot: async ({ sourceExternalId }) => {
      fetched.push(sourceExternalId);
      return sourceSnapshot(source(sourceExternalId), { people: [], memberExternalIds: [] });
    },
    extra: {
      digestPlan: (plan) => { digested = structuredClone(plan); return 'a'.repeat(64); },
    },
  });

  await previewAuthoritySwitch({
    churchId: 'church-a', provider: 'elvanto', authorityPreviewId: 'two-drafts',
  }, deps);

  assert.deepEqual(fetched, ['draft-3', 'draft-20']);
  assert.deepEqual(finished[0].sourceProvenance.map(({ batchId }) => batchId), [3, 20]);
  assert.deepEqual(digested.sourceContext.promotions, [
    { batchId: 3, expectedBaseRevision: 2, expectedDraftDigest: digestSourceIdentity(drafts[1]) },
    { batchId: 20, expectedBaseRevision: 5, expectedDraftDigest: digestSourceIdentity(drafts[0]) },
  ]);
  assert.deepEqual(digested.sourceContext.snapshots.map(({ batchId }) => batchId), [3, 20]);
  assert.deepEqual(availableHealth, []);
});

test('authority preview uses a replacement draft instead of its active source and excludes disabled batches', async () => {
  const fetched = [];
  const { deps, availableHealth } = makeDeps({
    batches: [
      batch({ id: 1, source: source('active'), draftSource: source('replacement'), draftSourceBaseRevision: 2 }),
      batch({ id: 2, enabled: false, source: source('disabled') }),
    ],
    authorityState: { active: 'none', pending: null },
    fetchSourceSnapshot: async ({ sourceExternalId }) => {
      fetched.push(sourceExternalId);
      return sourceSnapshot(source(sourceExternalId), { people: [], memberExternalIds: [] });
    },
  });

  await previewAuthoritySwitch({
    churchId: 'church-a', provider: 'elvanto', authorityPreviewId: 'replacement-preview',
  }, deps);

  assert.deepEqual(fetched, ['replacement']);
  assert.deepEqual(availableHealth, []);
});

test('invalid authority source sets fail before staging or fetching', async () => {
  const cases = [
    [batch({ source: null, draftSource: null })],
    [batch({ source: { kind: 'elvanto_group', externalId: '', name: 'Empty' } })],
    [batch({ source: { kind: 'planning_center_list', externalId: 'wrong-provider', name: 'Wrong' } })],
    [batch({ id: 1, source: source('duplicate') }), batch({ id: 2, source: source('duplicate') })],
  ];

  for (const batches of cases) {
    let begins = 0;
    let fetches = 0;
    const { deps, events } = makeDeps({
      batches,
      authorityState: { active: 'none', pending: null },
      fetchSourceSnapshot: async () => { fetches += 1; throw new Error('must not fetch'); },
      extra: {
        beginAuthoritySwitch: async () => { begins += 1; return { active: 'none', pending: 'elvanto' }; },
      },
    });

    await assert.rejects(previewAuthoritySwitch({
      churchId: 'church-a', provider: 'elvanto', authorityPreviewId: 'invalid-source-set',
    }, deps), { code: 'SYNC_SOURCE_INVALID' });
    assert.equal(begins, 0);
    assert.equal(fetches, 0);
    assert.equal(events.includes('startRun'), false);
  }
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

test('a cancelled source fetch cannot record available health or continue planning', async () => {
  const controller = new AbortController();
  let releaseFetch;
  let markFetchEntered;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  const fetchEntered = new Promise((resolve) => { markFetchEntered = resolve; });
  const cancellations = [];
  const { deps, availableHealth, failedHealth, plans } = makeDeps({
    authorityState: { active: 'none', pending: null },
    fetchSourceSnapshot: async ({ signal }) => {
      assert.equal(signal, controller.signal);
      markFetchEntered();
      await fetchGate;
      return sourceSnapshot(source('group-1', 'Members'));
    },
    extra: {
      cancelAuthoritySwitch: async (...args) => { cancellations.push(args); },
    },
  });

  const preview = previewAuthoritySwitch({
    churchId: 'church-a', provider: 'elvanto', authorityPreviewId: 'preview-cancelled-fetch',
    signal: controller.signal,
  }, deps);
  await fetchEntered;
  controller.abort();
  releaseFetch();

  await assert.rejects(preview, (error) => error.code === 'SYNC_ROUTE_TIMEOUT');
  assert.deepEqual(availableHealth, []);
  assert.deepEqual(failedHealth, []);
  assert.deepEqual(plans, []);
  assert.deepEqual(cancellations, [['church-a', 'elvanto', 'preview-cancelled-fetch']]);
});

test('a cancelled failing source fetch cannot record missing health', async () => {
  const controller = new AbortController();
  let rejectFetch;
  let markFetchEntered;
  const fetchEntered = new Promise((resolve) => { markFetchEntered = resolve; });
  const { deps, availableHealth, failedHealth } = makeDeps({
    authorityState: { active: 'none', pending: null },
    fetchSourceSnapshot: async () => {
      markFetchEntered();
      return new Promise((_resolve, reject) => { rejectFetch = reject; });
    },
  });

  const preview = previewAuthoritySwitch({
    churchId: 'church-a', provider: 'elvanto', authorityPreviewId: 'preview-cancelled-error',
    signal: controller.signal,
  }, deps);
  await fetchEntered;
  controller.abort();
  rejectFetch(new Error('provider failed after caller left'));

  await assert.rejects(preview, (error) => error.code === 'SYNC_ROUTE_TIMEOUT');
  assert.deepEqual(availableHealth, []);
  assert.deepEqual(failedHealth, []);
});

test('cancellation during an awaited available-health write prevents that health commit', async () => {
  const controller = new AbortController();
  let releaseHealth;
  let markHealthEntered;
  const healthGate = new Promise((resolve) => { releaseHealth = resolve; });
  const healthEntered = new Promise((resolve) => { markHealthEntered = resolve; });
  let committedHealth = 0;
  const { deps } = makeDeps({
    authorityState: { active: 'none', pending: null },
    extra: {
      recordActiveSourceAvailable: async (input) => {
        markHealthEntered();
        await healthGate;
        if (!input.signal?.aborted) committedHealth += 1;
      },
    },
  });

  const preview = previewAuthoritySwitch({
    churchId: 'church-a', provider: 'elvanto', authorityPreviewId: 'preview-cancelled-available-health',
    signal: controller.signal,
  }, deps);
  await healthEntered;
  controller.abort();
  releaseHealth();

  await assert.rejects(preview, (error) => error.code === 'SYNC_ROUTE_TIMEOUT');
  assert.equal(committedHealth, 0);
});

test('cancellation during an awaited missing-health write prevents health and notification commit', async () => {
  const controller = new AbortController();
  let releaseHealth;
  let markHealthEntered;
  const healthGate = new Promise((resolve) => { releaseHealth = resolve; });
  const healthEntered = new Promise((resolve) => { markHealthEntered = resolve; });
  let committedHealth = 0;
  let notifications = 0;
  const missing = Object.assign(new Error('source disappeared'), { code: 'SYNC_SOURCE_UNAVAILABLE' });
  const { deps } = makeDeps({
    authorityState: { active: 'none', pending: null },
    fetchSourceSnapshot: async () => { throw missing; },
    extra: {
      recordActiveSourceFailure: async (input) => {
        markHealthEntered();
        await healthGate;
        if (!input.signal?.aborted) {
          committedHealth += 1;
          notifications += 1;
        }
      },
    },
  });

  const preview = previewAuthoritySwitch({
    churchId: 'church-a', provider: 'elvanto', authorityPreviewId: 'preview-cancelled-missing-health',
    signal: controller.signal,
  }, deps);
  await healthEntered;
  controller.abort();
  releaseHealth();

  await assert.rejects(preview, (error) => error.code === 'SYNC_ROUTE_TIMEOUT');
  assert.equal(committedHealth, 0);
  assert.equal(notifications, 0);
});
