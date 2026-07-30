function stableString(value) {
  return String(value ?? '');
}

function compareString(left, right) {
  const a = stableString(left);
  const b = stableString(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareNumericId(left, right) {
  return Number(left.id) - Number(right.id);
}

function pairKey(externalPersonId, individualId) {
  return `${stableString(externalPersonId)}\u0000${Number(individualId)}`;
}

function candidateAllowed(externalPersonId, localPerson, excludedPairs) {
  return !excludedPairs.has(pairKey(externalPersonId, localPerson.id));
}

function normalizeName(value) {
  return stableString(value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeFamilyId(value) {
  return value === null || value === undefined ? null : stableString(value);
}

function nameKey(person) {
  const firstName = normalizeName(person?.firstName);
  const lastName = normalizeName(person?.lastName);
  return firstName && lastName ? `${firstName}\u0000${lastName}` : null;
}

function indexByName(people) {
  const index = new Map();
  for (const person of people) {
    const key = nameKey(person);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(person);
  }
  return index;
}

function uniquePeopleById(people, compare) {
  const seen = new Set();
  return [...people]
    .sort(compare)
    .filter((person) => {
      const id = stableString(person.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
}

function canonicalExternal(person) {
  return {
    id: stableString(person?.id),
    firstName: normalizeName(person?.firstName),
    lastName: normalizeName(person?.lastName),
    child: typeof person?.child === 'boolean' ? person.child : null,
    familyId: normalizeFamilyId(person?.familyId),
  };
}

function externalFingerprint(person) {
  return JSON.stringify(canonicalExternal(person));
}

function prepareExternalPeople(people) {
  const groups = new Map();
  for (const person of people || []) {
    const id = stableString(person?.id);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(canonicalExternal(person));
  }

  const duplicateExternalIds = new Set();
  const externalPeople = [];
  for (const [id, records] of groups) {
    const fingerprints = new Set(records.map(externalFingerprint));
    if (fingerprints.size > 1) duplicateExternalIds.add(id);
    externalPeople.push([...records].sort((a, b) => compareString(externalFingerprint(a), externalFingerprint(b)))[0]);
  }
  externalPeople.sort((a, b) => compareString(a.id, b.id));
  return { externalPeople, duplicateExternalIds };
}

function idSet(people) {
  return new Set(people.map((person) => stableString(person.id)));
}

function memberIds(membersByFamily, familyId) {
  const key = normalizeFamilyId(familyId);
  if (key === null) return new Set();
  return idSet(membersByFamily.get(key) || []);
}

function normalizeFamilyMembers(membersByFamily) {
  const normalized = new Map();
  for (const [familyId, members] of membersByFamily instanceof Map ? membersByFamily : []) {
    const key = normalizeFamilyId(familyId);
    if (key === null) continue;
    if (!normalized.has(key)) normalized.set(key, []);
    normalized.get(key).push(...(members || []));
  }
  return normalized;
}

function buildDurableLinks(existingLinks, externalById, localById) {
  const claimsByExternal = new Map();
  const claimsByLocal = new Map();

  for (const link of existingLinks || []) {
    const externalPersonId = stableString(link?.externalPersonId);
    const individualId = Number(link?.individualId);
    if (!externalById.has(externalPersonId) || !Number.isInteger(individualId)) continue;
    if (!claimsByExternal.has(externalPersonId)) claimsByExternal.set(externalPersonId, new Set());
    if (!claimsByLocal.has(individualId)) claimsByLocal.set(individualId, new Set());
    claimsByExternal.get(externalPersonId).add(individualId);
    claimsByLocal.get(individualId).add(externalPersonId);
  }

  const validByExternal = new Map();
  const conflictedByExternal = new Map();
  const staleByExternal = new Map();
  const reservedLocalIds = new Set();

  for (const [externalPersonId, individualIds] of claimsByExternal) {
    for (const individualId of individualIds) {
      if (localById.has(individualId)) reservedLocalIds.add(individualId);
    }
    const claimIds = [...individualIds].sort((a, b) => a - b);
    const candidateIndividualIds = claimIds.filter((individualId) => localById.has(individualId));
    const staleLinkedIndividualIds = claimIds.filter((individualId) => !localById.has(individualId));
    if (staleLinkedIndividualIds.length > 0) {
      staleByExternal.set(externalPersonId, { candidateIndividualIds, staleLinkedIndividualIds });
      continue;
    }
    const individualId = individualIds.size === 1 ? [...individualIds][0] : null;
    if (individualId !== null && claimsByLocal.get(individualId).size === 1) {
      validByExternal.set(externalPersonId, individualId);
    } else {
      conflictedByExternal.set(externalPersonId, [...individualIds].sort((a, b) => a - b));
    }
  }

  return { validByExternal, conflictedByExternal, staleByExternal, reservedLocalIds };
}

function hasLinkedFamilyMember({ externalPerson, localPerson, externalFamilyMembers, localFamilyMembers, linkedByExternal }) {
  const externalMemberIds = memberIds(externalFamilyMembers, externalPerson.familyId);
  const localMemberIds = memberIds(localFamilyMembers, localPerson.familyId);
  externalMemberIds.delete(stableString(externalPerson.id));
  localMemberIds.delete(stableString(localPerson.id));

  if (externalMemberIds.size === 0 || localMemberIds.size === 0) return false;
  for (const externalMemberId of externalMemberIds) {
    const individualId = linkedByExternal.get(externalMemberId);
    if (individualId !== undefined && localMemberIds.has(stableString(individualId))) return true;
  }
  return false;
}

function isRegularActive(person) {
  return person.isActive !== false && (person.peopleType === undefined || person.peopleType === null || person.peopleType === 'regular');
}

function isVisitorActive(person) {
  return person.isActive !== false && !isRegularActive(person);
}

function regularDecision(externalPerson, regularByName, reservedLocalIds, familyContext, excludedPairs) {
  const key = nameKey(externalPerson);
  if (!key) return { candidates: [], proposal: null };
  let candidates = (regularByName.get(key) || [])
    .filter((person) => !reservedLocalIds.has(Number(person.id)))
    .filter((person) => candidateAllowed(externalPerson.id, person, excludedPairs));
  if (candidates.length === 1) return { candidates, proposal: { person: candidates[0], reason: 'unique_name' } };

  if (candidates.length > 1 && typeof externalPerson.child === 'boolean') {
    const sameChildState = candidates.filter((person) => typeof person.isChild === 'boolean' && person.isChild === externalPerson.child);
    if (sameChildState.length === 1) return { candidates: sameChildState, proposal: { person: sameChildState[0], reason: 'child_narrowing' } };
    if (sameChildState.length > 0) candidates = sameChildState;
  }

  if (candidates.length > 1) {
    const corroborated = candidates.filter((localPerson) => hasLinkedFamilyMember({
      externalPerson,
      localPerson,
      ...familyContext,
    }));
    if (corroborated.length === 1) return { candidates: corroborated, proposal: { person: corroborated[0], reason: 'family_corroboration' } };
    return {
      candidates,
      proposal: null,
      ambiguityReason: corroborated.length > 1 ? 'conflicting_family_evidence' : 'duplicate_name',
    };
  }
  return { candidates, proposal: null };
}

function reviewDecision(externalPerson, visitorByName, archivedByName, reservedLocalIds, excludedPairs) {
  const key = nameKey(externalPerson);
  if (!key) return { candidates: [], proposal: null };
  const available = (person) => (
    !reservedLocalIds.has(Number(person.id))
    && candidateAllowed(externalPerson.id, person, excludedPairs)
  );
  const visitors = (visitorByName.get(key) || []).filter(available);
  const archived = (archivedByName.get(key) || []).filter(available);
  const candidates = [...visitors, ...archived].sort(compareNumericId);
  if (candidates.length !== 1) return { candidates, proposal: null };
  return {
    candidates,
    proposal: { person: candidates[0], bucket: visitors.length === 1 ? 'visitor' : 'archived' },
  };
}

function contentionByLocal(proposals) {
  const externalIdsByLocal = new Map();
  for (const [externalPersonId, proposal] of proposals) {
    const individualId = Number(proposal.person.id);
    if (!externalIdsByLocal.has(individualId)) externalIdsByLocal.set(individualId, new Set());
    externalIdsByLocal.get(individualId).add(externalPersonId);
  }
  return externalIdsByLocal;
}

function matchPeople(input) {
  const { externalPeople, duplicateExternalIds } = prepareExternalPeople(input?.externalPeople);
  const localPeople = uniquePeopleById(input?.localPeople || [], compareNumericId);
  const excludedPairs = input?.excludedPairs instanceof Set ? input.excludedPairs : new Set(input?.excludedPairs || []);
  const heldExternalIds = new Set([...(input?.heldExternalIds || [])].map(stableString));
  const externalById = new Map(externalPeople.map((person) => [stableString(person.id), person]));
  const localById = new Map(localPeople.map((person) => [Number(person.id), person]));
  const { validByExternal, conflictedByExternal, staleByExternal, reservedLocalIds } = buildDurableLinks(
    input?.existingLinks,
    externalById,
    localById
  );
  const usedExternalIds = new Set();
  const usedLocalIds = new Set();
  const linkedByExternal = new Map(validByExternal);
  const result = {
    linked: [], matches: [], ambiguous: [], unmatchedExternalIds: [], unmatchedLocalIds: [],
    visitorMatches: [], archivedMatches: [],
  };

  const reserve = (externalPerson, localPerson) => {
    usedExternalIds.add(stableString(externalPerson.id));
    usedLocalIds.add(Number(localPerson.id));
  };
  const regularByName = indexByName(localPeople.filter(isRegularActive));
  const visitorByName = indexByName(localPeople.filter(isVisitorActive));
  const archivedByName = indexByName(localPeople.filter((person) => person.isActive === false));
  const familyContext = {
    externalFamilyMembers: normalizeFamilyMembers(input?.externalFamilyMembers),
    localFamilyMembers: normalizeFamilyMembers(input?.localFamilyMembers),
    linkedByExternal,
  };
  const excludedExternalIds = new Set([
    ...duplicateExternalIds,
    ...conflictedByExternal.keys(),
    ...staleByExternal.keys(),
    ...validByExternal.keys(),
  ]);
  const regularDecisions = new Map();
  const regularProposals = new Map();
  const reviewDecisions = new Map();
  const reviewProposals = new Map();
  for (const externalPerson of externalPeople) {
    const externalPersonId = stableString(externalPerson.id);
    if (excludedExternalIds.has(externalPersonId)) continue;
    const decision = regularDecision(externalPerson, regularByName, reservedLocalIds, familyContext, excludedPairs);
    regularDecisions.set(externalPersonId, decision);
    if (decision.proposal) {
      regularProposals.set(externalPersonId, decision.proposal);
      continue;
    }
    if (decision.candidates.length === 0) {
      const review = reviewDecision(externalPerson, visitorByName, archivedByName, reservedLocalIds, excludedPairs);
      reviewDecisions.set(externalPersonId, review);
      if (review.proposal) reviewProposals.set(externalPersonId, review.proposal);
    }
  }
  const regularContention = contentionByLocal(regularProposals);
  const reviewContention = contentionByLocal(reviewProposals);
  const isContended = (contention, localPerson) => {
    const contenders = contention.get(Number(localPerson.id));
    return contenders?.size > 1;
  };

  for (const externalPerson of externalPeople) {
    const externalPersonId = stableString(externalPerson.id);
    if (usedExternalIds.has(externalPersonId)) continue;

    if (duplicateExternalIds.has(externalPersonId)) {
      result.ambiguous.push({
        externalPersonId,
        candidateIndividualIds: [],
        reason: 'duplicate_external_id',
      });
      usedExternalIds.add(externalPersonId);
      continue;
    }

    if (staleByExternal.has(externalPersonId)) {
      const stale = staleByExternal.get(externalPersonId);
      result.ambiguous.push({
        externalPersonId,
        candidateIndividualIds: stale.candidateIndividualIds,
        staleLinkedIndividualIds: stale.staleLinkedIndividualIds,
        reason: 'stale_link',
      });
      usedExternalIds.add(externalPersonId);
      continue;
    }

    if (conflictedByExternal.has(externalPersonId)) {
      result.ambiguous.push({
        externalPersonId,
        candidateIndividualIds: conflictedByExternal.get(externalPersonId),
        reason: 'conflicting_existing_link',
      });
      usedExternalIds.add(externalPersonId);
      continue;
    }

    const linkedIndividualId = validByExternal.get(externalPersonId);
    if (linkedIndividualId !== undefined) {
      const localPerson = localById.get(linkedIndividualId);
      reserve(externalPerson, localPerson);
      result.linked.push({ individualId: linkedIndividualId, externalPersonId, reason: 'existing_link' });
      continue;
    }

    const decision = regularDecisions.get(externalPersonId);
    const review = reviewDecisions.get(externalPersonId);
    if (heldExternalIds.has(externalPersonId)) {
      const candidates = decision?.candidates.length > 0 ? decision.candidates : review?.candidates || [];
      result.ambiguous.push({
        externalPersonId,
        candidateIndividualIds: candidates.map((person) => Number(person.id)),
        reason: 'review_deferred',
      });
      usedExternalIds.add(externalPersonId);
      continue;
    }

    const key = nameKey(externalPerson);
    if (!key) {
      result.unmatchedExternalIds.push(externalPersonId);
      usedExternalIds.add(externalPersonId);
      continue;
    }

    if (decision?.proposal) {
      const { person, reason } = decision.proposal;
      if (isContended(regularContention, person)) {
        result.ambiguous.push({
          externalPersonId,
          candidateIndividualIds: [Number(person.id)],
          reason: 'contended_unique_name',
        });
        usedExternalIds.add(externalPersonId);
        continue;
      }
      reserve(externalPerson, person);
      result.matches.push({ individualId: Number(person.id), externalPersonId, reason });
      continue;
    }
    if (decision?.candidates.length > 1) {
      result.ambiguous.push({
        externalPersonId,
        candidateIndividualIds: decision.candidates.map((person) => Number(person.id)),
        reason: decision.ambiguityReason,
      });
      usedExternalIds.add(externalPersonId);
      continue;
    }

    const reviewDecisionResult = review || { candidates: [], proposal: null };
    if (reviewDecisionResult.proposal) {
      const { person, bucket } = reviewDecisionResult.proposal;
      if (isContended(reviewContention, person)) {
        result.ambiguous.push({
          externalPersonId,
          candidateIndividualIds: [Number(person.id)],
          reason: 'contended_review_candidate',
        });
        usedExternalIds.add(externalPersonId);
        continue;
      }
      reserve(externalPerson, person);
      if (bucket === 'visitor') {
        result.visitorMatches.push({
          externalPersonId,
          individualId: Number(person.id),
          peopleType: person.peopleType,
        });
      } else {
        result.archivedMatches.push({ externalPersonId, individualId: Number(person.id) });
      }
      continue;
    }

    if (reviewDecisionResult.candidates.length > 1) {
      result.ambiguous.push({
        externalPersonId,
        candidateIndividualIds: reviewDecisionResult.candidates.map((person) => Number(person.id)),
        reason: 'review_candidates',
      });
    } else {
      result.unmatchedExternalIds.push(externalPersonId);
    }
    usedExternalIds.add(externalPersonId);
  }

  result.unmatchedLocalIds = localPeople
    .filter((person) => !usedLocalIds.has(Number(person.id)))
    .map((person) => Number(person.id));
  return result;
}

module.exports = { normalizeName, nameKey, matchPeople };
