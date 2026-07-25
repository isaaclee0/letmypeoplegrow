const BUCKETS = [
  'linkPeople', 'linkFamilies', 'addPeople', 'addFamilies', 'updateManagedFields',
  'promoteToRegular', 'demoteToLocalVisitor', 'archive', 'reactivate', 'moveFamily',
  'renameFamily', 'addToGathering', 'removeFromGathering', 'ambiguousPeople',
  'familyConflicts', 'unmatchedLocalRegulars', 'skipped',
];

function stableString(value) {
  return String(value ?? '');
}

function canonicalString(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalString).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalString(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function compareById(left, right) {
  return stableString(left?.id).localeCompare(stableString(right?.id), 'en');
}

function uniqueBy(items, keyFor) {
  const byKey = new Map();
  for (const item of items || []) {
    const key = keyFor(item);
    if (!byKey.has(key) || canonicalString(item) < canonicalString(byKey.get(key))) byKey.set(key, item);
  }
  return [...byKey.values()];
}

function normalizedExternalPeople(people) {
  return uniqueBy(people, (item) => stableString(item?.id))
    .map((item) => clone(item))
    .sort((a, b) => stableString(a.id).localeCompare(stableString(b.id), 'en'));
}

function normalizedLocalPeople(people) {
  return uniqueBy(people, (item) => Number(item?.id))
    .map((item) => clone(item))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

function idsFrom(value) {
  const values = value instanceof Set ? [...value] : Array.isArray(value) ? value : [];
  return new Set(values.map(stableString));
}

function explicitEligibility(input, batch) {
  const source = input?.eligibleByBatch;
  if (source instanceof Map && source.has(batch.id)) return source.get(batch.id);
  if (source && typeof source === 'object' && Object.hasOwn(source, batch.id)) return source[batch.id];
  return batch.eligibleExternalPersonIds || batch.eligiblePersonIds || [];
}

function buildEligibility(input) {
  const batches = (input?.batches || [])
    .filter((item) => item?.enabled !== false)
    .map((item) => clone(item))
    .sort((a, b) => Number(a.id) - Number(b.id));
  const eligibleByBatch = new Map();
  const eligibleUnion = new Set();
  for (const batch of batches) {
    const eligible = idsFrom(explicitEligibility(input, batch));
    eligibleByBatch.set(batch.id, eligible);
    for (const externalPersonId of eligible) eligibleUnion.add(externalPersonId);
  }
  return { batches, eligibleByBatch, eligibleUnion };
}

function normalizeState(value) {
  return stableString(value || 'active').trim().toLowerCase();
}

function isTerminalState(state) {
  return state === 'archived' || state === 'deceased';
}

function desiredPeopleType(externalPerson, qualifyingBatches) {
  const state = stableString(externalPerson?.state).trim().toLowerCase();
  if (state === 'contact') return 'local_visitor';
  if (state === 'active') return 'regular';
  const types = qualifyingBatches.map((item) => item.defaultPeopleType).filter(Boolean);
  if (types.includes('regular')) return 'regular';
  return types.sort()[0] || 'regular';
}

function isActive(localPerson) {
  return localPerson?.isActive !== false && localPerson?.isActive !== 0;
}

function peopleType(localPerson) {
  return localPerson?.peopleType || 'regular';
}

function sortNumeric(values) {
  return [...(values || [])].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
}

function buildAmbiguousPeople(matcherResult) {
  return (matcherResult?.ambiguous || []).map((conflict) => {
    const externalPersonId = stableString(conflict?.externalPersonId);
    const reason = stableString(conflict?.reason || 'ambiguous');
    const action = { id: `ambiguousPeople:${externalPersonId}:${reason}`, ...clone(conflict), externalPersonId };
    if (Array.isArray(conflict?.candidateIndividualIds)) {
      action.candidateIndividualIds = sortNumeric(conflict.candidateIndividualIds);
    }
    if (Array.isArray(conflict?.staleLinkedIndividualIds)) {
      action.staleLinkedIndividualIds = sortNumeric(conflict.staleLinkedIndividualIds);
    }
    return action;
  }).sort(compareById);
}

function identityRows(matcherResult, conflictIds) {
  const rows = [];
  const add = (bucket, reviewRequired) => {
    for (const match of matcherResult?.[bucket] || []) {
      const externalPersonId = stableString(match?.externalPersonId);
      if (conflictIds.has(externalPersonId)) continue;
      rows.push({ ...clone(match), externalPersonId, individualId: Number(match.individualId), bucket, reviewRequired });
    }
  };
  add('linked', false);
  add('matches', false);
  add('visitorMatches', true);
  add('archivedMatches', true);
  rows.sort((a, b) => a.externalPersonId.localeCompare(b.externalPersonId, 'en') || a.individualId - b.individualId);
  return uniqueBy(rows, (row) => row.externalPersonId);
}

function managedFieldChanges(externalPerson, localPerson) {
  const changes = [];
  const compare = (field, localValue, externalValue) => {
    if (externalValue !== undefined && externalValue !== null && localValue !== externalValue) {
      changes.push({ field, localValue, externalValue });
    }
  };
  compare('firstName', localPerson?.firstName, externalPerson?.firstName);
  compare('lastName', localPerson?.lastName, externalPerson?.lastName);
  if (typeof externalPerson?.child === 'boolean') compare('isChild', Boolean(localPerson?.isChild), externalPerson.child);
  return changes;
}

function actionExists(actions, externalPersonId, individualId) {
  return actions.some((item) => item.externalPersonId === externalPersonId && item.individualId === individualId);
}

function qualifyingBatchesFor(externalPersonId, batches, eligibleByBatch) {
  return batches.filter((batch) => eligibleByBatch.get(batch.id)?.has(externalPersonId));
}

function addLifecycleAndManagedActions(context) {
  const {
    plan, input, externalById, localById, identities, populationIds, batches, eligibleByBatch,
  } = context;
  const activeAuthority = input.activeAuthority || (input.authoritative ? input.provider : 'none');
  const canManage = input.authoritative === true;
  const reviewedReimport = !canManage && activeAuthority === 'none' && input.trigger === 'manual';
  const alignPeopleType = input.settings?.alignPeopleType !== false;

  for (const identity of identities) {
    const { externalPersonId, individualId } = identity;
    const externalPerson = externalById.get(externalPersonId);
    const localPerson = localById.get(individualId);
    if (!externalPerson || !localPerson) continue;
    const state = normalizeState(externalPerson.state);
    const included = populationIds.has(externalPersonId);
    const changes = managedFieldChanges(externalPerson, localPerson);
    const canReviewedUpdate = reviewedReimport && identity.bucket === 'linked';

    if (identity.bucket !== 'linked' && included) {
      plan.linkPeople.push({
        id: `linkPeople:${externalPersonId}:${individualId}`, externalPersonId, individualId,
        reason: identity.reason || identity.bucket, reviewRequired: identity.reviewRequired,
      });
    }

    if (!canManage && activeAuthority !== 'none') {
      if (changes.length > 0) {
        plan.skipped.push({
          id: `skipped:${externalPersonId}:${individualId}:active_authority_owned`, externalPersonId,
          individualId, reason: 'active_authority_owned', activeAuthority,
        });
      }
      continue;
    }

    if (canManage && isActive(localPerson) && (isTerminalState(state) || !included)) {
      const reason = isTerminalState(state) ? `provider_state_${state}` :
        state === 'contact' && input.settings?.includeContacts === false ? 'contact_excluded' : 'no_longer_eligible';
      plan.archive.push({
        id: `archive:${externalPersonId}:${individualId}`, externalPersonId, individualId,
        reason, missingFullSyncCount: null,
      });
      continue;
    }

    if (!included || isTerminalState(state)) continue;
    if (canManage && !isActive(localPerson)) {
      plan.reactivate.push({
        id: `reactivate:${externalPersonId}:${individualId}`, externalPersonId, individualId,
        reason: 'provider_reappearance',
      });
    }

    if (changes.length > 0 && (canManage || canReviewedUpdate)) {
      plan.updateManagedFields.push({
        id: `updateManagedFields:${externalPersonId}:${individualId}`, externalPersonId, individualId,
        changes, reason: canManage ? 'provider_managed_fields' : 'reviewed_reimport',
        reviewRequired: !canManage,
      });
    }

    if (!alignPeopleType) continue;
    const desired = desiredPeopleType(externalPerson, qualifyingBatchesFor(externalPersonId, batches, eligibleByBatch));
    const current = peopleType(localPerson);
    if (desired === current || (!canManage && !canReviewedUpdate)) continue;
    if (desired === 'regular') {
      plan.promoteToRegular.push({
        id: `promoteToRegular:${externalPersonId}:${individualId}`, externalPersonId, individualId,
        fromPeopleType: current, toPeopleType: 'regular', reason: 'provider_state_active', reviewRequired: !canManage,
      });
    } else if (desired === 'local_visitor') {
      plan.demoteToLocalVisitor.push({
        id: `demoteToLocalVisitor:${externalPersonId}:${individualId}`, externalPersonId, individualId,
        fromPeopleType: current, toPeopleType: 'local_visitor', reason: 'provider_state_contact', reviewRequired: !canManage,
      });
    }
  }
}

function addUnmatchedActions(context) {
  const { plan, input, matcherResult, conflictIds, externalById, populationIds, batches, eligibleByBatch } = context;
  const activeAuthority = input.activeAuthority || (input.authoritative ? input.provider : 'none');
  for (const rawExternalPersonId of matcherResult.unmatchedExternalIds || []) {
    const externalPersonId = stableString(rawExternalPersonId);
    if (conflictIds.has(externalPersonId) || !populationIds.has(externalPersonId)) continue;
    const externalPerson = externalById.get(externalPersonId);
    if (!externalPerson) continue;
    const desired = desiredPeopleType(externalPerson, qualifyingBatchesFor(externalPersonId, batches, eligibleByBatch));
    if (!input.authoritative && desired === 'regular') {
      plan.skipped.push({
        id: `skipped:${externalPersonId}:create_regular_non_authoritative`, externalPersonId,
        reason: 'create_regular_non_authoritative', activeAuthority,
      });
      continue;
    }
    plan.addPeople.push({
      id: `addPeople:${externalPersonId}`, externalPersonId,
      firstName: externalPerson.firstName, lastName: externalPerson.lastName,
      isChild: typeof externalPerson.child === 'boolean' ? externalPerson.child : null,
      familyId: externalPerson.familyId ?? null, peopleType: desired,
      reason: 'eligible_unmatched_external', reviewRequired: true,
    });
  }
}

function addUnmatchedLocalReview(plan, matcherResult, localById) {
  for (const rawIndividualId of matcherResult.unmatchedLocalIds || []) {
    const individualId = Number(rawIndividualId);
    const localPerson = localById.get(individualId);
    if (!localPerson || !isActive(localPerson) || peopleType(localPerson) !== 'regular') continue;
    plan.unmatchedLocalRegulars.push({
      id: `unmatchedLocalRegulars:${individualId}`, individualId,
      reason: 'unmatched_local_regular', reviewRequired: true,
    });
  }
}

function addMissingActions(plan, input) {
  if (!input.authoritative || input.snapshot?.mode !== 'full' || input.snapshot?.complete !== true) return;
  for (const candidate of input.missingCandidates || []) {
    const externalPersonId = stableString(candidate?.externalPersonId);
    const individualId = Number(candidate?.individualId);
    const missingFullSyncCount = Number(candidate?.missingFullSyncCount);
    if (missingFullSyncCount >= 2) {
      if (!actionExists(plan.archive, externalPersonId, individualId)) {
        plan.archive.push({
          id: `archive:${externalPersonId}:${individualId}`, externalPersonId, individualId,
          reason: 'confirmed_missing_full_sync', missingFullSyncCount,
        });
      }
    } else if (missingFullSyncCount > 0) {
      plan.skipped.push({
        id: `skipped:${externalPersonId}:${individualId}:awaiting_missing_confirmation`, externalPersonId,
        individualId, reason: 'awaiting_missing_confirmation', missingFullSyncCount,
      });
    }
  }
}

function membershipBatchId(row) {
  const value = row?.addedBySyncBatchId ?? row?.added_by_sync_batch_id;
  return value === null || value === undefined ? null : Number(value);
}

function addGatheringActions(context) {
  const { plan, batches, eligibleByBatch, populationIds, identities, input } = context;
  const individualByExternal = new Map(identities.map((item) => [item.externalPersonId, item.individualId]));
  for (const addition of plan.addPeople) individualByExternal.set(addition.externalPersonId, null);
  const externalByIndividual = new Map(identities.map((item) => [item.individualId, item.externalPersonId]));
  const memberships = (input.gatheringMemberships || []).map((item) => clone(item));
  const membershipKeys = new Set(memberships.map((row) => `${Number(row.gatheringTypeId)}:${Number(row.individualId)}`));
  const candidates = new Map();

  for (const batch of batches) {
    if (batch.gatheringTypeId === null || batch.gatheringTypeId === undefined) continue;
    const gatheringTypeId = Number(batch.gatheringTypeId);
    if (!Number.isInteger(gatheringTypeId)) continue;
    for (const externalPersonId of eligibleByBatch.get(batch.id) || []) {
      if (!populationIds.has(externalPersonId) || !individualByExternal.has(externalPersonId)) continue;
      const individualId = individualByExternal.get(externalPersonId);
      if (individualId !== null && membershipKeys.has(`${gatheringTypeId}:${individualId}`)) continue;
      const key = `${gatheringTypeId}:${externalPersonId}:${individualId ?? 'new'}`;
      if (!candidates.has(key)) candidates.set(key, { gatheringTypeId, externalPersonId, individualId, batches: [] });
      candidates.get(key).batches.push(batch.id);
    }
  }

  for (const candidate of candidates.values()) {
    const eligibleBatchIds = [...new Set(candidate.batches.map(Number))].sort((a, b) => a - b);
    const batchId = eligibleBatchIds[0];
    const localKey = candidate.individualId === null ? 'new' : candidate.individualId;
    plan.addToGathering.push({
      id: `addToGathering:${batchId}:${candidate.gatheringTypeId}:${candidate.externalPersonId}:${localKey}`,
      batchId, gatheringTypeId: candidate.gatheringTypeId, externalPersonId: candidate.externalPersonId,
      individualId: candidate.individualId, eligibleBatchIds, reason: 'batch_eligible',
    });
  }

  const batchById = new Map(batches.map((item) => [Number(item.id), item]));
  for (const row of memberships) {
    const ownerBatchId = membershipBatchId(row);
    const ownerBatch = batchById.get(ownerBatchId);
    const gatheringTypeId = Number(row.gatheringTypeId);
    const individualId = Number(row.individualId);
    if (!ownerBatch || ownerBatch.gatheringAutoRemoveEnabled !== true || Number(ownerBatch.gatheringTypeId) !== gatheringTypeId) continue;
    const externalPersonId = externalByIndividual.get(individualId);
    const remainsEligible = externalPersonId && batches.some((batch) =>
      Number(batch.gatheringTypeId) === gatheringTypeId &&
      eligibleByBatch.get(batch.id)?.has(externalPersonId) && populationIds.has(externalPersonId));
    if (remainsEligible) continue;
    plan.removeFromGathering.push({
      id: `removeFromGathering:${ownerBatchId}:${gatheringTypeId}:${individualId}`,
      batchId: ownerBatchId, gatheringTypeId, individualId, reason: 'batch_no_longer_eligible',
    });
  }
}

function computePeopleSyncPlan(input = {}) {
  const snapshot = input.snapshot || {};
  const plan = {
    provider: input.provider,
    authoritative: input.authoritative === true,
    snapshot: { fetchedAt: snapshot.fetchedAt ?? null, watermark: snapshot.watermark ?? null, mode: snapshot.mode ?? null },
  };
  for (const bucket of BUCKETS) plan[bucket] = [];

  const externalPeople = normalizedExternalPeople(input.externalPeople || []);
  const localPeople = normalizedLocalPeople(input.localPeople || []);
  const externalById = new Map(externalPeople.map((item) => [stableString(item.id), item]));
  const localById = new Map(localPeople.map((item) => [Number(item.id), item]));
  const matcherResult = input.matcher || {};
  plan.ambiguousPeople = buildAmbiguousPeople(matcherResult);
  plan.familyConflicts = (input.familyConflicts || []).map(clone).sort((a, b) => canonicalString(a).localeCompare(canonicalString(b), 'en'));
  const conflictIds = new Set(plan.ambiguousPeople.map((item) => item.externalPersonId));
  const identities = identityRows(matcherResult, conflictIds);
  const { batches, eligibleByBatch, eligibleUnion } = buildEligibility(input);
  const populationIds = new Set();
  for (const externalPersonId of eligibleUnion) {
    const externalPerson = externalById.get(externalPersonId);
    if (!externalPerson || isTerminalState(normalizeState(externalPerson.state))) continue;
    if (normalizeState(externalPerson.state) === 'contact' && input.settings?.includeContacts === false) continue;
    populationIds.add(externalPersonId);
  }

  const context = {
    plan, input, matcherResult, conflictIds, externalById, localById, identities,
    populationIds, batches, eligibleByBatch,
  };
  addLifecycleAndManagedActions(context);
  addUnmatchedActions(context);
  addUnmatchedLocalReview(plan, matcherResult, localById);
  addMissingActions(plan, input);
  addGatheringActions(context);

  for (const bucket of BUCKETS) {
    plan[bucket] = uniqueBy(plan[bucket], (item) => item?.id ?? canonicalString(item)).sort(compareById);
  }
  return plan;
}

function summarizePlan(plan) {
  return Object.fromEntries(BUCKETS.map((bucket) => [bucket, Array.isArray(plan?.[bucket]) ? plan[bucket].length : 0]));
}

module.exports = { BUCKETS, computePeopleSyncPlan, summarizePlan };
