'use strict';

const { normalizeName, nameKey } = require('../planningCenter/matcher');

const localId = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;
const externalId = (value) => value == null || String(value).trim() === '' ? null : String(value);
const asArray = (value) => Array.isArray(value) ? value : [];
const sortedNames = (values) => [...new Set(values.filter((value) => typeof value === 'string').map((value) => value.trim()).filter(Boolean))]
  .sort((a, b) => a.localeCompare(b, 'en'));

function exactName(person) {
  return normalizeName(person?.firstName) && normalizeName(person?.lastName) ? nameKey(person.firstName, person.lastName) : null;
}

function touchedIdentities(plan) {
  const local = new Set();
  const external = new Set();
  const addLocal = (id) => { if (localId(id) !== null) local.add(id); };
  const addExternal = (id) => { const value = externalId(id); if (value !== null) external.add(value); };
  const record = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    for (const key of ['individualId', 'suggestedIndividualId', 'linkedIndividualId', 'fromIndividualId', 'toIndividualId']) addLocal(entry[key]);
    for (const key of ['candidateIndividualIds', 'staleLinkedIndividualIds']) for (const id of asArray(entry[key])) addLocal(id);
    addExternal(entry.externalPersonId);
    for (const key of ['memberExternalIds', 'candidateExternalPersonIds']) for (const id of asArray(entry[key])) addExternal(id);
  };
  for (const bucket of ['linkPeople', 'addPeople', 'addFamilies', 'archive', 'moveFamily', 'updateManagedFields', 'promoteToRegular', 'demoteToLocalVisitor', 'reactivate', 'ambiguousPeople']) {
    for (const entry of asArray(plan[bucket])) record(entry);
  }
  for (const identities of [plan.identities, plan.reviewContext?.identities, plan.reviewContext?.linkCorrections]) {
    if (Array.isArray(identities)) identities.forEach(record);
    else if (identities && typeof identities === 'object') for (const [id, entry] of Object.entries(identities)) {
      addExternal(id);
      record(entry);
      record(entry?.destination);
    }
  }
  for (const action of asArray(plan.familyConflicts)) {
    if (!action.resolution) continue;
    record(action);
    for (const move of asArray(action.resolution.moves)) record(move);
  }
  for (const decision of asArray(plan.householdChoices?.decisions)) for (const person of asArray(decision.people)) record(person);
  return { local, external };
}

/**
 * Offer only reviewed archives. This pure projection never establishes links,
 * changes provider records, or broadens ordinary identity-review eligibility.
 * memberExternalIds must be the actual union of every enabled source, including
 * source members that ordinary people-sync eligibility would otherwise filter.
 */
function addOutsideSourceArchiveProposals(plan, {
  directorySnapshot, individuals = [], personLinks = [], matchReviewState = {}, memberExternalIds, sourceNames = [],
} = {}) {
  const result = { ...plan, archive: [...asArray(plan.archive)] };
  const sources = sortedNames(asArray(sourceNames));
  if (plan.provider !== 'planning_center' || plan.authoritative !== true || plan.operationKind === 'people_import' ||
      directorySnapshot?.complete !== true || !Array.isArray(directorySnapshot.people) || !sources.length ||
      !(memberExternalIds instanceof Set || Array.isArray(memberExternalIds))) return result;
  const members = new Set([...memberExternalIds].map(externalId).filter(Boolean));
  const touched = touchedIdentities(plan);
  const directoryById = new Map();
  const duplicatedExternalIds = new Set();
  const directoryNames = new Map();
  for (const person of directorySnapshot.people) {
    const id = externalId(person?.id);
    if (id === null) continue;
    if (directoryById.has(id)) duplicatedExternalIds.add(id);
    directoryById.set(id, person);
    const key = exactName(person);
    if (!key) continue;
    if (!directoryNames.has(key)) directoryNames.set(key, []);
    directoryNames.get(key).push(id);
  }
  const localNames = new Map();
  const localById = new Map();
  const duplicateLocalIds = new Set();
  const compatibilityOwners = new Map();
  for (const person of individuals) {
    const id = localId(person?.id);
    if (id === null) continue;
    if (localById.has(id)) duplicateLocalIds.add(id);
    localById.set(id, person);
    const key = exactName(person);
    // Count every local record before filtering candidates. An inactive or
    // visitor namesake must not turn an ambiguous name into a unique match.
    if (key) {
      if (!localNames.has(key)) localNames.set(key, []);
      localNames.get(key).push(id);
    }
    const compatibilityId = externalId(person.planningCenterId);
    if (compatibilityId !== null) {
      if (!compatibilityOwners.has(compatibilityId)) compatibilityOwners.set(compatibilityId, new Set());
      compatibilityOwners.get(compatibilityId).add(id);
    }
  }
  const linksByLocal = new Map();
  const linksByExternal = new Map();
  for (const link of personLinks) {
    if (link?.provider != null && link.provider !== 'planning_center') continue;
    const id = localId(link?.individualId);
    const providerId = externalId(link?.externalPersonId);
    if (id === null || providerId === null) continue;
    if (!linksByLocal.has(id)) linksByLocal.set(id, new Set());
    linksByLocal.get(id).add(providerId);
    if (!linksByExternal.has(providerId)) linksByExternal.set(providerId, new Set());
    linksByExternal.get(providerId).add(id);
  }
  const held = new Set(asArray(matchReviewState.holds).map((entry) => externalId(entry?.externalPersonId)).filter(Boolean));
  const excluded = new Set(asArray(matchReviewState.exclusions).map((entry) => JSON.stringify([externalId(entry?.externalPersonId), localId(entry?.individualId)])));
  const additions = [];
  for (const [individualId, local] of [...localById].sort(([a], [b]) => a - b)) {
    if (duplicateLocalIds.has(individualId) || touched.local.has(individualId) || local.peopleType !== 'regular' ||
        !(local.isActive === true || local.isActive === 1)) continue;
    const linked = linksByLocal.get(individualId);
    let externalPersonId;
    let linkRequired = false;
    if (linked) {
      if (linked.size !== 1) continue;
      externalPersonId = [...linked][0];
      if (linksByExternal.get(externalPersonId)?.size !== 1) continue;
      const compatibilityId = externalId(local.planningCenterId);
      if (compatibilityId !== null && compatibilityId !== externalPersonId) continue;
    } else {
      if (externalId(local.planningCenterId) !== null) continue;
      const key = exactName(local);
      const candidates = key ? directoryNames.get(key) || [] : [];
      if (candidates.length !== 1 || localNames.get(key)?.length !== 1) continue;
      externalPersonId = candidates[0];
      if (linksByExternal.has(externalPersonId)) continue;
      linkRequired = true;
    }
    if (duplicatedExternalIds.has(externalPersonId) || members.has(externalPersonId) || touched.external.has(externalPersonId) || held.has(externalPersonId) ||
        excluded.has(JSON.stringify([externalPersonId, individualId]))) continue;
    if ([...(compatibilityOwners.get(externalPersonId) || [])].some((owner) => owner !== individualId)) continue;
    const external = directoryById.get(externalPersonId);
    if (!external || String(external.state ?? external.status ?? '').trim().toLowerCase() !== 'active') continue;
    const householdIds = new Set(asArray(external.householdIds).map(String));
    if (external.familyId != null) householdIds.add(String(external.familyId));
    const householdNames = asArray(directorySnapshot.families).filter((family) => householdIds.has(String(family.id)) ||
      asArray(family.householdMemberExternalIds || family.memberExternalIds).some((id) => String(id) === externalPersonId))
      .map((family) => family.name || family.familyName);
    additions.push({
      id: `archive:outside_all_sync_sources:${encodeURIComponent(externalPersonId)}:${individualId}`,
      externalPersonId, individualId, reason: 'outside_all_sync_sources', linkRequired,
      externalFirstName: external.firstName || '', externalLastName: external.lastName || '',
      sourceNames: [...sources], pcoHouseholdNames: sortedNames(householdNames),
    });
  }
  result.archive.push(...additions.sort((a, b) => a.id.localeCompare(b.id, 'en')));
  return result;
}

module.exports = { addOutsideSourceArchiveProposals };
