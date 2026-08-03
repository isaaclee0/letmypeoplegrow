const BUCKETS = [
  'linkPeople', 'linkFamilies', 'addPeople', 'addFamilies', 'updateManagedFields',
  'promoteToRegular', 'demoteToLocalVisitor', 'archive', 'reactivate', 'moveFamily',
  'renameFamily', 'addToGathering', 'removeFromGathering', 'ambiguousPeople',
  'familyConflicts', 'unmatchedLocalRegulars', 'skipped',
];

function stableString(value) {
  return String(value ?? '');
}

function externalId(value, label = 'External person ID') {
  if (typeof value === 'number') return stableString(positiveInteger(value, label));
  const normalized = stableString(value);
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function positiveInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a safe positive integer`);
  }
  return value;
}

function actionId(bucket, ...parts) {
  return [bucket, ...parts.map((part) => encodeURIComponent(stableString(part)))].join(':');
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
  const validated = (people || []).map((item) => ({ ...item, id: externalId(item?.id) }));
  return uniqueBy(validated, (item) => item.id)
    .map((item) => clone(item))
    .sort((a, b) => stableString(a.id).localeCompare(stableString(b.id), 'en'));
}

function normalizedLocalPeople(people) {
  const validated = (people || []).map((item) => ({
    ...item, id: positiveInteger(item?.id, 'Local person ID'),
  }));
  return uniqueBy(validated, (item) => item.id)
    .map((item) => clone(item))
    .sort((a, b) => a.id - b.id);
}

function idsFrom(value) {
  const values = value instanceof Set ? [...value] : Array.isArray(value) ? value : [];
  return new Set(values.map((item) => externalId(item, 'Eligible external person ID')));
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
    .map((item) => {
      const normalized = { ...clone(item), id: positiveInteger(item?.id, 'Batch ID') };
      if (normalized.gatheringTypeId !== null && normalized.gatheringTypeId !== undefined) {
        normalized.gatheringTypeId = positiveInteger(normalized.gatheringTypeId, 'Gathering type ID');
      }
      return normalized;
    })
    .sort((a, b) => a.id - b.id);
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

function sortLocalIds(values, label = 'Candidate individual ID') {
  return [...(values || [])]
    .map((value) => positiveInteger(value, label))
    .sort((a, b) => a - b);
}

function buildAmbiguousPeople(matcherResult) {
  return (matcherResult?.ambiguous || []).map((conflict) => {
    const externalPersonId = externalId(conflict?.externalPersonId);
    const reason = stableString(conflict?.reason || 'ambiguous');
    const action = { id: actionId('ambiguousPeople', externalPersonId, reason), ...clone(conflict), externalPersonId };
    if (Array.isArray(conflict?.candidateIndividualIds)) {
      action.candidateIndividualIds = sortLocalIds(conflict.candidateIndividualIds);
    }
    if (Array.isArray(conflict?.staleLinkedIndividualIds)) {
      action.staleLinkedIndividualIds = sortLocalIds(conflict.staleLinkedIndividualIds, 'Stale linked individual ID');
    }
    return action;
  }).sort(compareById);
}

function collectIdentityRows(matcherResult) {
  const rows = [];
  const add = (bucket, reviewRequired) => {
    for (const match of matcherResult?.[bucket] || []) {
      const externalPersonId = externalId(match?.externalPersonId);
      const individualId = positiveInteger(match?.individualId, 'Matcher individual ID');
      rows.push({ ...clone(match), externalPersonId, individualId, bucket, reviewRequired });
    }
  };
  add('linked', false);
  add('matches', false);
  add('visitorMatches', true);
  add('archivedMatches', true);
  rows.sort((a, b) => a.externalPersonId.localeCompare(b.externalPersonId, 'en') || a.individualId - b.individualId);
  return uniqueBy(rows, (row) => `${row.externalPersonId}\u0000${row.individualId}\u0000${row.bucket}`);
}

function buildIdentityConflicts(rows) {
  const byExternal = new Map();
  for (const row of rows) {
    if (!byExternal.has(row.externalPersonId)) byExternal.set(row.externalPersonId, []);
    byExternal.get(row.externalPersonId).push(row);
  }
  const ambiguousPeople = [];
  const protectedIndividualIds = new Set();
  for (const [externalPersonId, matches] of byExternal) {
    if (matches.length <= 1) continue;
    const candidateIndividualIds = [...new Set(matches.map((item) => item.individualId))].sort((a, b) => a - b);
    const matcherBuckets = [...new Set(matches.map((item) => item.bucket))].sort();
    ambiguousPeople.push({
      id: actionId('ambiguousPeople', externalPersonId, 'conflicting_matcher_identity'),
      externalPersonId, candidateIndividualIds, matcherBuckets, reason: 'conflicting_matcher_identity',
    });
    for (const individualId of candidateIndividualIds) protectedIndividualIds.add(individualId);
  }
  return { ambiguousPeople: ambiguousPeople.sort(compareById), protectedIndividualIds };
}

function unambiguousIdentityRows(rows, conflictIds) {
  return rows.filter((row) => !conflictIds.has(row.externalPersonId));
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

    if (identity.bucket !== 'linked') {
      plan.linkPeople.push({
        id: actionId('linkPeople', externalPersonId, individualId), externalPersonId, individualId,
        reason: identity.reason || identity.bucket, reviewRequired: identity.reviewRequired,
      });
    }

    // Review-only identity suggestions are not established links. Task 7 must first
    // accept the linkPeople selection and regenerate before dependent mutations exist.
    if (identity.reviewRequired) continue;

    if (!canManage && activeAuthority !== 'none') {
      if (changes.length > 0) {
        plan.skipped.push({
          id: actionId('skipped', externalPersonId, individualId, 'active_authority_owned'), externalPersonId,
          individualId, reason: 'active_authority_owned', activeAuthority,
        });
      }
      continue;
    }

    if (canManage && isActive(localPerson) && isTerminalState(state)) {
      plan.archive.push({
        id: actionId('archive', externalPersonId, individualId), externalPersonId, individualId,
        reason: `provider_state_${state}`,
      });
      continue;
    }

    if (!included || isTerminalState(state)) continue;
    if (canManage && !isActive(localPerson)) {
      plan.reactivate.push({
        id: actionId('reactivate', externalPersonId, individualId), externalPersonId, individualId,
        reason: 'provider_reappearance',
      });
    }

    if (changes.length > 0 && (canManage || canReviewedUpdate)) {
      plan.updateManagedFields.push({
        id: actionId('updateManagedFields', externalPersonId, individualId), externalPersonId, individualId,
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
        id: actionId('promoteToRegular', externalPersonId, individualId), externalPersonId, individualId,
        fromPeopleType: current, toPeopleType: 'regular', reason: 'provider_state_active', reviewRequired: !canManage,
      });
    } else if (desired === 'local_visitor') {
      plan.demoteToLocalVisitor.push({
        id: actionId('demoteToLocalVisitor', externalPersonId, individualId), externalPersonId, individualId,
        fromPeopleType: current, toPeopleType: 'local_visitor', reason: 'provider_state_contact', reviewRequired: !canManage,
      });
    }
  }
}

function addUnmatchedActions(context) {
  const { plan, input, matcherResult, conflictIds, externalById, populationIds, batches, eligibleByBatch } = context;
  const activeAuthority = input.activeAuthority || (input.authoritative ? input.provider : 'none');
  for (const rawExternalPersonId of matcherResult.unmatchedExternalIds || []) {
    const externalPersonId = externalId(rawExternalPersonId);
    if (conflictIds.has(externalPersonId) || !populationIds.has(externalPersonId)) continue;
    const externalPerson = externalById.get(externalPersonId);
    if (!externalPerson) continue;
    const desired = desiredPeopleType(externalPerson, qualifyingBatchesFor(externalPersonId, batches, eligibleByBatch));
    if (!input.authoritative && desired === 'regular') {
      plan.skipped.push({
        id: actionId('skipped', externalPersonId, 'create_regular_non_authoritative'), externalPersonId,
        reason: 'create_regular_non_authoritative', activeAuthority,
      });
      continue;
    }
    plan.addPeople.push({
      id: actionId('addPeople', externalPersonId), externalPersonId,
      firstName: externalPerson.firstName, lastName: externalPerson.lastName,
      isChild: typeof externalPerson.child === 'boolean' ? externalPerson.child : null,
      familyId: externalPerson.familyId ?? null, peopleType: desired,
      reason: 'eligible_unmatched_external', reviewRequired: true,
    });
  }
}

function membershipBatchId(row) {
  const value = row?.addedBySyncBatchId ?? row?.added_by_sync_batch_id;
  return value === null || value === undefined ? null : positiveInteger(value, 'Roster provenance batch ID');
}

function addGatheringActions(context) {
  const { plan, batches, eligibleByBatch, populationIds, identities, protectedIndividualIds, input } = context;
  const completeFullSnapshot = input.snapshot?.mode === 'full' && input.snapshot?.complete === true;
  const actionableIdentities = identities.filter((item) => !item.reviewRequired);
  const individualByExternal = new Map(actionableIdentities.map((item) => [item.externalPersonId, item.individualId]));
  for (const addition of plan.addPeople) individualByExternal.set(addition.externalPersonId, null);
  const externalByIndividual = new Map(actionableIdentities.map((item) => [item.individualId, item.externalPersonId]));
  const memberships = (input.gatheringMemberships || []).map((item) => ({
    ...clone(item),
    gatheringTypeId: positiveInteger(item?.gatheringTypeId, 'Roster gathering type ID'),
    individualId: positiveInteger(item?.individualId, 'Roster individual ID'),
  }));
  const membershipKeys = new Set(memberships.map((row) => `${row.gatheringTypeId}:${row.individualId}`));
  const candidates = new Map();

  for (const batch of batches) {
    if (batch.gatheringTypeId === null || batch.gatheringTypeId === undefined) continue;
    const gatheringTypeId = batch.gatheringTypeId;
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
    const eligibleBatchIds = [...new Set(candidate.batches)].sort((a, b) => a - b);
    const batchId = eligibleBatchIds[0];
    const localKey = candidate.individualId === null ? 'new' : candidate.individualId;
    plan.addToGathering.push({
      id: actionId('addToGathering', batchId, candidate.gatheringTypeId, candidate.externalPersonId, localKey),
      batchId, gatheringTypeId: candidate.gatheringTypeId, externalPersonId: candidate.externalPersonId,
      individualId: candidate.individualId, eligibleBatchIds, reason: 'batch_eligible',
    });
  }

  const batchById = new Map(batches.map((item) => [item.id, item]));
  for (const row of memberships) {
    const ownerBatchId = membershipBatchId(row);
    const ownerBatch = batchById.get(ownerBatchId);
    const gatheringTypeId = row.gatheringTypeId;
    const individualId = row.individualId;
    if (!ownerBatch || ownerBatch.gatheringAutoRemoveEnabled !== true || ownerBatch.gatheringTypeId !== gatheringTypeId) continue;
    if (protectedIndividualIds.has(individualId)) continue;
    const externalPersonId = externalByIndividual.get(individualId);
    if (!completeFullSnapshot && !externalPersonId) continue;
    const remainsEligible = externalPersonId && batches.some((batch) =>
      batch.gatheringTypeId === gatheringTypeId &&
      eligibleByBatch.get(batch.id)?.has(externalPersonId) && populationIds.has(externalPersonId));
    if (remainsEligible) continue;
    plan.removeFromGathering.push({
      id: actionId('removeFromGathering', ownerBatchId, gatheringTypeId, individualId),
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
  const externalById = new Map(externalPeople.map((item) => [item.id, item]));
  const localById = new Map(localPeople.map((item) => [item.id, item]));
  const matcherResult = input.matcher || {};
  const allIdentityRows = collectIdentityRows(matcherResult);
  const identityConflicts = buildIdentityConflicts(allIdentityRows);
  plan.ambiguousPeople = [...buildAmbiguousPeople(matcherResult), ...identityConflicts.ambiguousPeople];
  plan.familyConflicts = (input.familyConflicts || []).map(clone).sort((a, b) => canonicalString(a).localeCompare(canonicalString(b), 'en'));
  const conflictIds = new Set(plan.ambiguousPeople.map((item) => item.externalPersonId));
  const protectedIndividualIds = new Set(identityConflicts.protectedIndividualIds);
  for (const ambiguity of plan.ambiguousPeople) {
    for (const individualId of ambiguity.candidateIndividualIds || []) protectedIndividualIds.add(individualId);
    for (const individualId of ambiguity.staleLinkedIndividualIds || []) protectedIndividualIds.add(individualId);
  }
  for (const identity of allIdentityRows) if (identity.reviewRequired) protectedIndividualIds.add(identity.individualId);
  const identities = unambiguousIdentityRows(allIdentityRows, conflictIds);
  const { batches, eligibleByBatch, eligibleUnion } = buildEligibility(input);
  plan.presenceProjection = { completeFullSnapshot: false, updates: [] };
  const populationIds = new Set();
  for (const externalPersonId of eligibleUnion) {
    const externalPerson = externalById.get(externalPersonId);
    if (!externalPerson || isTerminalState(normalizeState(externalPerson.state))) continue;
    if (normalizeState(externalPerson.state) === 'contact' && input.settings?.includeContacts === false) continue;
    populationIds.add(externalPersonId);
  }

  const context = {
    plan, input, matcherResult, conflictIds, externalById, localById, identities,
    protectedIndividualIds, populationIds, batches, eligibleByBatch,
  };
  addLifecycleAndManagedActions(context);
  addUnmatchedActions(context);
  addGatheringActions(context);

  for (const bucket of BUCKETS) {
    plan[bucket] = uniqueBy(plan[bucket], (item) => item?.id ?? canonicalString(item)).sort(compareById);
  }
  return plan;
}

function summarizePlan(plan) {
  return Object.fromEntries(BUCKETS.map((bucket) => [bucket, Array.isArray(plan?.[bucket]) ? plan[bucket].length : 0]));
}

module.exports = { BUCKETS, computePeopleSyncPlan, summarizePlan, desiredPeopleType };
