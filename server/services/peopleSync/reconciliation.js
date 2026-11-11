'use strict';

const { buildFamilyName, buildSinglePersonFamilyName, hasConfirmedNoHousehold } = require('./familyName');
const crypto = require('node:crypto');

const actionId = (...parts) => parts.map((part) => encodeURIComponent(String(part ?? ''))).join(':');
const completeAuthority = (input) => input.authoritative === true &&
  input.snapshot?.mode === 'full' && input.snapshot?.complete === true;

const keepFingerprint = (facts) => crypto.createHash('sha256').update(JSON.stringify(facts)).digest('hex');
const sortedMoves = (moves) => (moves || []).map((move) => ({
  externalPersonId: String(move.externalPersonId),
  individualId: Number(move.individualId),
  fromFamilyId: move.fromFamilyId ?? null,
})).sort((a, b) => a.externalPersonId.localeCompare(b.externalPersonId, 'en') || a.individualId - b.individualId);

// What a "keep LMPG as it is" decision is about (kind + subject) and the facts
// it was made against (fingerprint). A keep only hides a difference while
// both still match, so any change on either side brings it back for review.
// The household name is deliberately not part of the facts.
function reconciliationKeepFor(bucket, action) {
  if (bucket === 'familyConflicts') {
    const resolution = action?.resolution;
    if (!resolution || !Array.isArray(resolution.moves) || !resolution.moves.length) return null;
    if (resolution.kind === 'detach' || resolution.kind === 'single_person') {
      return {
        kind: 'household',
        subjectKey: `person:${resolution.moves[0].externalPersonId}`,
        fingerprint: keepFingerprint({ kind: resolution.kind, moves: sortedMoves(resolution.moves) }),
      };
    }
    if (resolution.kind === 'household' && action.externalFamilyId != null) {
      const destination = resolution.destination;
      if (!destination || !['existing', 'create'].includes(destination.kind)) return null;
      return {
        kind: 'household',
        subjectKey: `household:${action.externalFamilyId}`,
        fingerprint: keepFingerprint({
          kind: 'household',
          destination: destination.kind === 'existing'
            ? { kind: 'existing', familyId: destination.familyId } : { kind: 'create' },
          members: [...(action.memberExternalIds || [])].map(String).sort(),
          moves: sortedMoves(resolution.moves),
        }),
      };
    }
    return null;
  }
  if (bucket === 'removeFromGathering' && action?.reviewRequired === true) {
    if (!action.sourceIdentities?.length) return null;
    return {
      kind: 'gathering_removal',
      subjectKey: `${action.gatheringTypeId}:${action.individualId}`,
      fingerprint: keepFingerprint({
        externalPersonId: String(action.externalPersonId ?? ''),
        sources: action.sourceIdentities.map(({ batchId, kind, externalId }) => ({ batchId, kind, externalId }))
          .sort((a, b) => a.batchId - b.batchId),
      }),
    };
  }
  return null;
}

// Returns true when the difference was kept (and records it on the plan
// instead of offering it for review).
function honourKeep(input, plan, bucket, action) {
  const keeps = input.reconciliationKeeps;
  if (!Array.isArray(keeps) || !keeps.length) return false;
  const key = reconciliationKeepFor(bucket, action);
  if (!key) return false;
  const keep = keeps.find((entry) => entry.kind === key.kind && entry.subjectKey === key.subjectKey && entry.fingerprint === key.fingerprint);
  if (!keep) return false;
  plan.keptReconciliations = plan.keptReconciliations || [];
  plan.keptReconciliations.push({ keepId: keep.id, kind: keep.kind, subjectKey: keep.subjectKey, keptAt: keep.keptAt ?? null, bucket, action });
  return true;
}

// Corrections require durable, one-to-one links. A suggested match is never
// sufficient, even if an unattended run would otherwise accept that suggestion.
function establishedIdentities(input, protectedIndividualIds, conflictIds) {
  const byExternal = new Map();
  const byIndividual = new Map();
  for (const link of input.personLinks || []) {
    const externalPersonId = String(link.externalPersonId);
    if (!byExternal.has(externalPersonId)) byExternal.set(externalPersonId, new Set());
    if (!byIndividual.has(link.individualId)) byIndividual.set(link.individualId, new Set());
    byExternal.get(externalPersonId).add(link.individualId);
    byIndividual.get(link.individualId).add(externalPersonId);
  }
  const result = new Map();
  for (const [externalPersonId, individualIds] of byExternal) {
    const individualId = [...individualIds][0];
    if (individualIds.size !== 1 || byIndividual.get(individualId).size !== 1 ||
        conflictIds.has(externalPersonId) || protectedIndividualIds.has(individualId)) continue;
    result.set(externalPersonId, individualId);
  }
  return result;
}

function addReviewedFamilyActions(context) {
  const { input, plan, externalById, localById, populationIds, protectedIndividualIds, conflictIds, localHouseholdExternalIds } = context;
  if (!completeAuthority(input)) return;
  const established = establishedIdentities(input, protectedIndividualIds, conflictIds);
  const localFamilies = new Map((input.localFamilies || []).map((family) => [family.id, family]));
  const families = (input.externalFamilies || []).map((family) => ({
    ...family,
    memberExternalIds: (family.memberExternalIds || []).map(String).filter((id) => !localHouseholdExternalIds.has(id)),
  })).sort((a, b) => String(a.id).localeCompare(String(b.id), 'en'));
  const familyLinks = input.familyLinks || [];
  const householdPeople = new Map((input.householdPeople || []).map((person) => [String(person.id), person]));
  const personFor = (id) => externalById.get(id) || householdPeople.get(id);
  const linkedIdsByLocalFamily = new Map();
  const linkedExternalIds = new Set();
  for (const { externalPersonId, individualId } of input.personLinks || []) {
    const id = String(externalPersonId);
    linkedExternalIds.add(id);
    // A managed resident cannot corroborate provider household ownership.
    // They remain in localById so exact-family checks still protect them.
    if (localHouseholdExternalIds.has(id)) continue;
    const familyId = localById.get(individualId)?.familyId;
    if (familyId == null) continue;
    if (!linkedIdsByLocalFamily.has(familyId)) linkedIdsByLocalFamily.set(familyId, new Set());
    linkedIdsByLocalFamily.get(familyId).add(id);
  }
  const newPersonFamily = new Map(plan.addPeople
    .filter((action) => action.familyId != null && !linkedExternalIds.has(action.externalPersonId))
    .map((action) => [action.externalPersonId, String(action.familyId)]));
  const householdMembership = new Map();
  for (const family of families) for (const id of family.memberExternalIds || []) {
    if (!householdMembership.has(String(id))) householdMembership.set(String(id), new Set());
    householdMembership.get(String(id)).add(String(family.id));
  }

  for (const family of families) {
    const externalFamilyId = String(family.id);
    const members = [...new Set((family.memberExternalIds || []).map(String))].sort();
    const inScopeIds = members.filter((id) => populationIds.has(id));
    if (!inScopeIds.length || !inScopeIds.some((id) => established.has(id))) continue;
    const moves = inScopeIds.filter((id) => established.has(id) && localById.has(established.get(id))).map((id) => ({
      externalPersonId: id, individualId: established.get(id), fromFamilyId: localById.get(established.get(id)).familyId ?? null,
    }));
    const candidates = [...new Set(moves.map((move) => move.fromFamilyId).filter((id) => id !== null))].sort((a, b) => a - b);
    const linked = familyLinks.filter((link) => String(link.externalFamilyId) === externalFamilyId);
    const linkedFamily = linked.length === 1 ? localFamilies.get(linked[0].familyId) : null;
    // A linked relative outside this source can corroborate a candidate
    // family's membership, but never goes into the list of moves above.
    const residents = !linked.length && candidates.length === 1 ? linkedIdsByLocalFamily.get(candidates[0]) : null;
    const evidenceIds = [...new Set([...inScopeIds, ...(residents || [])])];
    const unresolved = evidenceIds.filter((id) => !established.has(id) || !localById.has(established.get(id))).sort();
    const unknownHousehold = evidenceIds.some((id) => !Array.isArray(personFor(id)?.householdIds));
    const conflictingHousehold = evidenceIds.some((id) => {
      const person = personFor(id);
      const ids = person?.householdIds;
      if (!Array.isArray(ids)) return false;
      const memberships = householdMembership.get(id);
      return ids.length > 1 || ids.length !== (memberships?.size || 0) ||
        (ids.length === 1 && !memberships.has(String(ids[0]))) ||
        (person.familyId !== undefined && String(person.familyId ?? '') !== String(ids[0] ?? ''));
    });
    const conflictingOwnership = linked.length > 1 || (linked.length === 1 && (!linkedFamily || familyLinks.some((link) =>
      link.familyId === linkedFamily.id && String(link.externalFamilyId) !== externalFamilyId))) ||
      (input.provider === 'planning_center' && linkedFamily?.planningCenterId && String(linkedFamily.planningCenterId) !== externalFamilyId);
    // Reusing an unlinked local family that contains unrelated people would
    // claim their household too. Split the known source members into a new
    // family instead, leaving all unrelated people and old family rows alone.
    const soleFamily = candidates.length === 1 ? localFamilies.get(candidates[0]) : null;
    const memberIndividualIds = new Set(members.map((id) => established.get(id)));
    const soleFamilyIsExact = soleFamily && [...localById.values()].every((person) =>
      person.familyId !== soleFamily.id || memberIndividualIds.has(person.id));
    const soleFamilyOwnedElsewhere = soleFamily && (familyLinks.some((link) =>
      link.familyId === soleFamily.id && String(link.externalFamilyId) !== externalFamilyId) ||
      (input.provider === 'planning_center' && soleFamily.planningCenterId && String(soleFamily.planningCenterId) !== externalFamilyId));
    const destinationFamily = linkedFamily || (soleFamilyIsExact && !soleFamilyOwnedElsewhere ? soleFamily : null);
    const differentMembers = destinationFamily ? moves.filter((move) => move.fromFamilyId !== destinationFamily.id) : moves;
    const familiesBeingLeft = new Set(differentMembers.map((move) => move.fromFamilyId).filter((id) => id != null));
    const separatesExcludedRelative = members.some((id) => !populationIds.has(id) &&
      familiesBeingLeft.has(localById.get(established.get(id))?.familyId));
    const previousConflict = plan.familyConflicts.find((action) => action.externalFamilyId === externalFamilyId);
    if (destinationFamily && !differentMembers.length && unresolved.every((id) => newPersonFamily.get(id) === externalFamilyId) &&
        !unknownHousehold && !conflictingHousehold && !conflictingOwnership) {
      // The established people already justify this family link. A new
      // person's signed creation can use it without moving any local person.
      plan.familyConflicts = plan.familyConflicts.filter((entry) => entry.externalFamilyId !== externalFamilyId);
      if (!linked.length) {
        plan.linkFamilies = plan.linkFamilies.filter((entry) => entry.externalFamilyId !== externalFamilyId);
        plan.linkFamilies.push({
          id: actionId('linkFamilies', externalFamilyId, destinationFamily.id),
          externalFamilyId, familyId: destinationFamily.id,
          memberExternalIds: inScopeIds, reason: 'household_member_family',
        });
      }
      continue;
    }

    let reason = previousConflict?.reason || 'household_membership_mismatch';
    if (unresolved.length) reason = 'unresolved_household_members';
    else if (unknownHousehold) reason = 'unknown_household_membership';
    else if (conflictingHousehold) reason = 'multiple_provider_households';
    else if (conflictingOwnership) reason = 'conflicting_family_ownership';
    else if (separatesExcludedRelative) reason = 'household_member_outside_source';
    const action = {
      id: previousConflict?.id || actionId('familyConflicts', externalFamilyId, reason),
      externalFamilyId,
      externalFamilyName: family.name || family.familyName || null,
      memberExternalIds: members,
      candidateFamilyIds: candidates,
      unresolvedExternalPersonIds: unresolved,
      reason,
    };
    if (!unresolved.length && !unknownHousehold && !conflictingHousehold && !conflictingOwnership &&
        !separatesExcludedRelative && differentMembers.length) {
      const familyName = String(family.name || family.familyName || buildFamilyName(inScopeIds.map((id) => externalById.get(id))) || '').trim();
      if (destinationFamily || familyName) {
        action.resolution = {
          kind: 'household',
          destination: destinationFamily
            ? { kind: 'existing', familyId: destinationFamily.id, familyName: destinationFamily.familyName }
            : { kind: 'create', familyName },
          moves: differentMembers,
        };
      }
    }
    plan.familyConflicts = plan.familyConflicts.filter((entry) => entry.externalFamilyId !== externalFamilyId);
    if (!action.resolution || !honourKeep(input, plan, 'familyConflicts', action)) plan.familyConflicts.push(action);
    plan.linkFamilies = plan.linkFamilies.filter((entry) => entry.externalFamilyId !== externalFamilyId);
    plan.addFamilies = plan.addFamilies.filter((entry) => entry.externalFamilyId !== externalFamilyId);
  }

  for (const [externalPersonId, individualId] of established) {
    if (!populationIds.has(externalPersonId) || localHouseholdExternalIds.has(externalPersonId)) continue;
    const person = externalById.get(externalPersonId);
    const local = localById.get(individualId);
    if (!local || !hasConfirmedNoHousehold(person, input.externalFamilies)) continue;
    const singlePerson = input.provider === 'planning_center';
    if (!singlePerson && local.familyId == null) continue;
    const currentFamily = localFamilies.get(local.familyId);
    // An existing local singleton already represents this person. Keeping it
    // preserves a custom display name without installing a placement override.
    if (singlePerson && currentFamily && !currentFamily.planningCenterId &&
        !familyLinks.some(link => link.familyId === currentFamily.id) &&
        [...localById.values()].every(resident => resident.familyId !== currentFamily.id || resident.id === individualId)) continue;
    const familyName = singlePerson ? buildSinglePersonFamilyName(person) : null;
    if (singlePerson && !familyName) continue;
    const detach = {
      id: actionId('familyConflicts', singlePerson ? 'single_person' : 'detach', externalPersonId),
      externalFamilyId: null, memberExternalIds: [externalPersonId], candidateFamilyIds: local.familyId == null ? [] : [local.familyId],
      unresolvedExternalPersonIds: [], reason: 'provider_has_no_household',
      resolution: { kind: singlePerson ? 'single_person' : 'detach',
        destination: singlePerson ? { kind: 'create', familyName } : { kind: 'none' }, moves: [
        { externalPersonId, individualId, fromFamilyId: local.familyId ?? null },
      ] },
    };
    if (!honourKeep(input, plan, 'familyConflicts', detach)) plan.familyConflicts.push(detach);
  }

  if (input.provider === 'planning_center') for (const action of plan.addPeople) {
    const person = externalById.get(action.externalPersonId);
    if (localHouseholdExternalIds.has(action.externalPersonId) || !hasConfirmedNoHousehold(person, input.externalFamilies)) continue;
    const familyName = buildSinglePersonFamilyName(person);
    if (!familyName) continue;
    plan.addFamilies.push({
      id: actionId('addFamilies', 'single_person', action.externalPersonId), externalFamilyId: null,
      singlePersonExternalId: action.externalPersonId, familyName,
      memberExternalIds: [action.externalPersonId], reason: 'provider_has_no_household',
    });
  }
}

function addReviewedGatheringRemovals(context) {
  const { input, plan, localById, protectedIndividualIds, conflictIds } = context;
  if (!completeAuthority(input) || !(input.memberIdsByBatch instanceof Map)) return;
  const established = establishedIdentities(input, protectedIndividualIds, conflictIds);
  const externalByIndividual = new Map([...established].map(([external, individual]) => [individual, external]));
  const allBatches = input.allBatches || input.batches || [];
  const readSources = new Map((input.batches || []).map((batch) => [batch.id, batch.effectiveSource ?? batch.source]));
  for (const row of input.gatheringMemberships || []) {
    if ((row.addedBySyncBatchId ?? row.added_by_sync_batch_id) != null ||
        (row.addedByPcoBatchId ?? row.added_by_pco_batch_id) != null || row.hasOtherProviderSources) continue;
    const externalPersonId = externalByIndividual.get(row.individualId);
    if (!externalPersonId || !localById.has(row.individualId)) continue;
    const batches = allBatches.filter((batch) => batch.gatheringTypeId === row.gatheringTypeId).sort((a, b) => a.id - b.id);
    if (!batches.length || batches.some((batch) => {
      const members = input.memberIdsByBatch.get(batch.id);
      const source = readSources.get(batch.id);
      return batch.enabled === false || !source?.kind || !source.externalId ||
        !(members instanceof Set) || members.has(externalPersonId);
    })) continue;
    const removal = {
      id: actionId('removeFromGathering', 'legacy', row.gatheringTypeId, row.individualId),
      batchId: null, gatheringTypeId: row.gatheringTypeId, individualId: row.individualId,
      externalPersonId, sourceBatchIds: batches.map((batch) => batch.id),
      sourceIdentities: batches.map(({ id }) => {
        const { kind, externalId } = readSources.get(id);
        return { batchId: id, kind, externalId };
      }),
      gatheringName: row.gatheringName || null,
      sourceNames: [...new Set(batches.map((batch) => readSources.get(batch.id).name || batch.name).filter(Boolean))].sort(),
      reviewRequired: true, reason: 'legacy_roster_not_in_source',
    };
    if (!honourKeep(input, plan, 'removeFromGathering', removal)) plan.removeFromGathering.push(removal);
  }
}

module.exports = { addReviewedFamilyActions, addReviewedGatheringRemovals, reconciliationKeepFor };
