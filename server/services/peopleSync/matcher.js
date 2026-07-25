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

function normalizeName(value) {
  return stableString(value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
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

function idSet(people) {
  return new Set(people.map((person) => stableString(person.id)));
}

function memberIds(membersByFamily, familyId) {
  if (familyId === null || familyId === undefined) return new Set();
  return idSet(membersByFamily.get(familyId) || []);
}

function buildDurableLinks(existingLinks, externalById, localById) {
  const claimsByExternal = new Map();
  const claimsByLocal = new Map();

  for (const link of existingLinks || []) {
    const externalPersonId = stableString(link?.externalPersonId);
    const individualId = Number(link?.individualId);
    if (!externalById.has(externalPersonId) || !localById.has(individualId)) continue;
    if (!claimsByExternal.has(externalPersonId)) claimsByExternal.set(externalPersonId, new Set());
    if (!claimsByLocal.has(individualId)) claimsByLocal.set(individualId, new Set());
    claimsByExternal.get(externalPersonId).add(individualId);
    claimsByLocal.get(individualId).add(externalPersonId);
  }

  const validByExternal = new Map();
  const conflictedByExternal = new Map();
  const reservedLocalIds = new Set();

  for (const [externalPersonId, individualIds] of claimsByExternal) {
    for (const individualId of individualIds) reservedLocalIds.add(individualId);
    const individualId = individualIds.size === 1 ? [...individualIds][0] : null;
    if (individualId !== null && claimsByLocal.get(individualId).size === 1) {
      validByExternal.set(externalPersonId, individualId);
    } else {
      conflictedByExternal.set(externalPersonId, [...individualIds].sort((a, b) => a - b));
    }
  }

  return { validByExternal, conflictedByExternal, reservedLocalIds };
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

function matchPeople(input) {
  const externalPeople = uniquePeopleById(input?.externalPeople || [], (a, b) => compareString(a.id, b.id));
  const localPeople = uniquePeopleById(input?.localPeople || [], compareNumericId);
  const externalById = new Map(externalPeople.map((person) => [stableString(person.id), person]));
  const localById = new Map(localPeople.map((person) => [Number(person.id), person]));
  const { validByExternal, conflictedByExternal, reservedLocalIds } = buildDurableLinks(
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
  const available = (person) => !usedLocalIds.has(Number(person.id)) && !reservedLocalIds.has(Number(person.id));
  const regularByName = indexByName(localPeople.filter(isRegularActive));
  const visitorByName = indexByName(localPeople.filter(isVisitorActive));
  const archivedByName = indexByName(localPeople.filter((person) => person.isActive === false));

  for (const externalPerson of externalPeople) {
    const externalPersonId = stableString(externalPerson.id);
    if (usedExternalIds.has(externalPersonId)) continue;

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

    const key = nameKey(externalPerson);
    if (!key) {
      result.unmatchedExternalIds.push(externalPersonId);
      usedExternalIds.add(externalPersonId);
      continue;
    }

    let candidates = (regularByName.get(key) || []).filter(available);
    if (candidates.length === 1) {
      reserve(externalPerson, candidates[0]);
      result.matches.push({ individualId: Number(candidates[0].id), externalPersonId, reason: 'unique_name' });
      continue;
    }

    if (candidates.length > 1 && typeof externalPerson.child === 'boolean') {
      const sameChildState = candidates.filter((person) => typeof person.isChild === 'boolean' && person.isChild === externalPerson.child);
      if (sameChildState.length === 1) {
        reserve(externalPerson, sameChildState[0]);
        result.matches.push({ individualId: Number(sameChildState[0].id), externalPersonId, reason: 'child_narrowing' });
        continue;
      }
      if (sameChildState.length > 0) candidates = sameChildState;
    }

    if (candidates.length > 1) {
      const corroborated = candidates.filter((localPerson) => hasLinkedFamilyMember({
        externalPerson,
        localPerson,
        externalFamilyMembers: input?.externalFamilyMembers || new Map(),
        localFamilyMembers: input?.localFamilyMembers || new Map(),
        linkedByExternal,
      }));
      if (corroborated.length === 1) {
        reserve(externalPerson, corroborated[0]);
        result.matches.push({ individualId: Number(corroborated[0].id), externalPersonId, reason: 'family_corroboration' });
        continue;
      }
      result.ambiguous.push({
        externalPersonId,
        candidateIndividualIds: candidates.map((person) => Number(person.id)),
        reason: corroborated.length > 1 ? 'conflicting_family_evidence' : 'duplicate_name',
      });
      usedExternalIds.add(externalPersonId);
      continue;
    }

    const visitorCandidates = (visitorByName.get(key) || []).filter(available);
    if (visitorCandidates.length === 1) {
      reserve(externalPerson, visitorCandidates[0]);
      result.visitorMatches.push({
        externalPersonId,
        individualId: Number(visitorCandidates[0].id),
        peopleType: visitorCandidates[0].peopleType,
      });
      continue;
    }

    const archivedCandidates = (archivedByName.get(key) || []).filter(available);
    if (archivedCandidates.length === 1) {
      reserve(externalPerson, archivedCandidates[0]);
      result.archivedMatches.push({ externalPersonId, individualId: Number(archivedCandidates[0].id) });
      continue;
    }

    if (visitorCandidates.length > 1 || archivedCandidates.length > 1) {
      const reviewCandidates = visitorCandidates.length > 1 ? visitorCandidates : archivedCandidates;
      result.ambiguous.push({
        externalPersonId,
        candidateIndividualIds: reviewCandidates.map((person) => Number(person.id)),
        reason: visitorCandidates.length > 1 ? 'visitor_candidates' : 'archived_candidates',
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
