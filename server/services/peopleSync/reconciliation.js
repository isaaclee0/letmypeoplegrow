'use strict';

const { buildFamilyName, buildSinglePersonFamilyName, hasConfirmedNoHousehold } = require('./familyName');
const crypto = require('node:crypto');
const { validHouseholdRoster } = require('./linkedPlanningCenter');

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
  const residentsByFamily = new Map();
  for (const person of localById.values()) {
    if (person.familyId == null) continue;
    if (!residentsByFamily.has(person.familyId)) residentsByFamily.set(person.familyId, []);
    residentsByFamily.get(person.familyId).push(person.id);
  }
  const families = (input.externalFamilies || []).map((family) => ({
    ...family,
    providerMemberIds: family.memberExternalIds,
    memberExternalIds: (family.memberExternalIds || []).map(String).filter((id) => !localHouseholdExternalIds.has(id)),
  })).sort((a, b) => String(a.id).localeCompare(String(b.id), 'en'));
  const familyLinks = input.familyLinks || [];
  const ownership = familyId => ({ familyId, compatibilityId: localFamilies.get(familyId)?.planningCenterId || null,
    externalIds: familyLinks.filter(link => link.familyId === familyId).map(link => String(link.externalFamilyId)).sort() });
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

  // The Person relationship establishes membership. The inverse Household
  // roster can veto an inference when it omits someone or claims them twice.
  const rosterOwners = new Map();
  for (const family of families) {
    for (const id of family.householdMemberExternalIds || []) {
      if (!rosterOwners.has(id)) rosterOwners.set(id, new Set());
      rosterOwners.get(id).add(String(family.id));
    }
  }
  function reciprocalRoster(family, allowUnknownOutsideScope = false) {
    const roster = family.householdMemberExternalIds;
    if (family.incompleteRoster || !validHouseholdRoster(roster)) return false;
    const listed = new Set(roster);
    return (family.providerMemberIds || []).every(id => !input.householdVetoIds?.has(id) && listed.has(id)) &&
      roster.every(id => {
        if (rosterOwners.get(id)?.size !== 1 || input.householdVetoIds?.has(id)) return false;
        const ids = personFor(id)?.householdIds;
        // Included relatives often omit Person.households. That unknown is
        // harmless only when checking an existing placement, never a move,
        // rename or new family link. Explicit contradictions still veto it.
        if (allowUnknownOutsideScope && ids == null && !populationIds.has(id) && !linkedExternalIds.has(id)) return true;
        return Array.isArray(ids) && ids.length === 1 && String(ids[0]) === String(family.id);
      });
  }
  const familyMembers = (family) => [...new Set([...(family.providerMemberIds || []), ...(family.householdMemberExternalIds || [])].map(String))];
  const unchangedIdentity = id => established.has(id) && input.automaticLinks?.get(id) === established.get(id);
  const automaticallyPlaceable = (id, familyId) => {
    const person = personFor(id);
    return unchangedIdentity(id) && !localHouseholdExternalIds.has(id) && !input.savedHouseholdExternalIds?.has(id) &&
      person?.state === 'active' && Array.isArray(person.householdIds) && person.householdIds.length === 1 &&
      String(person.householdIds[0]) === familyId && String(person.familyId) === familyId &&
      householdMembership.get(id)?.size === 1;
  };

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
    const conflictingFamilyLinks = linked.length > 1 || (linked.length === 1 && (!linkedFamily || familyLinks.some((link) =>
      link.familyId === linkedFamily.id && String(link.externalFamilyId) !== externalFamilyId))) ||
      (input.provider === 'planning_center' && linkedFamily?.planningCenterId && String(linkedFamily.planningCenterId) !== externalFamilyId);
    // Reusing an unlinked local family that contains unrelated people would
    // claim their household too. Split the known source members into a new
    // family instead, leaving all unrelated people and old family rows alone.
    const soleFamily = candidates.length === 1 ? localFamilies.get(candidates[0]) : null;
    const memberIndividualIds = new Set(members.map((id) => established.get(id)));
    const soleFamilyIsExact = soleFamily && (residentsByFamily.get(soleFamily.id) || []).every(id => memberIndividualIds.has(id));
    const soleFamilyOwnedElsewhere = soleFamily && (familyLinks.some((link) =>
      link.familyId === soleFamily.id && String(link.externalFamilyId) !== externalFamilyId) ||
      (input.provider === 'planning_center' && soleFamily.planningCenterId && String(soleFamily.planningCenterId) !== externalFamilyId));
    const destinationFamily = linkedFamily || (soleFamilyIsExact && !soleFamilyOwnedElsewhere ? soleFamily : null);
    const conflictingOwnership = conflictingFamilyLinks || (input.automaticLinks &&
      [...localFamilies.values()].some(local => local.planningCenterId === externalFamilyId && local.id !== destinationFamily?.id));
    const differentMembers = destinationFamily ? moves.filter((move) => move.fromFamilyId !== destinationFamily.id) : moves;
    const familiesBeingLeft = new Set(differentMembers.map((move) => move.fromFamilyId).filter((id) => id != null));
    const separatesExcludedRelative = members.some((id) => !populationIds.has(id) &&
      familiesBeingLeft.has(localById.get(established.get(id))?.familyId));
    const rosterAgrees = !input.automaticLinks || reciprocalRoster(family);
    const allMembers = familyMembers(family);
    const residentPairs = destinationFamily ? allMembers.filter(id => automaticallyPlaceable(id, externalFamilyId) &&
      localById.get(established.get(id))?.familyId === destinationFamily.id)
      .sort().map(id => ({ externalPersonId: id, individualId: established.get(id) })) : [];
    const verifiedResidents = destinationFamily && residentPairs.length === (residentsByFamily.get(destinationFamily.id) || []).length;
    const canInferLink = !input.automaticLinks || linkedFamily || verifiedResidents;
    const previousConflict = plan.familyConflicts.find((action) => action.externalFamilyId === externalFamilyId);
    if (input.automaticLinks && linkedFamily && !differentMembers.length && !unresolved.length &&
        !unknownHousehold && !conflictingHousehold && !conflictingOwnership && !rosterAgrees &&
        reciprocalRoster(family, true)) {
      // Every participating person is already in the linked family. An
      // unknown outside-list relative creates no local work to review.
      // Leave the family name and all memberships untouched.
      plan.familyConflicts = plan.familyConflicts.filter((entry) => entry.externalFamilyId !== externalFamilyId);
      continue;
    }
    if (destinationFamily && !differentMembers.length && unresolved.every((id) => newPersonFamily.get(id) === externalFamilyId) &&
        canInferLink && rosterAgrees && !unknownHousehold && !conflictingHousehold && !conflictingOwnership) {
      // The established people already justify this family link. A new
      // person's signed creation can use it without moving any local person.
      plan.familyConflicts = plan.familyConflicts.filter((entry) => entry.externalFamilyId !== externalFamilyId);
      const familyName = String(family.name || '').trim();
      if (input.automaticLinks && linkedFamily && familyName && familyName !== linkedFamily.familyName &&
          !family.ambiguousName && verifiedResidents && allMembers.length && residentPairs.length === allMembers.length) {
        plan.renameFamily.push({
          id: actionId('renameFamily', externalFamilyId, linkedFamily.id), externalFamilyId,
          familyId: linkedFamily.id, currentFamilyName: linkedFamily.familyName, familyName,
          members: residentPairs,
          reason: 'provider_household_name', automatic: true, familyOwnership: [ownership(linkedFamily.id)],
        });
      }
      if (!linked.length) {
        plan.linkFamilies = plan.linkFamilies.filter((entry) => entry.externalFamilyId !== externalFamilyId);
        plan.linkFamilies.push({
          id: actionId('linkFamilies', externalFamilyId, destinationFamily.id),
          externalFamilyId, familyId: destinationFamily.id,
          memberExternalIds: inScopeIds, reason: 'household_member_family',
          ...(input.automaticLinks ? {
            automatic: true, familyOwnership: [ownership(destinationFamily.id)],
            members: residentPairs,
          } : {}),
        });
      }
      continue;
    }

    let reason = previousConflict?.reason || 'household_membership_mismatch';
    if (unresolved.length) reason = 'unresolved_household_members';
    else if (unknownHousehold || !rosterAgrees) reason = 'unknown_household_membership';
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
    if (rosterAgrees && !unresolved.length && !unknownHousehold && !conflictingHousehold && !conflictingOwnership &&
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
    if (action.resolution && input.automaticLinks && familyMembers(family).some(id =>
      (personFor(id)?.householdIds || []).length > 1)) {
      delete action.resolution;
      action.reason = 'multiple_provider_households';
    }
    const confirmedMembers = familyMembers(family);
    const expectedResidents = new Set(confirmedMembers.map(id => established.get(id)));
    const destinationIsClear = !destinationFamily || (residentsByFamily.get(destinationFamily.id) || []).every(id => expectedResidents.has(id));
    if (action.resolution && input.automaticLinks && destinationIsClear && !family.ambiguousName &&
        confirmedMembers.every(id => automaticallyPlaceable(id, externalFamilyId))) {
      action.automatic = true;
      action.members = familyMembers(family).sort().map(id => ({ externalPersonId: id, individualId: established.get(id) }));
      action.familyOwnership = [...new Set([...candidates, ...(destinationFamily ? [destinationFamily.id] : [])])].map(ownership);
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
    if (!local || input.householdVetoIds?.has(externalPersonId) || !hasConfirmedNoHousehold(person, input.externalFamilies)) continue;
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
    if (unchangedIdentity(externalPersonId) && !input.savedHouseholdExternalIds?.has(externalPersonId)) {
      detach.automatic = true;
      detach.familyOwnership = local.familyId == null ? [] : [ownership(local.familyId)];
    }
    if (!honourKeep(input, plan, 'familyConflicts', detach)) plan.familyConflicts.push(detach);
  }

  if (input.automaticLinks) for (const [id, individualId] of established) {
    if (!populationIds.has(id) || !unchangedIdentity(id) || input.savedHouseholdExternalIds?.has(id)) continue;
    const person = personFor(id);
    const ids = person?.householdIds;
    const reason = Array.isArray(ids) && ids.length > 1 ? 'multiple_provider_households'
      : input.householdVetoIds?.has(id) || !Array.isArray(ids) || (ids.length === 1 && !householdMembership.get(id)?.has(String(ids[0]))) ||
        (ids.length === 0 && !hasConfirmedNoHousehold(person, input.externalFamilies)) ? 'unknown_household_membership' : null;
    if (reason && !plan.familyConflicts.some(action => action.memberExternalIds?.includes(id))) {
      const familyId = localById.get(individualId)?.familyId;
      plan.familyConflicts.push({
        id: actionId('familyConflicts', 'person', id, reason), reason, externalFamilyId: null,
        memberExternalIds: [id], candidateFamilyIds: familyId == null ? [] : [familyId], unresolvedExternalPersonIds: [id],
      });
    }
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
      // Keep the creator as a concurrency check, not a source-of-truth
      // override: linked people follow the complete provider source union.
      ...(Object.hasOwn(row, 'addedBy') ? { addedBy: row.addedBy } : {}),
      ...(input.automaticLinks?.get(externalPersonId) === row.individualId &&
        batches.every(batch => batch.gatheringAutoRemoveEnabled === true) ? { automatic: true } : {}),
    };
    if (!honourKeep(input, plan, 'removeFromGathering', removal)) plan.removeFromGathering.push(removal);
  }
}

module.exports = { addReviewedFamilyActions, addReviewedGatheringRemovals, reconciliationKeepFor };
