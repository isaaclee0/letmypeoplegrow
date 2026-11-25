'use strict';

// Scope established-link maintenance to the provider's identity, independently
// of source membership. Legacy compatibility IDs can veto a link, never create one.
function uniquePlanningCenterLinks({ churchId, individuals, personLinks }) {
  const locals = new Map(individuals.map(person => [person.id, person]));
  const compatibility = new Map(individuals.filter(p => p.planningCenterId).map(p => [String(p.planningCenterId), p.id]));
  const byExternal = new Map();
  const byLocal = new Map();
  for (const { churchId: scope, provider, externalPersonId, individualId } of personLinks) {
    if ((scope && scope !== churchId) || (provider && provider !== 'planning_center')) continue;
    byExternal.set(externalPersonId, byExternal.has(externalPersonId) ? null : individualId);
    byLocal.set(individualId, byLocal.has(individualId) ? null : externalPersonId);
  }
  const pairs = new Map();
  for (const [id, localId] of byExternal) {
    const local = locals.get(localId);
    if (local && byLocal.get(localId) === id && (!local.planningCenterId || String(local.planningCenterId) === id) &&
        (!compatibility.has(id) || compatibility.get(id) === localId)) pairs.set(id, localId);
  }
  return pairs;
}

function validHouseholdRoster(ids) {
  return Array.isArray(ids) && ids.every(id => typeof id === 'string' && id.trim() === id && id.length > 0) &&
    new Set(ids).size === ids.length;
}

function mergeHousehold(familiesById, family, reconcileNames = true) {
  if (reconcileNames && Object.hasOwn(family, 'householdMemberExternalIds') && !validHouseholdRoster(family.householdMemberExternalIds)) {
    const ids = Array.isArray(family.householdMemberExternalIds) ? family.householdMemberExternalIds : [];
    family = { ...family, incompleteRoster: true, householdMemberExternalIds: ids.filter(id => typeof id === 'string' && id.trim()) };
  }
  const id = String(family.id);
  const previous = familiesById.get(id);
  if (!previous) {
    familiesById.set(id, family);
    return;
  }
  const union = (a, b) => [...new Set([...(a || []), ...(b || [])].map(String))].sort();
  const ambiguousName = previous.ambiguousName || Boolean(previous.name && family.name && previous.name !== family.name);
  const previousRoster = previous.householdMemberExternalIds;
  const nextRoster = family.householdMemberExternalIds;
  const inconsistentRoster = reconcileNames && (previous.incompleteRoster || family.incompleteRoster ||
    (previousRoster && nextRoster && JSON.stringify([...previousRoster].sort()) !== JSON.stringify([...nextRoster].sort())));
  familiesById.set(id, { ...previous,
    ...(inconsistentRoster ? { incompleteRoster: true } : {}),
    ...(reconcileNames ? { name: ambiguousName ? null : previous.name || family.name } : {}),
    ...(reconcileNames && ambiguousName ? { ambiguousName: true } : {}),
    memberExternalIds: union(previous.memberExternalIds, family.memberExternalIds),
    ...((previous.householdMemberExternalIds || family.householdMemberExternalIds) ? {
      householdMemberExternalIds: union(previous.householdMemberExternalIds, family.householdMemberExternalIds),
    } : {}),
  });
}

function combineLinkedHouseholds(state, supplemental) {
  const families = new Map(state.snapshot.families.map(family => [String(family.id), family]));
  for (const family of supplemental.families) mergeHousehold(families, family);
  state.snapshot.families = [...families.values()];

  // An explicit disagreement between the independent List and Person reads
  // invalidates household placement. A missing relationship is unknown.
  const observations = new Map();
  const conflicts = state.conflictingHouseholdIds;
  const groups = [state.snapshot.people, state.ineligibleMemberPeople, state.contextPeople, supplemental.people, supplemental.contextPeople];
  for (const people of groups) for (const person of people) {
    if (!Array.isArray(person.householdIds)) continue;
    const id = String(person.id);
    const value = [...new Set(person.householdIds.map(String))].sort();
    const old = observations.get(id);
    if (old && JSON.stringify(value) !== JSON.stringify(old.householdIds)) conflicts.add(id);
    else observations.set(id, { householdIds: value, familyId: person.familyId });
  }
  const harmonize = person => conflicts.has(String(person.id)) ? { ...person, householdIds: null }
    : { ...person, ...observations.get(String(person.id)) };
  state.snapshot.people = state.snapshot.people.map(harmonize);
  state.ineligibleMemberPeople = state.ineligibleMemberPeople.map(harmonize);
  state.linkedPeople = supplemental.people.map(harmonize);
  const ids = new Set([...state.seenMemberExternalIds, ...state.linkedPeople.map(p => String(p.id))]);
  const context = new Map();
  for (const person of [...state.contextPeople, ...supplemental.contextPeople]) {
    if (!ids.has(String(person.id))) context.set(String(person.id), harmonize(person));
  }
  state.contextPeople = [...context.values()];
}

// Directory evidence is read for an optional manual review. It can disprove
// a placement but never supply a source member, person match or destination.
function directoryHouseholdVetoes(state, directory, linkedIds) {
  const veto = new Set();
  if (!directory || !linkedIds?.size) return veto;
  const observed = new Map();
  for (const person of [...state.snapshot.people, ...(state.linkedPeople || [])]) {
    if (linkedIds.has(person.id) && Array.isArray(person.householdIds)) observed.set(person.id, person.householdIds);
  }
  const byFamily = new Map();
  for (const [id, households] of observed) for (const familyId of households) {
    if (!byFamily.has(familyId)) byFamily.set(familyId, []);
    byFamily.get(familyId).push(id);
  }
  for (const person of [...directory.people, ...directory.contextPeople]) {
    const previous = observed.get(person.id);
    if (previous && Array.isArray(person.householdIds) &&
        JSON.stringify([...previous].sort()) !== JSON.stringify([...person.householdIds].sort())) veto.add(person.id);
  }
  const sourceFamilies = new Map(state.snapshot.families.map(family => [family.id, family]));
  for (const family of directory.families) {
    const sourceFamily = sourceFamilies.get(family.id);
    const sourceName = String(sourceFamily?.name || '').trim();
    const directoryName = String(family.name || '').trim();
    if (sourceName && directoryName && sourceName !== directoryName) {
      for (const id of byFamily.get(family.id) || []) veto.add(id);
    }
    const roster = family.householdMemberExternalIds;
    if (roster === undefined && !family.incompleteRoster) continue;
    const valid = validHouseholdRoster(roster);
    const prior = sourceFamily?.householdMemberExternalIds;
    if (family.incompleteRoster || !valid || (validHouseholdRoster(prior) &&
        JSON.stringify([...prior].sort()) !== JSON.stringify([...roster].sort()))) {
      for (const id of byFamily.get(family.id) || []) veto.add(id);
    }
    if (valid) for (const id of roster) {
      if (observed.has(id) && !observed.get(id).includes(family.id)) veto.add(id);
    }
  }
  return veto;
}

module.exports = { directoryHouseholdVetoes, validHouseholdRoster, uniquePlanningCenterLinks, combineLinkedHouseholds, mergeHousehold };
