// Fully dependency-injected unit tests for the orchestrator (Task 15). No
// real database or network access — every collaborator is faked except
// matcher.js/plan.js's pure computation (used for real, to prove the
// composition is wired correctly) and digestPlan (a pure hash, no secret
// required). See orchestrator.dbintegration.test.js for real-DB coverage.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchPeople } = require('./matcher');
const { BUCKETS, computePeopleSyncPlan } = require('./plan');
const { digestPlan } = require('./planDigest');
const {
  buildReview, applyReviewed, runUnattended, previewAuthoritySwitch, OrchestratorError,
} = require('./orchestrator');

function record(calls, label, fn) {
  return (...args) => {
    calls.push(label);
    return fn(...args);
  };
}

function fakeBatch(overrides = {}) {
  return {
    id: 1, provider: 'elvanto', name: 'Members', enabled: true, filterSchemaVersion: 1, filterConfig: {},
    defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
    scheduleEnabled: true, scheduleFrequency: 'weekly', scheduleDay: 1, legacyProviderBatchId: null,
    lastExternalWatermark: null, lastSyncAt: null, lastSyncResult: null,
    ...overrides,
  };
}

function fakeExternalPerson(overrides = {}) {
  return { id: 'ext-1', firstName: 'Ada', lastName: 'Lovelace', state: 'active', child: false, familyId: null, ...overrides };
}

function emptyApplyResult(overrides = {}) {
  const result = {};
  for (const bucket of BUCKETS) result[bucket] = 0;
  result.familyNamesUpdated = 0;
  result.gatheringAssigned = 0;
  result.gatheringRemoved = 0;
  return { ...result, ...overrides };
}

function fakeAdapter(overrides = {}) {
  return {
    provider: 'elvanto',
    validateFilter: () => ({ ok: true, value: {}, errors: [] }),
    isEligible: () => true,
    fetchSnapshot: async () => ({
      provider: 'elvanto', mode: 'full', complete: true, fetchedAt: '2026-01-01T00:00:00.000Z', watermark: null,
      people: [fakeExternalPerson()], families: [],
    }),
    fetchMetadata: async () => ({}),
    validateConnection: async () => ({ ok: true }),
    ...overrides,
  };
}

// Builds a full dependency-injection bag. Every function that corresponds
// to one of the 10 canonical pipeline steps pushes its own label into the
// shared `calls` array, so tests can assert exact call order by comparing
// against `calls`.
function makeDeps({
  batches = [fakeBatch()],
  authorityState = { active: 'elvanto', pending: null },
  adapter = fakeAdapter(),
  localIndividuals = [],
  personLinks = [],
  applyResult = emptyApplyResult(),
  verifyResult = { ok: true },
  extra = {},
} = {}) {
  const calls = [];
  let nextRunId = 1;
  const wrappedAdapter = { ...adapter, fetchSnapshot: record(calls, 'fetchSnapshot', adapter.fetchSnapshot) };
  const deps = {
    getConnection: record(calls, 'getConnection', async () => ({ connectionStatus: 'connected' })),
    getCredentials: async () => ({ apiKey: 'test-key' }),
    getProvider: () => wrappedAdapter,
    listBatches: record(calls, 'listBatches', async () => batches),
    getSyncSettings: async () => ({ includeContacts: true, alignPeopleType: true }),
    getAuthority: async () => authorityState,
    beginAuthoritySwitch: record(calls, 'beginAuthoritySwitch', async () => ({ active: authorityState.active, pending: 'elvanto' })),
    startRun: record(calls, 'startRun', async () => ({ id: nextRunId++ })),
    finishRun: record(calls, 'finishRun', async (input) => input),
    failRun: record(calls, 'failRun', async (input) => input),
    listPersonLinks: async () => personLinks,
    listFamilyLinks: async () => [],
    recordFullFetchPresence: record(calls, 'recordFullFetchPresence', async () => ({ missingCandidates: [] })),
    listLocalIndividuals: record(calls, 'listLocalIndividuals', async () => localIndividuals),
    listLocalFamilies: async () => [],
    listGatheringMemberships: async () => [],
    matchPeople: record(calls, 'matchPeople', matchPeople),
    computePeopleSyncPlan: record(calls, 'computePeopleSyncPlan', computePeopleSyncPlan),
    applyPeopleSyncPlan: record(calls, 'applyPeopleSyncPlan', async () => applyResult),
    validateSelections: () => ({ acceptedLinks: [], skipExternalPersonIds: new Set(), acceptedArchiveIndividualIds: new Set(), acceptedFamilyRenameIds: new Set() }),
    digestPlan,
    createReviewToken: record(calls, 'createReviewToken', (ctx) => `fake-token:${ctx.planDigest.slice(0, 8)}`),
    verifyReviewToken: () => verifyResult,
    notifyReviewRequired: record(calls, 'notifyReviewRequired', async () => ({ notified: true })),
    ...extra,
  };
  return { deps, calls };
}

// ─── buildReview ─────────────────────────────────────────────────────────────

test('buildReview follows the exact 10-step order (minus apply/presence, which it never reaches)', async () => {
  const { deps, calls } = makeDeps();
  const review = await buildReview({ churchId: 'church-a', provider: 'elvanto', batchId: 1, trigger: 'manual' }, deps);

  assert.deepEqual(calls, [
    'getConnection', 'listBatches', 'startRun', 'fetchSnapshot', 'listLocalIndividuals',
    'matchPeople', 'computePeopleSyncPlan', 'createReviewToken', 'finishRun',
  ]);
  assert.equal(review.runId, 1);
  assert.equal(review.reviewToken.startsWith('fake-token:'), true);
  assert.equal(review.snapshot.mode, 'full');
  assert.equal(review.summary.addPeople, 1, 'the one unmatched, eligible external person should be proposed as an addition');
  assert.equal(Array.isArray(review.plan.addPeople), true);
});

test('buildReview never applies anything and never increments missing counters, however many times it runs', async () => {
  const { deps, calls } = makeDeps();
  await buildReview({ churchId: 'church-a', provider: 'elvanto', batchId: 1, trigger: 'manual' }, deps);
  await buildReview({ churchId: 'church-a', provider: 'elvanto', batchId: 1, trigger: 'manual' }, deps);
  assert.equal(calls.filter((c) => c === 'applyPeopleSyncPlan').length, 0);
  assert.equal(calls.filter((c) => c === 'recordFullFetchPresence').length, 0);
});

test('buildReview evaluates a schema-2 draft only for the requested batch and gates the population first', async () => {
  const draft = { branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['active'] }] }], exclusions: [] };
  const active = { branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['member'] }] }], exclusions: [] };
  const other = { branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['other'] }] }], exclusions: [] };
  const seen = [];
  const adapter = fakeAdapter({
    isInFilterPopulation: (person) => person.id !== 'excluded',
    isEligible: (person, config, schemaVersion) => {
      seen.push([person.id, config, schemaVersion]);
      return true;
    },
    fetchSnapshot: async () => ({
      provider: 'elvanto', mode: 'full', complete: true, fetchedAt: '2026-01-01T00:00:00.000Z', watermark: null,
      people: [fakeExternalPerson({ id: 'included' }), fakeExternalPerson({ id: 'excluded' })], families: [],
    }),
  });
  const batches = [
    fakeBatch({ id: 1, filterSchemaVersion: 2, filterConfig: active, draftFilterSchemaVersion: 2, draftFilterConfig: draft }),
    fakeBatch({ id: 2, filterSchemaVersion: 2, filterConfig: other }),
  ];
  const { deps } = makeDeps({ batches, adapter });
  await buildReview({ churchId: 'church-a', provider: 'elvanto', batchId: 1, trigger: 'manual' }, deps);

  assert.deepEqual(seen, [
    ['included', draft, 2],
    ['included', other, 2],
  ]);
});

test('a full review captures filter facts and binds the review digest to its filter context', async () => {
  const draft = { branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['active'] }] }], exclusions: [] };
  const captured = [];
  let digestedPlan;
  const adapter = fakeAdapter({
    isInFilterPopulation: () => true,
    toFilterFacts: (person) => ({ externalPersonId: person.id, dimensions: { status: [person.state] } }),
    buildFilterDimensions: () => [{ id: 'status', cardinality: 'single', values: [{ id: 'active' }] }],
    fetchMetadata: async ({ snapshot }) => ({ snapshot }),
  });
  const { deps } = makeDeps({
    batches: [fakeBatch({ filterSchemaVersion: 2, filterRevision: 7, draftFilterSchemaVersion: 2, draftFilterConfig: draft })],
    adapter,
  });
  deps.captureFilterSnapshotInput = (input) => {
    captured.push(input);
    return { facts: [{ externalPersonId: 'ext-1', dimensions: { status: ['active'] } }], dimensions: [], coverage: ['status'], populationGateDigest: 'gate' };
  };
  deps.filterFactsCache = { putComplete: (entry) => ({ ...entry, snapshotId: 'snapshot-1' }) };
  deps.digestPlan = (plan) => {
    digestedPlan = structuredClone(plan);
    return 'a'.repeat(64);
  };

  await buildReview({ churchId: 'church-a', provider: 'elvanto', batchId: 1, trigger: 'manual' }, deps);

  assert.equal(captured.length, 1);
  assert.equal(captured[0].snapshot.people[0].id, 'ext-1');
  assert.deepEqual(digestedPlan.filterContext, {
    activeRevision: 7,
    draftDigest: require('./planDigest').digestFilterConfig(draft),
    snapshotId: 'snapshot-1',
  });
});

test('buildReview rejects an unsupported trigger before touching any collaborator', async () => {
  const { deps, calls } = makeDeps();
  await assert.rejects(
    buildReview({ churchId: 'church-a', provider: 'elvanto', batchId: 1, trigger: 'scheduled' }, deps),
    (err) => err instanceof OrchestratorError && err.code === 'SYNC_TRIGGER_INVALID'
  );
  assert.deepEqual(calls, []);
});

test('a fetch error calls failRun and never reaches apply/token creation', async () => {
  const failingAdapter = fakeAdapter({ fetchSnapshot: async () => { throw new Error('upstream exploded'); } });
  const { deps, calls } = makeDeps({ adapter: failingAdapter });

  await assert.rejects(
    buildReview({ churchId: 'church-a', provider: 'elvanto', batchId: 1, trigger: 'manual' }, deps),
    /upstream exploded/
  );
  assert.deepEqual(calls, ['getConnection', 'listBatches', 'startRun', 'fetchSnapshot', 'failRun']);
});

test('a plan-computation (validation) error calls failRun and never reaches apply/token creation', async () => {
  const { deps, calls } = makeDeps();
  deps.computePeopleSyncPlan = record(calls, 'computePeopleSyncPlan', () => { throw new Error('bad plan input'); });

  await assert.rejects(
    buildReview({ churchId: 'church-a', provider: 'elvanto', batchId: 1, trigger: 'manual' }, deps),
    /bad plan input/
  );
  assert.deepEqual(calls, ['getConnection', 'listBatches', 'startRun', 'fetchSnapshot', 'listLocalIndividuals', 'matchPeople', 'computePeopleSyncPlan', 'failRun']);
});

test('a missing connection throws before any run is started (nothing to failRun)', async () => {
  const { deps, calls } = makeDeps();
  deps.getConnection = record(calls, 'getConnection', async () => null);

  await assert.rejects(
    buildReview({ churchId: 'church-a', provider: 'elvanto', batchId: 1, trigger: 'manual' }, deps),
    (err) => err instanceof OrchestratorError && err.code === 'SYNC_NOT_CONNECTED'
  );
  assert.deepEqual(calls, ['getConnection']);
});

// ─── previewAuthoritySwitch ──────────────────────────────────────────────────

test('previewAuthoritySwitch validates preconditions BEFORE staging the switch, then reviews as-if authoritative, and never applies', async () => {
  const { deps, calls } = makeDeps({ authorityState: { active: 'none', pending: null } });
  const review = await previewAuthoritySwitch({ churchId: 'church-a', provider: 'elvanto' }, deps);

  assert.deepEqual(calls, [
    'getConnection', 'listBatches', 'beginAuthoritySwitch', 'startRun', 'fetchSnapshot',
    'listLocalIndividuals', 'matchPeople', 'computePeopleSyncPlan', 'createReviewToken', 'finishRun',
  ]);
  assert.equal(review.authority.pending, 'elvanto');
  assert.equal(review.summary.addPeople, 1, 'plan must be computed AS IF elvanto were already authoritative');
});

test('previewAuthoritySwitch returns whatever beginAuthoritySwitch actually persisted, never an assumed pending value', async () => {
  // authority.js's beginAuthoritySwitch clears pending back to null when
  // the target provider is already the active authority (re-previewing
  // your own current source of truth) — the response here must reflect
  // that real DB state, not blindly echo `provider`.
  const { deps } = makeDeps({ authorityState: { active: 'elvanto', pending: null } });
  deps.beginAuthoritySwitch = async () => ({ active: 'elvanto', pending: null });

  const review = await previewAuthoritySwitch({ churchId: 'church-a', provider: 'elvanto' }, deps);
  assert.deepEqual(review.authority, { active: 'elvanto', pending: null });
});

test('previewAuthoritySwitch never stages a switch when preconditions fail (no lingering pending state)', async () => {
  const { deps, calls } = makeDeps();
  deps.getConnection = record(calls, 'getConnection', async () => null);

  await assert.rejects(
    previewAuthoritySwitch({ churchId: 'church-a', provider: 'elvanto' }, deps),
    (err) => err instanceof OrchestratorError && err.code === 'SYNC_NOT_CONNECTED'
  );
  assert.equal(calls.includes('beginAuthoritySwitch'), false);
});

// ─── runUnattended ───────────────────────────────────────────────────────────

test('runUnattended rejects interactive run_now before any collaborator can mutate data', async () => {
  const { deps, calls } = makeDeps();
  await assert.rejects(
    runUnattended({ churchId: 'church-a', provider: 'elvanto', batchId: 1, trigger: 'run_now' }, deps),
    (err) => err instanceof OrchestratorError && err.code === 'SYNC_TRIGGER_INVALID'
  );
  assert.deepEqual(calls, []);
});

test('runUnattended blocks an authoritative schema-2 draft before starting a run or fetching', async () => {
  const { deps, calls } = makeDeps({
    batches: [fakeBatch({
      filterSchemaVersion: 2,
      draftFilterSchemaVersion: 2,
      draftFilterConfig: { branches: [], exclusions: [] },
    })],
  });
  await assert.rejects(
    runUnattended({ churchId: 'church-a', provider: 'elvanto', batchId: 1 }, deps),
    (err) => err instanceof OrchestratorError && err.code === 'SYNC_FILTER_REVIEW_REQUIRED'
  );
  assert.equal(calls.includes('startRun'), false);
  assert.equal(calls.includes('fetchSnapshot'), false);
});

test('runUnattended (clean, no held items) follows the full 10-step order and classifies applied', async () => {
  const { deps, calls } = makeDeps();
  const result = await runUnattended({ churchId: 'church-a', provider: 'elvanto', batchId: 1, forceFull: true }, deps);

  assert.deepEqual(calls, [
    'getConnection', 'listBatches', 'startRun', 'fetchSnapshot', 'listLocalIndividuals',
    'matchPeople', 'computePeopleSyncPlan', 'applyPeopleSyncPlan', 'recordFullFetchPresence', 'finishRun',
  ]);
  assert.equal(result.status, 'applied');
  assert.equal(result.fetchMode, 'full');
  assert.equal(calls.includes('notifyReviewRequired'), false, 'a clean applied run must not notify');
});

test('runUnattended holds ambiguous/conflict/rename/unmatched-local items for review and notifies', async () => {
  const localIndividuals = [
    { id: 10, firstName: 'Ada', lastName: 'Lovelace', peopleType: 'regular', isActive: true, isChild: false, familyId: null },
    { id: 11, firstName: 'Ada', lastName: 'Lovelace', peopleType: 'regular', isActive: true, isChild: false, familyId: null },
  ];
  const { deps, calls } = makeDeps({ localIndividuals });
  const result = await runUnattended({ churchId: 'church-a', provider: 'elvanto', batchId: 1, forceFull: true }, deps);

  assert.equal(result.status, 'review_required');
  assert.ok(result.counts.ambiguousPeople >= 1);
  assert.equal(calls.includes('notifyReviewRequired'), true);
  assert.equal(calls.includes('applyPeopleSyncPlan'), true, 'safe portions still apply even when some items are held');
});

test('runUnattended never reads or writes disappearance counters on an incremental snapshot', async () => {
  const incrementalAdapter = fakeAdapter({
    fetchSnapshot: async () => ({
      provider: 'elvanto', mode: 'incremental', complete: true, fetchedAt: '2026-01-02T00:00:00.000Z',
      watermark: 'wm-2', people: [fakeExternalPerson()], families: [],
    }),
  });
  const batch = fakeBatch({ lastExternalWatermark: 'wm-1' });
  const { deps, calls } = makeDeps({ batches: [batch], adapter: incrementalAdapter });

  const result = await runUnattended({ churchId: 'church-a', provider: 'elvanto', batchId: 1, forceFull: false }, deps);
  assert.equal(result.fetchMode, 'incremental');
  assert.equal(calls.includes('recordFullFetchPresence'), false);
});

test('runUnattended protects the union of every enabled batch when one scheduled batch triggers reconciliation', async () => {
  const batches = [
    fakeBatch({ id: 1, filterConfig: { externalIds: ['ext-1'] } }),
    fakeBatch({ id: 2, name: 'Youth', filterConfig: { externalIds: ['ext-2'] } }),
  ];
  const adapter = fakeAdapter({
    isEligible: (person, filterConfig) => filterConfig.externalIds.includes(person.id),
    fetchSnapshot: async () => ({
      provider: 'elvanto', mode: 'full', complete: true, fetchedAt: '2026-01-02T00:00:00.000Z', watermark: null,
      people: [fakeExternalPerson(), fakeExternalPerson({ id: 'ext-2', firstName: 'Grace', lastName: 'Hopper' })], families: [],
    }),
  });
  const localIndividuals = [
    { id: 2, firstName: 'Grace', lastName: 'Hopper', peopleType: 'regular', isActive: true, isChild: false, familyId: null },
  ];
  const personLinks = [{ externalPersonId: 'ext-2', individualId: 2, missingFullSyncCount: 0 }];
  let appliedPlan;
  const { deps } = makeDeps({
    batches, adapter, localIndividuals, personLinks,
    extra: {
      applyPeopleSyncPlan: async ({ plan }) => {
        appliedPlan = plan;
        return emptyApplyResult();
      },
    },
  });

  await runUnattended({ churchId: 'church-a', provider: 'elvanto', batchId: 1, forceFull: true }, deps);

  assert.deepEqual(appliedPlan.archive, [], 'a person qualifying for another enabled batch must stay active');
});

test('runUnattended does not infer local absence or gathering removal from an incremental snapshot', async () => {
  const batch = fakeBatch({ lastExternalWatermark: 'wm-1', gatheringTypeId: 5, gatheringAutoRemoveEnabled: true });
  const adapter = fakeAdapter({
    fetchSnapshot: async () => ({
      provider: 'elvanto', mode: 'incremental', complete: true, fetchedAt: '2026-01-02T00:00:00.000Z',
      watermark: 'wm-2', people: [fakeExternalPerson()], families: [],
    }),
  });
  const localIndividuals = [
    { id: 1, firstName: 'Ada', lastName: 'Lovelace', peopleType: 'regular', isActive: true, isChild: false, familyId: null },
    { id: 2, firstName: 'Grace', lastName: 'Hopper', peopleType: 'regular', isActive: true, isChild: false, familyId: null },
  ];
  const personLinks = [
    { externalPersonId: 'ext-1', individualId: 1, missingFullSyncCount: 0 },
    { externalPersonId: 'ext-2', individualId: 2, missingFullSyncCount: 0 },
  ];
  let appliedPlan;
  const { deps } = makeDeps({
    batches: [batch], adapter, localIndividuals, personLinks,
    extra: {
      listGatheringMemberships: async () => [{ gatheringTypeId: 5, individualId: 2, addedBySyncBatchId: 1 }],
      applyPeopleSyncPlan: async ({ plan }) => {
        appliedPlan = plan;
        return emptyApplyResult();
      },
    },
  });

  const result = await runUnattended({ churchId: 'church-a', provider: 'elvanto', batchId: 1, forceFull: false }, deps);

  assert.equal(result.status, 'applied');
  assert.deepEqual(appliedPlan.unmatchedLocalRegulars, []);
  assert.deepEqual(appliedPlan.removeFromGathering, []);
});

test('runUnattended is permitted only when provider is the active authority, and rejects before starting a run', async () => {
  const { deps, calls } = makeDeps({ authorityState: { active: 'planning_center', pending: null } });
  await assert.rejects(
    runUnattended({ churchId: 'church-a', provider: 'elvanto', batchId: 1 }, deps),
    (err) => err instanceof OrchestratorError && err.code === 'SYNC_AUTHORITY_MISMATCH'
  );
  assert.equal(calls.includes('startRun'), false);
  assert.equal(calls.includes('failRun'), false);
});

test('a presence-accounting failure in runUnattended is swallowed: the run still finishes successfully', async () => {
  const { deps, calls } = makeDeps({
    extra: { recordFullFetchPresence: async () => { throw new Error('disk full'); } },
  });
  const result = await runUnattended({ churchId: 'church-a', provider: 'elvanto', batchId: 1, forceFull: true }, deps);
  assert.equal(result.status, 'applied');
  assert.equal(calls.includes('finishRun'), true);
  assert.equal(calls.includes('failRun'), false, 'a presence hiccup must never fail the whole run');
});

test('a finishRun failure in runUnattended after a successful apply is logged, not treated as a run failure', async () => {
  const { deps, calls } = makeDeps({
    extra: { finishRun: async () => { throw new Error('db locked'); } },
  });
  const result = await runUnattended({ churchId: 'church-a', provider: 'elvanto', batchId: 1, forceFull: true }, deps);
  assert.equal(result.status, 'applied', 'the function must still report the apply succeeded');
  assert.equal(calls.includes('applyPeopleSyncPlan'), true);
  assert.equal(calls.includes('failRun'), false, 'a run that already applied real mutations must never be recorded failed');
});

test('runUnattended requires a batchId', async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    runUnattended({ churchId: 'church-a', provider: 'elvanto' }, deps),
    (err) => err instanceof OrchestratorError && err.code === 'SYNC_BATCH_REQUIRED'
  );
});

// ─── applyReviewed ───────────────────────────────────────────────────────────

test('applyReviewed follows the full 10-step order and persists presence exactly once after a successful apply', async () => {
  const { deps, calls } = makeDeps();
  const result = await applyReviewed({
    churchId: 'church-a', provider: 'elvanto', batchId: 1, reviewToken: 'irrelevant-for-fake-verify', userId: 7,
  }, deps);

  assert.deepEqual(calls, [
    'getConnection', 'listBatches', 'startRun', 'fetchSnapshot', 'listLocalIndividuals',
    'matchPeople', 'computePeopleSyncPlan', 'applyPeopleSyncPlan', 'recordFullFetchPresence', 'finishRun',
  ]);
  assert.equal(result.status, 'applied');
  assert.equal(calls.filter((c) => c === 'recordFullFetchPresence').length, 1);
});

test('applyReviewed returns a typed 409 SYNC_PLAN_STALE error and calls failRun without ever applying', async () => {
  const { deps, calls } = makeDeps({ verifyResult: { ok: false, code: 'SYNC_PLAN_STALE' } });
  await assert.rejects(
    applyReviewed({ churchId: 'church-a', provider: 'elvanto', batchId: 1, reviewToken: 'stale-token' }, deps),
    (err) => err instanceof OrchestratorError && err.code === 'SYNC_PLAN_STALE' && err.status === 409
  );
  assert.equal(calls.includes('applyPeopleSyncPlan'), false);
  assert.equal(calls.includes('recordFullFetchPresence'), false);
  assert.equal(calls.includes('failRun'), true);
});

test('applyReviewed requires a review token', async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    applyReviewed({ churchId: 'church-a', provider: 'elvanto', batchId: 1, reviewToken: '' }, deps),
    (err) => err instanceof OrchestratorError && err.code === 'SYNC_REVIEW_INVALID'
  );
});

test('applyReviewed delegates a pending authority switch to the same transaction as plan application', async () => {
  const { deps, calls } = makeDeps({ authorityState: { active: 'none', pending: 'elvanto' } });
  const apply = deps.applyPeopleSyncPlan;
  let applyInput;
  deps.applyPeopleSyncPlan = async (input) => {
    applyInput = input;
    return apply(input);
  };
  const result = await applyReviewed({ churchId: 'church-a', provider: 'elvanto', batchId: null, reviewToken: 'tok' }, deps);

  assert.equal(result.status, 'applied');
  assert.equal(applyInput.activateAuthority, true);
  assert.equal(calls.includes('commitAuthoritySwitch'), false, 'authority activation must not be a second transaction');
});

test('an atomic authority-apply failure fails the run before presence accounting', async () => {
  const { deps, calls } = makeDeps({
    authorityState: { active: 'none', pending: 'elvanto' },
    extra: { applyPeopleSyncPlan: async () => { throw new Error('pending authority switch changed before commit'); } },
  });
  await assert.rejects(
    applyReviewed({ churchId: 'church-a', provider: 'elvanto', batchId: null, reviewToken: 'tok' }, deps),
    /pending authority switch changed/i
  );

  assert.equal(calls.includes('failRun'), true);
  assert.equal(calls.includes('recordFullFetchPresence'), false);
  assert.equal(calls.includes('finishRun'), false);
});

test('a finishRun failure in applyReviewed after a successful apply is logged, not treated as a run failure', async () => {
  const { deps, calls } = makeDeps({
    extra: { finishRun: async () => { throw new Error('db locked'); } },
  });
  const result = await applyReviewed({ churchId: 'church-a', provider: 'elvanto', batchId: 1, reviewToken: 'tok' }, deps);
  assert.equal(result.status, 'applied');
  assert.equal(calls.includes('applyPeopleSyncPlan'), true);
  assert.equal(calls.includes('failRun'), false);
});

test('applyReviewed does not commit an authority switch when nothing is pending for this provider', async () => {
  const { deps, calls } = makeDeps({ authorityState: { active: 'elvanto', pending: null } });
  const apply = deps.applyPeopleSyncPlan;
  let applyInput;
  deps.applyPeopleSyncPlan = async (input) => {
    applyInput = input;
    return apply(input);
  };
  await applyReviewed({ churchId: 'church-a', provider: 'elvanto', batchId: 1, reviewToken: 'tok' }, deps);
  assert.equal(applyInput.activateAuthority, false);
  assert.equal(calls.includes('commitAuthoritySwitch'), false);
});

test('invalid selections are reported through failRun as SYNC_SELECTIONS_INVALID and never reach apply', async () => {
  const { deps, calls } = makeDeps({
    extra: { validateSelections: () => { throw new Error('bogus selection'); } },
  });
  await assert.rejects(
    applyReviewed({ churchId: 'church-a', provider: 'elvanto', batchId: 1, reviewToken: 'tok' }, deps),
    (err) => err instanceof OrchestratorError && err.code === 'SYNC_SELECTIONS_INVALID'
  );
  assert.equal(calls.includes('applyPeopleSyncPlan'), false);
  assert.equal(calls.includes('failRun'), true);
});
