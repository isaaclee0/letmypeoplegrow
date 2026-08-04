'use strict';

const logger = require('../../config/logger');
const connectionStore = require('../peopleSync/connectionStore');
const runRepository = require('../peopleSync/runRepository');
const authority = require('../peopleSync/authority');
const providerRegistry = require('../peopleSync/providerRegistry');
const { loadLocalProjectionState } = require('../peopleSync/localProjectionState');
const { matchPeople } = require('../peopleSync/matcher');
const { BUCKETS, summarizePlan } = require('../peopleSync/plan');
const {
  DECISION_CONTRACT_VERSION, buildReviewContext,
} = require('../peopleSync/reviewContext');
const { applyPeopleSyncPlan } = require('../peopleSync/apply');
const {
  digestPlan, createReviewToken, verifyReviewToken,
} = require('../peopleSync/planDigest');
const { SOURCE_KINDS_BY_PROVIDER, digestSourceSnapshot } = require('../peopleSync/sourceModel');
const {
  OrchestratorError, sanitizePlanForReview, reviewCoverage,
  isCompleteSourceSnapshot, sameSourceIdentity, snapshotDigestInput,
} = require('../peopleSync/orchestrator');
const { computePeopleImportPlan, assertAdditiveImportPlan } = require('./plan');

const PROVIDERS = new Set(['planning_center', 'elvanto']);
const REVIEW_TOKEN_TTL_SECONDS = 30 * 60;
const ALLOWED_IMPORT_MUTATION_BUCKETS = new Set([
  'linkPeople', 'linkFamilies', 'addPeople', 'addFamilies',
  'ambiguousPeople', 'familyConflicts', 'skipped',
]);

const defaultDeps = {
  getConnection: connectionStore.getConnection,
  getConnectionGeneration: connectionStore.getConnectionGeneration,
  getCredentials: connectionStore.getCredentials,
  getAuthority: authority.getAuthority,
  getProvider: providerRegistry.getProvider,
  startRun: runRepository.startRun,
  finishRun: runRepository.finishRun,
  failRun: runRepository.failRun,
  loadLocalProjectionState,
  matchPeople,
  computePeopleImportPlan,
  assertAdditiveImportPlan,
  buildReviewContext,
  digestPlan,
  createReviewToken,
  verifyReviewToken,
  applyPeopleSyncPlan,
};

function mergeDeps(overrides) {
  return { ...defaultDeps, ...overrides };
}

function assertChurchId(churchId) {
  if (!churchId || typeof churchId !== 'string') {
    throw new OrchestratorError('SYNC_CHURCH_REQUIRED', 'A churchId is required', 400);
  }
}

function assertProvider(provider) {
  if (!PROVIDERS.has(provider)) {
    throw new OrchestratorError('SYNC_PROVIDER_INVALID', `Unsupported people-sync provider: ${provider}`, 400);
  }
}

function normalizeSelection(provider, selection) {
  if (selection?.kind === 'all' && Object.keys(selection).length === 1) return { kind: 'all' };
  const allowedKinds = SOURCE_KINDS_BY_PROVIDER[provider];
  if (!selection || typeof selection !== 'object' || Array.isArray(selection) ||
      Object.keys(selection).sort().join(',') !== 'externalId,kind' ||
      !allowedKinds?.has(selection.kind) || typeof selection.externalId !== 'string' ||
      !selection.externalId.trim()) {
    throw new OrchestratorError('SYNC_SOURCE_INVALID', 'Invalid provider people import selection', 400);
  }
  return { kind: selection.kind, externalId: selection.externalId.trim() };
}

function expectedSourceFor(selection) {
  return selection.kind === 'all'
    ? { kind: 'all', externalId: 'all' }
    : { kind: selection.kind, externalId: selection.externalId };
}

function groupMembersByFamily(people) {
  const members = new Map();
  for (const person of people || []) {
    if (person?.familyId === null || person?.familyId === undefined) continue;
    const familyId = String(person.familyId);
    if (!members.has(familyId)) members.set(familyId, []);
    members.get(familyId).push({ id: person.id });
  }
  return members;
}

function memberOnlyMatcherResult(result, memberExternalIds) {
  const isMember = (value) => memberExternalIds.has(String(value?.externalPersonId));
  return {
    ...result,
    linked: (result.linked || []).filter(isMember),
    matches: (result.matches || []).filter(isMember),
    ambiguous: (result.ambiguous || []).filter(isMember),
    visitorMatches: (result.visitorMatches || []).filter(isMember),
    archivedMatches: (result.archivedMatches || []).filter(isMember),
    unmatchedExternalIds: (result.unmatchedExternalIds || [])
      .filter((externalPersonId) => memberExternalIds.has(String(externalPersonId))),
  };
}

function countsFromPlan(plan) {
  const counts = Object.fromEntries(BUCKETS.map((bucket) => [bucket, (plan[bucket] || []).length]));
  counts.familyNamesUpdated = 0;
  counts.gatheringAssigned = 0;
  counts.gatheringRemoved = 0;
  return counts;
}

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code
    : 'SYNC_RUN_FAILED';
}

function safeErrorMessage(error) {
  const message = typeof error?.message === 'string' ? error.message : 'Unknown error';
  return message.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 500) || 'Unknown error';
}

async function safeFailRun(deps, { churchId, provider, runId, error }) {
  const input = {
    churchId, provider, runId,
    errorCode: safeErrorCode(error),
    errorMessage: safeErrorMessage(error),
  };
  try {
    await deps.failRun(input);
  } catch (failError) {
    try {
      await deps.failRun({
        ...input,
        errorMessage: 'People import failed; see server logs for details.',
      });
    } catch (fallbackError) {
      logger.error(
        `peopleImport orchestrator: failed to record run failure for church ${churchId} run ${runId}: ${fallbackError.message}`
      );
    }
  }
}

function sourceIncomplete(provider) {
  return new OrchestratorError(
    'SYNC_SOURCE_INCOMPLETE', `${provider} source did not return a complete snapshot`, 502
  );
}

function sourceUnavailable(provider) {
  return new OrchestratorError('SYNC_SOURCE_UNAVAILABLE', `${provider} source is unavailable`, 502);
}

function reviewError(code) {
  const normalizedCode = code || 'SYNC_REVIEW_INVALID';
  const message = normalizedCode === 'SYNC_PLAN_STALE'
    ? 'The reviewed plan is out of date; fetch a fresh review before applying.'
    : normalizedCode === 'SYNC_REVIEW_EXPIRED'
      ? 'This review has expired; fetch a fresh review before applying.'
      : normalizedCode === 'SYNC_REVIEW_ALREADY_APPLIED'
        ? 'This review has already been applied. Refresh before applying another import.'
        : 'This review token is invalid.';
  return new OrchestratorError(
    normalizedCode, message, normalizedCode === 'SYNC_REVIEW_INVALID' ? 400 : 409
  );
}

function assertNotAborted(signal) {
  if (signal?.aborted) {
    throw new OrchestratorError(
      'SYNC_ROUTE_TIMEOUT', 'The people import request was cancelled before it could be applied.', 503
    );
  }
}

async function loadPreconditions({ churchId, provider, deps }) {
  const connection = await deps.getConnection(churchId, provider);
  if (!connection) {
    throw new OrchestratorError('SYNC_NOT_CONNECTED', `No ${provider} connection for this church`, 400);
  }
  if (connection.connectionStatus === 'invalid') {
    throw new OrchestratorError('SYNC_CONNECTION_INVALID', `The ${provider} connection is marked invalid`, 400);
  }
  // Read the durable generation before credentials so a reconnect between
  // those reads is rejected by the apply-time transactional CAS.
  const connectionGeneration = await deps.getConnectionGeneration(churchId, provider);
  const credentials = await deps.getCredentials(churchId, provider);
  if (!credentials) {
    throw new OrchestratorError('SYNC_NOT_CONNECTED', `No ${provider} credentials for this church`, 400);
  }
  const authorityState = await deps.getAuthority(churchId);
  const adapter = deps.getProvider(provider);
  return { connectionGeneration, credentials, authorityState, adapter };
}

function importSourceProvenance({ snapshot, snapshotDigest }) {
  return [{
    batchId: null,
    sourceKind: snapshot.source.kind,
    sourceExternalId: snapshot.source.externalId,
    sourceName: snapshot.source.name,
    memberCount: new Set(snapshot.memberExternalIds.map(String)).size,
    providerRefreshedAt: snapshot.providerRefreshedAt ?? snapshot.source.providerRefreshedAt ?? null,
    fetchedAt: snapshot.fetchedAt,
    snapshotDigest,
  }];
}

async function buildFreshPlan({
  churchId, provider, selection, signal, preconditions, deps,
}) {
  assertNotAborted(signal);
  const snapshot = await preconditions.adapter.fetchImportSnapshot({
    churchId,
    credentials: preconditions.credentials,
    selection,
    signal,
  });
  assertNotAborted(signal);
  if (!snapshot || snapshot.provider !== provider || !snapshot.source ||
      typeof snapshot.source !== 'object' || Array.isArray(snapshot.source)) {
    throw sourceIncomplete(provider);
  }
  if (!sameSourceIdentity(snapshot.source, expectedSourceFor(selection))) {
    throw sourceUnavailable(provider);
  }
  if (!isCompleteSourceSnapshot(snapshot, provider)) throw sourceIncomplete(provider);

  const snapshotDigest = digestSourceSnapshot(snapshotDigestInput(snapshot));
  const local = await deps.loadLocalProjectionState(churchId, provider);
  assertNotAborted(signal);
  const externalPeople = [...snapshot.people, ...snapshot.contextPeople];
  const sourceExternalIds = new Set(snapshot.memberExternalIds.map(String));
  const matched = deps.matchPeople({
    externalPeople,
    localPeople: local.individuals,
    existingLinks: local.personLinks,
    excludedPairs: new Set((local.matchReviewState.exclusions || []).map((entry) =>
      `${String(entry.externalPersonId)}\u0000${Number(entry.individualId)}`)),
    heldExternalIds: new Set((local.matchReviewState.holds || []).map((entry) =>
      String(entry.externalPersonId))),
    externalFamilyMembers: groupMembersByFamily(externalPeople),
    localFamilyMembers: groupMembersByFamily(local.individuals),
  });
  const matcher = memberOnlyMatcherResult(matched, sourceExternalIds);
  const plan = deps.computePeopleImportPlan({
    provider,
    authorityProvider: preconditions.authorityState.active,
    externalPeople: snapshot.people,
    externalFamilies: snapshot.families,
    householdPeople: externalPeople,
    memberExternalIds: snapshot.memberExternalIds,
    localPeople: local.individuals,
    localFamilies: local.families,
    matcher,
    personLinks: local.personLinks,
    familyLinks: local.familyLinks,
    snapshot: { fetchedAt: snapshot.fetchedAt, mode: 'full', complete: true },
  });
  deps.assertAdditiveImportPlan(plan);
  plan.reviewContext = deps.buildReviewContext({
    plan,
    externalPeople,
    localPeople: local.individuals,
    localFamilies: local.families,
    basePersonLinks: local.personLinks,
    projectedPersonLinks: local.personLinks,
    baseExclusions: local.matchReviewState.exclusions || [],
    projectedExclusions: local.matchReviewState.exclusions || [],
    baseHolds: local.matchReviewState.holds || [],
    projectedHolds: local.matchReviewState.holds || [],
    sourceExternalIds,
    linkCorrections: [],
    batches: [],
    eligibleByBatch: new Map(),
    createPeopleType: preconditions.authorityState.active === 'none' ? undefined : 'local_visitor',
  });
  plan.sourceContext = {
    operationKind: 'people_import',
    selection,
    connectionGeneration: preconditions.connectionGeneration,
    snapshotDigest,
    authorityExpectation: {
      active: preconditions.authorityState.active,
      pending: preconditions.authorityState.pending,
    },
  };
  return {
    plan, snapshot, snapshotDigest, local, externalPeople,
    sourceProvenance: importSourceProvenance({ snapshot, snapshotDigest }),
  };
}

function sanitizedReviewPlan(body) {
  return {
    ...sanitizePlanForReview(
      body.plan,
      body.externalPeople,
      body.local.individuals,
      body.snapshot.families,
      body.local.families,
    ),
    operationKind: 'people_import',
  };
}

async function previewImport({ churchId, provider, selection, signal = null } = {}, overrides = {}) {
  const deps = mergeDeps(overrides);
  assertChurchId(churchId);
  assertProvider(provider);
  const normalizedSelection = normalizeSelection(provider, selection);
  assertNotAborted(signal);
  const preconditions = await loadPreconditions({ churchId, provider, deps });
  assertNotAborted(signal);
  const run = await deps.startRun({
    churchId, provider, batchId: null, trigger: 'people_import', fetchMode: 'full',
  });
  try {
    const body = await buildFreshPlan({
      churchId, provider, selection: normalizedSelection, signal, preconditions, deps,
    });
    const planDigest = deps.digestPlan(body.plan);
    const reviewToken = deps.createReviewToken({
      operationKind: 'people_import',
      churchId,
      provider,
      batchId: null,
      planDigest,
      expiresInSeconds: REVIEW_TOKEN_TTL_SECONDS,
    });
    await deps.finishRun({
      churchId,
      provider,
      runId: run.id,
      status: 'review_required',
      counts: countsFromPlan(body.plan),
      externalWatermark: null,
      sourceProvenance: body.sourceProvenance,
    });
    return {
      runId: run.id,
      operationKind: 'people_import',
      selection: normalizedSelection,
      reviewToken,
      decisionContractVersion: DECISION_CONTRACT_VERSION,
      summary: summarizePlan(body.plan),
      coverage: reviewCoverage({
        provider, authoritative: false,
        individuals: body.local.individuals,
        personLinks: body.local.personLinks,
      }),
      plan: sanitizedReviewPlan(body),
      snapshot: { fetchedAt: body.snapshot.fetchedAt, mode: 'full' },
    };
  } catch (error) {
    await safeFailRun(deps, { churchId, provider, runId: run.id, error });
    throw error;
  }
}

async function finishAppliedRun(deps, input) {
  try {
    await deps.finishRun(input);
  } catch (error) {
    logger.error(
      `peopleImport orchestrator: failed to finish an applied run for church ${input.churchId} run ${input.runId}: ${error.message}`
    );
    try {
      await deps.finishRun({ ...input, counts: {}, externalWatermark: null });
    } catch (fallbackError) {
      logger.error(
        `peopleImport orchestrator: failed to finish an applied run fallback for church ${input.churchId} run ${input.runId}: ${fallbackError.message}`
      );
    }
  }
}

async function applyImport({
  churchId, provider, selection, reviewToken, selections = {}, userId, signal = null,
} = {}, overrides = {}) {
  const deps = mergeDeps(overrides);
  assertChurchId(churchId);
  assertProvider(provider);
  const normalizedSelection = normalizeSelection(provider, selection);
  if (typeof reviewToken !== 'string' || !reviewToken) {
    throw new OrchestratorError('SYNC_REVIEW_INVALID', 'A review token is required', 400);
  }
  assertNotAborted(signal);
  const preconditions = await loadPreconditions({ churchId, provider, deps });
  assertNotAborted(signal);
  const authorityExpectation = {
    active: preconditions.authorityState.active,
    pending: preconditions.authorityState.pending,
  };
  const connectionExpectation = { generation: preconditions.connectionGeneration };
  const run = await deps.startRun({
    churchId, provider, batchId: null, trigger: 'people_import', fetchMode: 'full',
  });

  let body;
  let applyResult;
  try {
    body = await buildFreshPlan({
      churchId, provider, selection: normalizedSelection, signal, preconditions, deps,
    });
    const planDigest = deps.digestPlan(body.plan);
    const verification = deps.verifyReviewToken(reviewToken, {
      operationKind: 'people_import',
      churchId,
      provider,
      batchId: null,
      planDigest,
    });
    if (!verification?.ok) throw reviewError(verification?.code);

    assertNotAborted(signal);
    applyResult = await deps.applyPeopleSyncPlan({
      churchId,
      provider,
      plan: body.plan,
      selections,
      userId,
      activateAuthority: false,
      sourcePromotion: null,
      sourceExpectations: null,
      authorityExpectation,
      connectionExpectation,
      requireConnection: true,
      markLinksSeen: false,
      allowedMutationBuckets: ALLOWED_IMPORT_MUTATION_BUCKETS,
      reviewedApply: {
        operationKind: 'people_import',
        reviewToken,
        planDigest,
        batchId: null,
        verifyReviewToken: deps.verifyReviewToken,
      },
    });
  } catch (error) {
    const typedCodes = new Set([
      'SYNC_REVIEW_INVALID', 'SYNC_REVIEW_EXPIRED', 'SYNC_PLAN_STALE',
      'SYNC_REVIEW_ALREADY_APPLIED', 'SYNC_NOT_CONNECTED',
    ]);
    const reported = error instanceof OrchestratorError || !typedCodes.has(error?.code)
      ? error
      : reviewError(error.code);
    await safeFailRun(deps, { churchId, provider, runId: run.id, error: reported });
    throw reported;
  }

  await finishAppliedRun(deps, {
    churchId,
    provider,
    runId: run.id,
    status: 'applied',
    counts: applyResult,
    externalWatermark: null,
    sourceProvenance: body.sourceProvenance,
  });
  return {
    runId: run.id,
    status: 'applied',
    applied: applyResult,
    summary: summarizePlan(body.plan),
  };
}

module.exports = {
  previewImport,
  applyImport,
  groupMembersByFamily,
  memberOnlyMatcherResult,
  defaultDeps,
};
