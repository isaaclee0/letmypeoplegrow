// Provider-neutral sync orchestrator (Task 15 of the provider-neutral
// people-sync project). This is the ONE place that composes every prior
// task into a single fetch -> match -> plan -> review/apply -> audit
// pipeline: routes (Task 16) must call buildReview/applyReviewed/
// runUnattended/previewAuthoritySwitch exclusively and must never call an
// adapter, matcher, plan, or apply module directly.
//
// ─── The 10-step pipeline ───────────────────────────────────────────────────
//
// Every public function below runs (a prefix or all of) this exact order:
//   1. load connection
//   2. load/validate batches and settings
//   3. start audit run
//   4. fetch snapshot
//   5. load local state/links and existing missing counters
//   6. match
//   7. compute the plan (including the projected next missing count, via
//      plan.js's own presenceProjection — see below)
//   8. create a review token, OR apply safe unattended actions
//   9. persist full-fetch presence at most once (only for an applied
//      review or a completed unattended reconciliation — NEVER for a pure
//      preview)
//   10. finish audit run
//
// Steps 1-2 (and the startRun call that begins step 3) happen BEFORE any
// run row exists, so a failure there propagates directly — there is
// nothing to failRun yet. From the moment startRun succeeds onward, any
// error (fetch, local-state loading, matching, plan computation, stale
// review-token detection, selection validation, or apply itself) is
// caught, reported via failRun, and rethrown — apply is never reached
// once any of that has failed.
//
// ─── Missing-counter integrity (the most safety-critical property here) ───
//
// plan.js's own computePeopleSyncPlan already computes the FULL projected
// missing-count bookkeeping (plan.presenceProjection) from whatever
// `personLinks` this module passes in — this module does not re-derive
// that counting logic, it only decides WHEN the durable counters in
// external_person_links get written via linkRepository.recordFullFetchPresence:
//   - buildReview/previewAuthoritySwitch (pure previews): NEVER call it.
//   - applyReviewed: calls it exactly once, AFTER applyPeopleSyncPlan's
//     transaction has committed, using the fresh full snapshot it just
//     fetched for verification. A stale-plan re-fetch inside a retried
//     applyReviewed never double-counts because the write only happens
//     after a successful apply, and only once per successful call.
//   - runUnattended: calls it exactly once per completed classification
//     (whether the run ends 'applied' or 'review_required') for a
//     COMPLETE FULL source set only.
'use strict';

const logger = require('../../config/logger');
const Database = require('../../config/database');
const connectionStore = require('./connectionStore');
const batchRepository = require('./batchRepository');
const unattendedPolicy = require('./unattendedPolicy');
const runRepository = require('./runRepository');
const linkRepository = require('./linkRepository');
const authority = require('./authority');
const providerRegistry = require('./providerRegistry');
const { matchPeople } = require('./matcher');
const { BUCKETS, computePeopleSyncPlan, summarizePlan } = require('./plan');
const { applyPeopleSyncPlan, validateSelections } = require('./apply');
const { digestPlan, createReviewToken, verifyReviewToken } = require('./planDigest');
const { digestSourceIdentity, digestSourceSnapshot } = require('./sourceModel');
const { recordActiveSourceAvailable, recordActiveSourceFailure } = require('./sourceHealth');
const { notifyReviewRequired } = require('./reviewNotification');
const { CODE: LEGACY_BATCH_RETIRED, MESSAGE: LEGACY_BATCH_RETIRED_MESSAGE, isRetiredPlanningCenterBatch } = require('./legacyBatch');

const PROVIDERS = new Set(['planning_center', 'elvanto']);
const BUILD_REVIEW_TRIGGERS = new Set(['onboarding', 'manual', 'full_reconciliation']);
const UNATTENDED_TRIGGERS = new Set(['scheduled']);
const HELD_REVIEW_BUCKETS = ['ambiguousPeople', 'familyConflicts', 'renameFamily', 'unmatchedLocalRegulars'];
const REVIEW_TOKEN_TTL_SECONDS = 30 * 60;
const RAW_FIELD_DENYLIST = new Set(['attributes', 'customFields', 'custom_fields', 'raw', 'rawPayload', 'demographics']);

class OrchestratorError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'OrchestratorError';
    this.code = code;
    this.status = status;
  }
}

function assertProvider(provider) {
  if (!PROVIDERS.has(provider)) throw new OrchestratorError('SYNC_PROVIDER_INVALID', `Unsupported people-sync provider: ${provider}`, 400);
}

function assertChurchId(churchId) {
  if (!churchId || typeof churchId !== 'string') {
    throw new OrchestratorError('SYNC_CHURCH_REQUIRED', 'A churchId is required', 400);
  }
}

// ─── Default (production) collaborators ─────────────────────────────────────

async function defaultListLocalIndividuals(churchId) {
  const rows = await Database.queryForChurch(
    churchId,
    `SELECT id, first_name, last_name, people_type, family_id, is_child, is_active, planning_center_id
       FROM individuals WHERE church_id = ?`,
    [churchId]
  );
  return rows.map((row) => ({
    id: Number(row.id),
    firstName: row.first_name,
    lastName: row.last_name,
    peopleType: row.people_type,
    familyId: row.family_id === null || row.family_id === undefined ? null : Number(row.family_id),
    isChild: !!row.is_child,
    isActive: !!row.is_active,
    planningCenterId: row.planning_center_id || null,
  }));
}

async function defaultListLocalFamilies(churchId) {
  const rows = await Database.queryForChurch(
    churchId,
    `SELECT id, family_name, family_identifier, planning_center_id FROM families WHERE church_id = ?`,
    [churchId]
  );
  return rows.map((row) => ({
    id: Number(row.id),
    familyName: row.family_name,
    familyIdentifier: row.family_identifier,
    planningCenterId: row.planning_center_id || null,
  }));
}

async function defaultListGatheringMemberships(churchId) {
  const rows = await Database.queryForChurch(
    churchId,
    `SELECT gathering_type_id, individual_id, added_by_sync_batch_id FROM gathering_lists WHERE church_id = ?`,
    [churchId]
  );
  return rows.map((row) => ({
    gatheringTypeId: Number(row.gathering_type_id),
    individualId: Number(row.individual_id),
    addedBySyncBatchId: row.added_by_sync_batch_id === null || row.added_by_sync_batch_id === undefined
      ? null : Number(row.added_by_sync_batch_id),
  }));
}

// Church-wide sync settings (people_sync_settings). Column names are
// elvanto-prefixed for historical reasons (only Elvanto currently ever
// produces a 'contact' state — see plan.js/normalizeState — so these are
// the only provider whose behaviour they visibly change today), but the
// table holds exactly one row per church, and plan.js's own
// input.settings.includeContacts/alignPeopleType usage is fully
// provider-neutral, so this loader is shared by every provider.
async function defaultGetSyncSettings(churchId) {
  const rows = await Database.queryForChurch(
    churchId,
    `SELECT elvanto_include_contacts, elvanto_align_people_type FROM people_sync_settings WHERE church_id = ? LIMIT 1`,
    [churchId]
  );
  const row = rows[0] || {};
  return {
    includeContacts: row.elvanto_include_contacts === undefined ? true : !!row.elvanto_include_contacts,
    alignPeopleType: row.elvanto_align_people_type === undefined ? true : !!row.elvanto_align_people_type,
  };
}

const defaultDeps = {
  getConnection: connectionStore.getConnection,
  getCredentials: connectionStore.getCredentials,
  listBatches: batchRepository.listBatches,
  getSyncSettings: defaultGetSyncSettings,
  getAuthority: authority.getAuthority,
  beginAuthoritySwitch: authority.beginAuthoritySwitch,
  startRun: runRepository.startRun,
  finishRun: runRepository.finishRun,
  failRun: runRepository.failRun,
  validateSourceProvenance: runRepository.validateSourceProvenance,
  getProvider: providerRegistry.getProvider,
  listPersonLinks: linkRepository.listPersonLinks,
  listFamilyLinks: linkRepository.listFamilyLinks,
  recordFullFetchPresence: linkRepository.recordFullFetchPresence,
  listLocalIndividuals: defaultListLocalIndividuals,
  listLocalFamilies: defaultListLocalFamilies,
  listGatheringMemberships: defaultListGatheringMemberships,
  matchPeople,
  computePeopleSyncPlan,
  applyPeopleSyncPlan,
  validateSelections,
  digestPlan,
  createReviewToken,
  verifyReviewToken,
  notifyReviewRequired,
  recordActiveSourceAvailable,
  recordActiveSourceFailure,
  getUnattendedProviderEnabled: unattendedPolicy.isProviderUnattendedEnabled,
};

function mergeDeps(overrides) {
  return { ...defaultDeps, ...overrides };
}

// ─── Small pure helpers ──────────────────────────────────────────────────────

function effectiveReviewBatches(batches, batchId) {
  return batches.map((batch) => {
    const useDraft = batchId !== null && batchId !== undefined &&
      String(batch.id) === String(batchId) && !!batch.draftSource;
    return { ...batch, effectiveSource: useDraft ? batch.draftSource : batch.source, effectiveSourceIsDraft: useDraft };
  });
}

function reviewedSourceContext(batches, batchId, sourceProvenance) {
  const batch = batchId === null || batchId === undefined ? null
    : batches.find((candidate) => String(candidate.id) === String(batchId));
  return {
    activeRevision: batch ? batch.sourceRevision : null,
    draftDigest: batch?.draftSource ? digestSourceIdentity(batch.draftSource) : null,
    snapshots: sourceProvenance.map(({ batchId: sourceBatchId, sourceKind, sourceExternalId, snapshotDigest }) => ({
      batchId: sourceBatchId, sourceKind, sourceExternalId, snapshotDigest,
    })).sort((left, right) => Number(left.batchId) - Number(right.batchId)),
  };
}

function groupMembersByFamily(people) {
  const map = new Map();
  for (const person of people) {
    if (person.familyId === null || person.familyId === undefined) continue;
    const key = String(person.familyId);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ id: person.id });
  }
  return map;
}

function countsFromPlan(plan) {
  const counts = {};
  for (const bucket of BUCKETS) counts[bucket] = plan[bucket].length;
  counts.familyNamesUpdated = 0;
  counts.gatheringAssigned = 0;
  counts.gatheringRemoved = 0;
  return counts;
}

// Merges apply.js's actually-applied counts with the PLAN's own review-only
// bucket sizes (apply.js always reports ambiguousPeople/familyConflicts/
// unmatchedLocalRegulars/skipped as 0 — see its own emptyResult() comment —
// since it never mutates anything off them directly), so the audit trail
// and any notification reflect "how many items are pending review", not
// just "how many mutations ran". renameFamily is included in this same
// override for consistency with the other three held-review buckets
// (plan.js does not populate renameFamily yet, so this is currently a
// no-op, but keeps the run's audit counts from under-reporting a pending
// rename once a producer exists) — this does NOT lose the "how many
// renames were actually applied" fact: apply.js increments
// familyNamesUpdated in lockstep with renameFamily for every accepted
// rename it actually applies (see apply.js step 10), and that field is
// left untouched here.
function mergeAppliedCounts(applyResult, plan) {
  return {
    ...applyResult,
    ambiguousPeople: plan.ambiguousPeople.length,
    familyConflicts: plan.familyConflicts.length,
    unmatchedLocalRegulars: plan.unmatchedLocalRegulars.length,
    renameFamily: plan.renameFamily.length,
    skipped: plan.skipped.length,
  };
}

function heldCountsFromPlan(plan) {
  return {
    ambiguousPeople: plan.ambiguousPeople.length,
    familyConflicts: plan.familyConflicts.length,
    renameFamily: plan.renameFamily.length,
    unmatchedLocalRegulars: plan.unmatchedLocalRegulars.length,
  };
}

function hasHeldItems(plan) {
  return HELD_REVIEW_BUCKETS.some((bucket) => plan[bucket].length > 0);
}

function stripRawFields(action) {
  if (!action || typeof action !== 'object') return action;
  const clean = {};
  for (const [key, value] of Object.entries(action)) {
    if (RAW_FIELD_DENYLIST.has(key)) continue;
    clean[key] = value;
  }
  return clean;
}

// Drops raw attributes/custom-field maps not needed to explain an action —
// plan.js's own bucket shapes are already lean (scalar fields only), but
// this stays defensive against a future plan.js change embedding a raw
// external-person fragment on an action.
function sanitizePlanForReview(plan) {
  const sanitized = {
    provider: plan.provider,
    authoritative: plan.authoritative,
    snapshot: { fetchedAt: plan.snapshot.fetchedAt, mode: plan.snapshot.mode },
  };
  for (const bucket of BUCKETS) {
    sanitized[bucket] = (plan[bucket] || []).map(stripRawFields);
  }
  return sanitized;
}

function safeErrorCode(error) {
  const code = error && typeof error.code === 'string' ? error.code : null;
  return code && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'SYNC_RUN_FAILED';
}

function safeErrorMessage(error) {
  const raw = error && typeof error.message === 'string' ? error.message : 'Unknown error';
  const cleaned = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 500);
  return cleaned || 'Unknown error';
}

// Records a run failure without ever letting a failRun problem (e.g. the
// error message itself tripping runRepository's own credential/payload
// detector) mask the ORIGINAL error, and without leaving the run
// permanently stuck in 'running' if the first attempt is rejected.
async function safeFailRun(deps, { churchId, provider, runId, error }) {
  const errorCode = safeErrorCode(error);
  const errorMessage = safeErrorMessage(error);
  try {
    await deps.failRun({ churchId, provider, runId, errorCode, errorMessage });
  } catch (failErr) {
    try {
      await deps.failRun({ churchId, provider, runId, errorCode, errorMessage: 'Sync run failed; see server logs for details.' });
    } catch (fallbackErr) {
      logger.error(`peopleSync orchestrator: failed to record run failure for church ${churchId} run ${runId}: ${fallbackErr.message}`);
    }
  }
}

// Classifies and finishes a run whose applyPeopleSyncPlan call has ALREADY
// committed real church-data mutations — called only from applyReviewed's
// and runUnattended's post-apply tail, never from the fail-on-error path
// above. Folded into one guarded block deliberately: `mergeAppliedCounts`/
// `hasHeldItems` are pure functions over plan/applyResult and should never
// throw, but if something unexpected did throw here, it must still reach a
// finishRun attempt with SOME terminal status rather than silently
// skipping finishRun with no log line (which would leave the row stuck
// 'running' with no diagnostic trail at all).
//
// finishRun itself mirrors safeFailRun's own two-attempt pattern: on
// failure, retry once with a minimal payload (empty counts, no watermark,
// but retaining the already-validated source provenance) so the row still
// reaches a terminal status; only falls through to log-only (leaving the
// row 'running') if that retry also fails. Nothing here may ever route
// through safeFailRun/failRun — a run that already mutated real data must
// never be recorded 'failed'.
async function finishAppliedRun(deps, {
  churchId, provider, runId, plan, applyResult, externalWatermark, sourceProvenance, reviewRequiredWhenHeld,
}) {
  let status = 'applied';
  let counts = {};
  try {
    counts = mergeAppliedCounts(applyResult, plan);
    if (reviewRequiredWhenHeld && hasHeldItems(plan)) status = 'review_required';
  } catch (classifyErr) {
    logger.error(`peopleSync orchestrator: failed to classify run outcome for church ${churchId} run ${runId}: ${classifyErr.message}`);
  }

  try {
    await deps.finishRun({ churchId, provider, runId, status, counts, externalWatermark, sourceProvenance });
  } catch (finishErr) {
    logger.error(
      `peopleSync orchestrator: failed to finish an already-applied run for church ${churchId} run ${runId}: ${finishErr.message}`
    );
    try {
      await deps.finishRun({ churchId, provider, runId, status, counts: {}, externalWatermark: null, sourceProvenance });
    } catch (fallbackErr) {
      logger.error(
        `peopleSync orchestrator: failed to finish an already-applied run (fallback) for church ${churchId} run ${runId}: ${fallbackErr.message}`
      );
    }
  }

  return { status, counts };
}

// Same "must not throw" reasoning as finishAppliedRun above, for the
// summary object returned to the caller after a successful apply.
function safeSummarizePlan(logContext, plan) {
  try {
    return summarizePlan(plan);
  } catch (err) {
    logger.error(`peopleSync orchestrator: failed to summarize plan for church ${logContext.churchId} run ${logContext.runId}: ${err.message}`);
    return {};
  }
}

// ─── Steps 1-2: load connection, batches, settings, authority ───────────────

async function loadPreconditions({ churchId, provider, batchId, deps }) {
  // 1. load connection
  const connection = await deps.getConnection(churchId, provider);
  if (!connection) throw new OrchestratorError('SYNC_NOT_CONNECTED', `No ${provider} connection for this church`, 400);
  if (connection.connectionStatus === 'invalid') {
    throw new OrchestratorError('SYNC_CONNECTION_INVALID', `The ${provider} connection is marked invalid`, 400);
  }
  const credentials = await deps.getCredentials(churchId, provider);
  if (!credentials) throw new OrchestratorError('SYNC_NOT_CONNECTED', `No ${provider} credentials for this church`, 400);

  const adapter = deps.getProvider(provider);

  // 2. load/validate batches and settings
  const all = await deps.listBatches(churchId, provider);
  const providerBatches = all || [];
  if (batchId !== null && batchId !== undefined) {
    const batch = providerBatches.find((candidate) => candidate.id === batchId);
    if (!batch) throw new OrchestratorError('SYNC_BATCH_NOT_FOUND', `Batch ${batchId} not found for ${provider}`, 404);
    if (isRetiredPlanningCenterBatch(batch)) {
      throw new OrchestratorError(LEGACY_BATCH_RETIRED, LEGACY_BATCH_RETIRED_MESSAGE, 409);
    }
    if (!batch.enabled) throw new OrchestratorError('SYNC_BATCH_DISABLED', `Batch ${batchId} is disabled`, 400);
  }
  const batches = providerBatches.filter((batch) => batch.enabled);
  if (batches.length === 0) throw new OrchestratorError('SYNC_NO_BATCHES', `No enabled ${provider} batches to review`, 400);

  const settings = await deps.getSyncSettings(churchId);
  const authorityState = await deps.getAuthority(churchId);

  return { connection, credentials, adapter, batches, settings, authorityState };
}

// ─── Steps 4-7: fetch, load local state, match, plan ────────────────────────

function sameSourceIdentity(left, right) {
  return !!left && !!right && left.kind === right.kind && String(left.externalId) === String(right.externalId);
}

function sourceIncomplete(provider) {
  return new OrchestratorError('SYNC_SOURCE_INCOMPLETE', `${provider} source did not return a complete snapshot`, 502);
}

function sourceUnavailable(provider) {
  return new OrchestratorError('SYNC_SOURCE_UNAVAILABLE', `${provider} source is unavailable`, 502);
}

function personId(person) {
  const id = person?.id === null || person?.id === undefined ? '' : String(person.id);
  return id || null;
}

function isIsoTimestamp(value, { allowNull = false } = {}) {
  if (value === null && allowNull) return true;
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function snapshotDigestInput(snapshot) {
  const normalizePerson = (person) => ({
    ...person,
    name: `${person?.firstName ?? ''}\u0000${person?.lastName ?? ''}`,
  });
  return {
    ...snapshot,
    providerRefreshedAt: snapshot.providerRefreshedAt ?? snapshot.source?.providerRefreshedAt ?? null,
    people: (snapshot.people || []).map(normalizePerson),
    context: (snapshot.contextPeople || []).map(normalizePerson),
    families: (snapshot.families || []).map((family) => ({
      ...family,
      primaryContactId: family?.primaryContactId ?? family?.primaryContactExternalId ?? null,
    })),
  };
}

async function recordSourceFailureSafely(deps, input) {
  try {
    await deps.recordActiveSourceFailure(input);
  } catch (healthError) {
    logger.error(`peopleSync orchestrator: failed to record source health for church ${input.churchId} batch ${input.batchId}: ${healthError.message}`);
  }
}

async function acquireSourceSet({ churchId, provider, batches, settings, credentials, adapter, deps }) {
  const eligibleByBatch = new Map();
  const seenMemberExternalIds = new Set();
  const memberPeopleById = new Map();
  const ineligibleMemberPeopleById = new Map();
  const matchingPeopleById = new Map();
  const familiesById = new Map();
  const sourceProvenance = [];

  for (const batch of batches) {
    const selectedSource = batch.effectiveSource ?? batch.source;
    if (!selectedSource) {
      throw new OrchestratorError('SYNC_SOURCE_SELECTION_REQUIRED', `Batch ${batch.id} needs a sync source selection`, 409);
    }
    const activeRead = !batch.effectiveSourceIsDraft && sameSourceIdentity(selectedSource, batch.source);
    let sourceSnapshot;
    try {
      sourceSnapshot = await adapter.fetchSourceSnapshot({
        churchId,
        credentials,
        sourceKind: selectedSource.kind,
        sourceExternalId: selectedSource.externalId,
      });
      const providerRefreshedAt = sourceSnapshot?.providerRefreshedAt ?? sourceSnapshot?.source?.providerRefreshedAt ?? null;
      if (!sourceSnapshot || sourceSnapshot.provider !== provider ||
          !sourceSnapshot.source || typeof sourceSnapshot.source !== 'object' || Array.isArray(sourceSnapshot.source)) {
        throw sourceIncomplete(provider);
      }
      if (!sameSourceIdentity(sourceSnapshot.source, selectedSource)) throw sourceUnavailable(provider);
      if (sourceSnapshot.complete !== true || typeof sourceSnapshot.source.kind !== 'string' ||
          typeof sourceSnapshot.source.externalId !== 'string' ||
          typeof sourceSnapshot.source.name !== 'string' || !sourceSnapshot.source.name.trim() ||
          !isIsoTimestamp(sourceSnapshot.fetchedAt) || !isIsoTimestamp(providerRefreshedAt, { allowNull: true }) ||
          !Array.isArray(sourceSnapshot.memberExternalIds) || !Array.isArray(sourceSnapshot.people) ||
          !Array.isArray(sourceSnapshot.contextPeople) || !Array.isArray(sourceSnapshot.families)) {
        throw sourceIncomplete(provider);
      }

      const sourcePeopleById = new Map();
      for (const candidate of sourceSnapshot.people) {
        const id = personId(candidate);
        if (!id) throw sourceIncomplete(provider);
        if (!sourcePeopleById.has(id)) sourcePeopleById.set(id, candidate);
      }
      const contextPeopleById = new Map();
      for (const candidate of sourceSnapshot.contextPeople) {
        const id = personId(candidate);
        if (!id || sourcePeopleById.has(id)) throw sourceIncomplete(provider);
        if (!contextPeopleById.has(id)) contextPeopleById.set(id, candidate);
      }
      const memberIds = new Set();
      const eligible = new Set();
      for (const rawId of sourceSnapshot.memberExternalIds) {
        const id = rawId === null || rawId === undefined ? '' : String(rawId);
        const member = sourcePeopleById.get(id);
        if (!id || !member) throw sourceIncomplete(provider);
        memberIds.add(id);
        // Lifecycle-ineligible records remain part of the provider snapshot
        // digest/provenance, but never become actionable or "seen" members.
        if (!adapter.isLifecycleEligible(member, settings)) {
          if (!memberPeopleById.has(id)) {
            if (!ineligibleMemberPeopleById.has(id)) {
              ineligibleMemberPeopleById.set(id, member);
            }
            matchingPeopleById.delete(id);
          }
          continue;
        }
        eligible.add(id);
        seenMemberExternalIds.add(id);
        ineligibleMemberPeopleById.delete(id);
        if (!memberPeopleById.has(id)) {
          memberPeopleById.set(id, member);
          matchingPeopleById.set(id, member);
        }
      }
      for (const contextPerson of contextPeopleById.values()) {
        const id = personId(contextPerson);
        if (!matchingPeopleById.has(id) && !ineligibleMemberPeopleById.has(id)) {
          matchingPeopleById.set(id, contextPerson);
        }
      }
      for (const family of sourceSnapshot.families) {
        const id = family?.id === null || family?.id === undefined ? '' : String(family.id);
        if (!id) throw sourceIncomplete(provider);
        if (!familiesById.has(id)) familiesById.set(id, family);
      }

      eligibleByBatch.set(batch.id, eligible);

      const provenanceEntry = {
        batchId: batch.id,
        sourceKind: selectedSource.kind,
        sourceExternalId: String(selectedSource.externalId),
        sourceName: sourceSnapshot.source.name,
        memberCount: memberIds.size,
        providerRefreshedAt,
        fetchedAt: sourceSnapshot.fetchedAt,
        snapshotDigest: digestSourceSnapshot(snapshotDigestInput(sourceSnapshot)),
      };
      deps.validateSourceProvenance([...sourceProvenance, provenanceEntry], provider);
      sourceProvenance.push(provenanceEntry);

      if (activeRead) {
        await deps.recordActiveSourceAvailable({
          churchId, provider, batchId: batch.id, expectedSource: batch.source,
          observedSource: sourceSnapshot.source, checkedAt: sourceSnapshot.fetchedAt,
        });
      }
    } catch (error) {
      const failure = error?.code ? error : sourceIncomplete(provider);
      if (activeRead) {
        await recordSourceFailureSafely(deps, {
          churchId, provider, batchId: batch.id, expectedSource: batch.source,
          code: failure.code, checkedAt: new Date().toISOString(),
        });
      }
      throw failure;
    }
  }

  const fetchedAt = sourceProvenance.map((entry) => entry.fetchedAt).sort().at(-1) || new Date().toISOString();
  return {
    snapshot: {
      provider,
      mode: 'full',
      complete: true,
      fetchedAt,
      watermark: null,
      people: [...memberPeopleById.values()],
      families: [...familiesById.values()],
    },
    matchingPeople: [...matchingPeopleById.values()],
    ineligibleMemberPeople: [...ineligibleMemberPeopleById.values()],
    ignoredLifecycleExternalIds: new Set(ineligibleMemberPeopleById.keys()),
    eligibleByBatch,
    seenMemberExternalIds,
    sourceProvenance,
  };
}

function memberOnlyMatcherResult(result, memberIds) {
  const member = (value) => memberIds.has(String(value?.externalPersonId));
  return {
    ...result,
    linked: (result.linked || []).filter(member),
    matches: (result.matches || []).filter(member),
    ambiguous: (result.ambiguous || []).filter(member),
    visitorMatches: (result.visitorMatches || []).filter(member),
    archivedMatches: (result.archivedMatches || []).filter(member),
    unmatchedExternalIds: (result.unmatchedExternalIds || []).filter((id) => memberIds.has(String(id))),
  };
}

async function runPipelineBody({
  churchId, provider, trigger, authoritative, activeAuthority,
  batches, settings, credentials, adapter, deps,
}) {
  // 4. Fetch every provider-owned source sequentially and build one member union.
  const acquired = await acquireSourceSet({ churchId, provider, batches, settings, credentials, adapter, deps });
  const { snapshot } = acquired;

  // 5. load local state/links and existing missing counters
  const [individuals, families, personLinks, familyLinks, gatheringMemberships] = await Promise.all([
    deps.listLocalIndividuals(churchId),
    deps.listLocalFamilies(churchId),
    deps.listPersonLinks(churchId, provider),
    deps.listFamilyLinks(churchId, provider),
    deps.listGatheringMemberships(churchId),
  ]);

  const linkedExternalIds = new Set(personLinks.map((link) => String(link.externalPersonId)));
  const matchingPeople = [...acquired.matchingPeople];
  // Retain an ineligible record only when it protects an existing durable
  // link from being rematched. Its matcher result and presence projection
  // are filtered below, so this context cannot create lifecycle actions.
  for (const person of acquired.ineligibleMemberPeople) {
    if (linkedExternalIds.has(String(person.id))) matchingPeople.push(person);
  }
  const actionablePersonLinks = personLinks.filter((link) =>
    !acquired.ignoredLifecycleExternalIds.has(String(link.externalPersonId))
  );

  // 6. match
  const matcherResult = memberOnlyMatcherResult(deps.matchPeople({
    externalPeople: matchingPeople,
    localPeople: individuals,
    existingLinks: personLinks.map((link) => ({ externalPersonId: link.externalPersonId, individualId: link.individualId })),
    externalFamilyMembers: groupMembersByFamily(matchingPeople),
    localFamilyMembers: groupMembersByFamily(individuals),
  }), acquired.seenMemberExternalIds);

  // 7. compute the plan (plan.js's own presenceProjection computes the
  // projected next missing count for a complete full snapshot from the
  // personLinks passed in here — this module never re-derives that logic).
  const plan = deps.computePeopleSyncPlan({
    provider,
    externalPeople: snapshot.people,
    localPeople: individuals,
    matcher: matcherResult,
    batches,
    eligibleByBatch: acquired.eligibleByBatch,
    settings,
    authoritative,
    activeAuthority,
    trigger,
    personLinks: actionablePersonLinks.map((link) => ({
      externalPersonId: link.externalPersonId, individualId: link.individualId, missingFullSyncCount: link.missingFullSyncCount,
    })),
    snapshot: { fetchedAt: snapshot.fetchedAt, watermark: snapshot.watermark, mode: snapshot.mode, complete: snapshot.complete },
    familyConflicts: [],
    gatheringMemberships,
  });

  return { ...acquired, individuals, families, personLinks, familyLinks, gatheringMemberships, matcherResult, plan };
}

// ─── buildReview ─────────────────────────────────────────────────────────────
//
// Always uses a full snapshot for onboarding, manual, "review & sync", and
// (via previewAuthoritySwitch) authority switching. Never applies anything,
// never increments missing counters — a pure preview, however many times
// it is called.
async function buildReview({ churchId, provider, batchId = null, trigger, forceFull } = {}, overrides = {}) {
  void forceFull; // accepted for interface parity; buildReview is always a full-snapshot preview.
  const deps = mergeDeps(overrides);
  assertChurchId(churchId);
  assertProvider(provider);
  if (!BUILD_REVIEW_TRIGGERS.has(trigger)) {
    throw new OrchestratorError('SYNC_TRIGGER_INVALID', `Invalid buildReview trigger: ${trigger}`, 400);
  }

  const pre = await loadPreconditions({ churchId, provider, batchId, deps });
  const reviewBatches = effectiveReviewBatches(pre.batches, batchId);
  const authoritative = pre.authorityState.active === provider;
  const activeAuthority = pre.authorityState.active;

  const run = await deps.startRun({ churchId, provider, batchId, trigger, fetchMode: 'full' });
  try {
    const body = await runPipelineBody({
      churchId, provider, trigger, mode: 'full', watermark: undefined,
      authoritative, activeAuthority, batches: reviewBatches, settings: pre.settings,
      credentials: pre.credentials, adapter: pre.adapter, deps,
    });

    body.plan.sourceContext = reviewedSourceContext(pre.batches, batchId, body.sourceProvenance);
    const planDigest = deps.digestPlan(body.plan);
    const reviewToken = deps.createReviewToken({
      churchId, provider, batchId, planDigest, expiresInSeconds: REVIEW_TOKEN_TTL_SECONDS,
    });

    await deps.finishRun({
      churchId, provider, runId: run.id, status: 'review_required',
      counts: countsFromPlan(body.plan), externalWatermark: null, sourceProvenance: body.sourceProvenance,
    });

    return {
      runId: run.id,
      reviewToken,
      summary: summarizePlan(body.plan),
      plan: sanitizePlanForReview(body.plan),
      snapshot: { fetchedAt: body.plan.snapshot.fetchedAt, mode: body.plan.snapshot.mode },
    };
  } catch (err) {
    await safeFailRun(deps, { churchId, provider, runId: run.id, error: err });
    throw err;
  }
}

// ─── previewAuthoritySwitch ──────────────────────────────────────────────────
//
// Stages the switch (beginAuthoritySwitch sets pending_authority_provider)
// and builds a full reconciliation review AS IF `provider` were already
// authoritative (authoritative: true, activeAuthority: provider), even
// though people_sync_settings.authority_provider itself does not flip
// until a later applyReviewed call succeeds and activates it inside the
// same transaction as the reviewed reconciliation.
// Always review-only — never applies anything, never touches presence
// counters.
async function previewAuthoritySwitch({ churchId, provider } = {}, overrides = {}) {
  const deps = mergeDeps(overrides);
  assertChurchId(churchId);
  assertProvider(provider);

  // Validate preconditions BEFORE staging the switch: if the church isn't
  // connected, has no enabled batches, etc., we must not leave
  // pending_authority_provider set with no review token ever issued — that
  // would be confusing, lingering state for a preview that never happened.
  const pre = await loadPreconditions({ churchId, provider, batchId: null, deps });
  // beginAuthoritySwitch is the source of truth for the resulting pending
  // state — it does NOT always set pending to `provider` (e.g. re-previewing
  // the CURRENT active authority clears pending back to null; see
  // authority.js). Never assume/echo `provider` here.
  const authorityState = await deps.beginAuthoritySwitch(churchId, provider);

  const run = await deps.startRun({ churchId, provider, batchId: null, trigger: 'authority_switch', fetchMode: 'full' });
  try {
    const body = await runPipelineBody({
      churchId, provider, trigger: 'authority_switch', mode: 'full', watermark: undefined,
      authoritative: true, activeAuthority: provider, batches: pre.batches, settings: pre.settings,
      credentials: pre.credentials, adapter: pre.adapter, deps,
    });

    body.plan.sourceContext = reviewedSourceContext(pre.batches, null, body.sourceProvenance);
    const planDigest = deps.digestPlan(body.plan);
    const reviewToken = deps.createReviewToken({
      churchId, provider, batchId: null, planDigest, expiresInSeconds: REVIEW_TOKEN_TTL_SECONDS,
    });

    await deps.finishRun({
      churchId, provider, runId: run.id, status: 'review_required',
      counts: countsFromPlan(body.plan), externalWatermark: null, sourceProvenance: body.sourceProvenance,
    });

    return {
      runId: run.id,
      reviewToken,
      summary: summarizePlan(body.plan),
      plan: sanitizePlanForReview(body.plan),
      snapshot: { fetchedAt: body.plan.snapshot.fetchedAt, mode: body.plan.snapshot.mode },
      authority: authorityState,
    };
  } catch (err) {
    await safeFailRun(deps, { churchId, provider, runId: run.id, error: err });
    throw err;
  }
}

function reviewTokenErrorStatus(code) {
  return code === 'SYNC_REVIEW_INVALID' ? 400 : 409;
}

function reviewTokenErrorMessage(code) {
  if (code === 'SYNC_PLAN_STALE') return 'The reviewed plan is out of date; fetch a fresh review before applying.';
  if (code === 'SYNC_REVIEW_EXPIRED') return 'This review has expired; fetch a fresh review before applying.';
  return 'This review token is invalid.';
}

// ─── applyReviewed ───────────────────────────────────────────────────────────
//
// Re-fetches a fresh full snapshot, rebuilds the plan under the SAME
// authoritative/activeAuthority stance the reviewed plan would have used
// (normal apply: whatever is currently the real active authority;
// authority-switch apply: pretend `provider` is already authoritative,
// detected via people_sync_settings.pending_authority_provider === provider
// — the signal beginAuthoritySwitch left behind at preview time), verifies
// the caller's token against the FRESH digest, validates selections, then
// applies inside apply.js's one critical transaction.
//
// IMPORTANT: once applyPeopleSyncPlan has committed, real church data has
// already been durably mutated (people created/archived/linked). Nothing
// after that point may ever cause this run's audit record to read
// 'failed' — that would misrepresent a successful import/archive as
// having not happened. Authority activation is committed inside that same
// apply transaction; only presence accounting and finishRun remain
// best-effort after it returns.
async function applyReviewed({ churchId, provider, batchId = null, reviewToken, selections = {}, userId } = {}, overrides = {}) {
  const deps = mergeDeps(overrides);
  assertChurchId(churchId);
  assertProvider(provider);
  if (typeof reviewToken !== 'string' || reviewToken.length === 0) {
    throw new OrchestratorError('SYNC_REVIEW_INVALID', 'A review token is required', 400);
  }

  const pre = await loadPreconditions({ churchId, provider, batchId, deps });
  const reviewBatches = effectiveReviewBatches(pre.batches, batchId);
  const isAuthoritySwitch = pre.authorityState.pending === provider;
  const authoritative = isAuthoritySwitch ? true : pre.authorityState.active === provider;
  const activeAuthority = isAuthoritySwitch ? provider : pre.authorityState.active;
  const trigger = isAuthoritySwitch ? 'authority_switch' : 'manual';

  const run = await deps.startRun({ churchId, provider, batchId, trigger, fetchMode: 'full' });

  // Everything that can still legitimately fail THIS run (fetch,
  // local-state loading, matching, plan computation, stale-token
  // detection, selection validation, and the apply itself) is caught here
  // and reported through failRun — apply is never reached once any of it
  // has failed. Once applyPeopleSyncPlan below returns successfully, we
  // exit this try/catch entirely; see the best-effort tail beneath it.
  let body;
  let applyResult;
  try {
    body = await runPipelineBody({
      churchId, provider, trigger, mode: 'full', watermark: undefined,
      authoritative, activeAuthority, batches: reviewBatches, settings: pre.settings,
      credentials: pre.credentials, adapter: pre.adapter, deps,
    });

    body.plan.sourceContext = reviewedSourceContext(pre.batches, batchId, body.sourceProvenance);
    const planDigest = deps.digestPlan(body.plan);
    const verification = deps.verifyReviewToken(reviewToken, { churchId, provider, batchId, planDigest });
    if (!verification.ok) {
      throw new OrchestratorError(verification.code, reviewTokenErrorMessage(verification.code), reviewTokenErrorStatus(verification.code));
    }

    try {
      deps.validateSelections(body.plan, selections);
    } catch (selectionErr) {
      throw new OrchestratorError('SYNC_SELECTIONS_INVALID', selectionErr.message, 400);
    }

    // 8. apply — the last step that may still cause this run to be
    // recorded as failed.
    const reviewedBatch = pre.batches.find((candidate) => String(candidate.id) === String(batchId));
    applyResult = await deps.applyPeopleSyncPlan({
      churchId, provider, plan: body.plan, selections, userId,
      activateAuthority: isAuthoritySwitch,
      sourcePromotion: reviewedBatch?.draftSource ? {
        batchId: reviewedBatch.id,
        expectedBaseRevision: reviewedBatch.draftSourceBaseRevision,
        expectedDraftDigest: digestSourceIdentity(reviewedBatch.draftSource),
      } : null,
    });
  } catch (err) {
    await safeFailRun(deps, { churchId, provider, runId: run.id, error: err });
    throw err;
  }

  // 9. persist full-fetch presence at most once. applyReviewed always
  // re-fetched the complete provider-owned source set above, so this is
  // unconditional here.
  try {
    await deps.recordFullFetchPresence(churchId, provider, body.seenMemberExternalIds, {
      complete: true, ignoredExternalIds: body.ignoredLifecycleExternalIds,
    });
  } catch (presenceErr) {
    logger.warn(`peopleSync orchestrator: presence accounting failed for church ${churchId} run ${run.id}: ${presenceErr.message}`);
  }

  // 10. classify and finish the audit run — see finishAppliedRun's own
  // header note for why this is one guarded block rather than a bare
  // mergeAppliedCounts()/finishRun() pair.
  const { status } = await finishAppliedRun(deps, {
    churchId, provider, runId: run.id, plan: body.plan, applyResult,
    externalWatermark: null, sourceProvenance: body.sourceProvenance, reviewRequiredWhenHeld: false,
  });

  return {
    runId: run.id, status, applied: applyResult, summary: safeSummarizePlan({ churchId, runId: run.id }, body.plan),
  };
}

// ─── runUnattended ───────────────────────────────────────────────────────────
//
// Permitted only when `provider` is the church's current active authority.
// Applies deterministic links, additions, managed updates, explicit
// upstream archive/reactivate (including a CONFIRMED — i.e. already at
// count >= 2 — missing-person archive; plan.js itself never proposes an
// archive action below count 2, see its addMissingActions), and
// provenance-safe gathering changes, by calling applyPeopleSyncPlan with
// NO selections. ambiguousPeople/familyConflicts/renameFamily/
// unmatchedLocalRegulars are never mutated by apply.js regardless of
// selections, so "stripping" them is a matter of how this run's outcome is
// CLASSIFIED and reported, not of altering what apply.js does: whenever any
// of those four buckets is non-empty, the run is marked review_required
// (with its pending counts) instead of applied, and notifyReviewRequired is
// called so admins learn about it later (a scheduled run has nobody
// watching in real time — unlike buildReview/applyReviewed, which are
// always interactive, so they never call notifyReviewRequired themselves).
async function runUnattended({ churchId, provider, batchId, forceFull = false, trigger = 'scheduled' } = {}, overrides = {}) {
  void forceFull; // Provider-owned sources have only a complete full-snapshot contract.
  const deps = mergeDeps(overrides);
  assertChurchId(churchId);
  assertProvider(provider);
  if (batchId === null || batchId === undefined) {
    throw new OrchestratorError('SYNC_BATCH_REQUIRED', 'runUnattended requires a batchId', 400);
  }
  if (!UNATTENDED_TRIGGERS.has(trigger)) {
    throw new OrchestratorError('SYNC_TRIGGER_INVALID', `Invalid runUnattended trigger: ${trigger}`, 400);
  }

  const pre = await loadPreconditions({ churchId, provider, batchId, deps });
  if (pre.authorityState.active !== provider) {
    throw new OrchestratorError(
      'SYNC_AUTHORITY_MISMATCH',
      `Provider "${provider}" is not the active people-sync authority for this church`,
      409
    );
  }
  if (!(await deps.getUnattendedProviderEnabled(churchId, provider))) {
    throw new OrchestratorError(
      'SYNC_UNATTENDED_DISABLED',
      `Unattended ${provider === 'planning_center' ? 'Planning Center' : provider} sync is disabled for this church`,
      409
    );
  }

  if (pre.batches.some((batch) => batch.draftSource)) {
    throw new OrchestratorError('SYNC_SOURCE_REVIEW_REQUIRED', 'A source selection draft must be reviewed before unattended sync can run', 409);
  }
  if (pre.batches.some((batch) => !batch.source)) {
    throw new OrchestratorError('SYNC_SOURCE_SELECTION_REQUIRED', 'Every enabled batch needs a sync source before unattended sync can run', 409);
  }
  const mode = 'full';

  const run = await deps.startRun({ churchId, provider, batchId, trigger, fetchMode: mode });

  // Same principle as applyReviewed: once applyPeopleSyncPlan below has
  // committed, real church data has already been mutated, so nothing
  // after it may cause this run to be recorded 'failed' — see the
  // best-effort tail beneath this try/catch.
  let body;
  let applyResult;
  try {
    body = await runPipelineBody({
      churchId, provider, trigger,
      authoritative: true, activeAuthority: provider, batches: effectiveReviewBatches(pre.batches, null), settings: pre.settings,
      credentials: pre.credentials, adapter: pre.adapter, deps,
    });

    // 8. apply safe unattended actions (no selections — ambiguous/conflict/
    // rename/unmatched-local buckets are never mutated by apply.js off an
    // empty selection set regardless).
    applyResult = await deps.applyPeopleSyncPlan({ churchId, provider, plan: body.plan, selections: {}, userId: null });
  } catch (err) {
    await safeFailRun(deps, { churchId, provider, runId: run.id, error: err });
    throw err;
  }

  // 9. persist member-only full-fetch presence exactly once after apply.
  try {
    await deps.recordFullFetchPresence(churchId, provider, body.seenMemberExternalIds, {
      complete: true, ignoredExternalIds: body.ignoredLifecycleExternalIds,
    });
  } catch (presenceErr) {
    logger.warn(`peopleSync orchestrator: presence accounting failed for church ${churchId} run ${run.id}: ${presenceErr.message}`);
  }

  // 10. classify and finish the audit run — see finishAppliedRun's own
  // header note for why this is one guarded block rather than a bare
  // hasHeldItems()/mergeAppliedCounts()/finishRun() sequence.
  const { status, counts } = await finishAppliedRun(deps, {
    churchId, provider, runId: run.id, plan: body.plan, applyResult,
    externalWatermark: null, sourceProvenance: body.sourceProvenance, reviewRequiredWhenHeld: true,
  });

  if (status === 'review_required') {
    try {
      // Held-bucket counts only (see HELD_REVIEW_BUCKETS) — note all four
      // are currently church-wide/batch-invariant in practice (matching/
      // unmatched-local review does not vary per batch today), which is
      // what makes per-provider (not per-batch) notification dedup safe;
      // revisit if a held bucket ever becomes batch-scoped.
      await deps.notifyReviewRequired({ churchId, provider, runId: run.id, counts: heldCountsFromPlan(body.plan) });
    } catch (notifyErr) {
      logger.error(`peopleSync orchestrator: review notification failed for church ${churchId} run ${run.id}: ${notifyErr.message}`);
    }
  }

  return {
    runId: run.id,
    status,
    counts,
    fetchMode: mode,
    complete: body.snapshot.complete,
    externalWatermark: body.snapshot.watermark,
  };
}

module.exports = {
  OrchestratorError,
  buildReview,
  applyReviewed,
  runUnattended,
  previewAuthoritySwitch,
  sanitizePlanForReview,
  // Exported for orchestrator.test.js's dependency-injected unit tests.
  defaultDeps,
};
