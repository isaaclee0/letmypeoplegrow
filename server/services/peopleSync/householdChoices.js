'use strict';

const crypto = require('node:crypto');
const { buildFamilyName } = require('./familyName');

function invalid(message) {
  return Object.assign(new Error(message), { code: 'SYNC_HOUSEHOLD_CHOICES_INVALID', status: 400 });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalHouseholdChoices(value = {}) {
  if (!isRecord(value)) throw invalid('LMPG household choices must be an object.');
  const result = {};
  for (const id of Object.keys(value).sort()) {
    const edit = value[id];
    if (!id || ['__proto__', 'constructor', 'prototype'].includes(id) || !isRecord(edit) ||
        Object.keys(edit).some((key) => !['destination', 'displayName'].includes(key)) || !isRecord(edit.destination)) {
      throw invalid('Household choices changed. Refresh this review and choose an LMPG destination.');
    }
    const { destination } = edit;
    if (!['keep', 'existing', 'create', 'forget'].includes(destination.kind) ||
        Object.keys(destination).some((key) => key !== 'kind' && !(destination.kind === 'existing' && key === 'familyId')) ||
        (destination.kind === 'existing' && (!Number.isSafeInteger(destination.familyId) || destination.familyId <= 0))) {
      throw invalid('Choose whether to keep, move, create, or forget the LMPG household arrangement.');
    }
    result[id] = { destination: destination.kind === 'existing' ? { kind: 'existing', familyId: destination.familyId } : { kind: destination.kind } };
    if (Object.hasOwn(edit, 'displayName')) {
      if (typeof edit.displayName !== 'string' || edit.displayName.trim().length > 200 || /[\u0000-\u001f\u007f]/u.test(edit.displayName)) {
        throw invalid('The LMPG family name must be at most 200 characters without control characters.');
      }
      result[id].displayName = edit.displayName.trim();
    }
    if (destination.kind === 'create' && !result[id].displayName) throw invalid('Enter a name for the new LMPG family.');
    if (destination.kind === 'forget' && result[id].displayName) throw invalid('Forgetting an arrangement cannot rename a family.');
  }
  return result;
}

function canonicalPreferences(preferences = []) {
  if (!Array.isArray(preferences)) throw invalid('Remembered LMPG household arrangements must be a list.');
  const seen = new Set();
  return preferences.map((preference) => {
    if (!isRecord(preference) || typeof preference.externalPersonId !== 'string' || !preference.externalPersonId.trim() ||
        !Number.isSafeInteger(preference.individualId) || preference.individualId <= 0 ||
        (preference.familyId !== null && (!Number.isSafeInteger(preference.familyId) || preference.familyId <= 0)) ||
        (preference.sourceFingerprint != null && (typeof preference.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(preference.sourceFingerprint))) ||
        typeof preference.groupId !== 'string' || !preference.groupId.trim() || seen.has(preference.externalPersonId)) {
      throw invalid('The remembered LMPG household arrangement is invalid. Refresh the review.');
    }
    seen.add(preference.externalPersonId);
    return { externalPersonId: preference.externalPersonId, individualId: preference.individualId, familyId: preference.familyId, groupId: preference.groupId, sourceFingerprint: preference.sourceFingerprint ?? null };
  }).sort((a, b) => a.externalPersonId.localeCompare(b.externalPersonId, 'en'));
}

function householdIds(person) {
  return Array.isArray(person?.householdIds) && person.householdIds.every((id) => typeof id === 'string' && id.trim())
    ? [...new Set(person.householdIds)].sort() : null;
}

function participantGroupId(externalIds) {
  return `local-household:${crypto.createHash('sha256').update(JSON.stringify([...externalIds].sort())).digest('hex').slice(0, 24)}`;
}

/** Local arrangement choices never reinterpret or overwrite provider evidence. */
function projectHouseholdChoices(acquired, rawEdits = {}) {
  const edits = canonicalHouseholdChoices(rawEdits);
  if (acquired.provider !== 'planning_center') {
    if (Object.keys(edits).length) throw invalid('LMPG household choices are available only for Planning Center.');
    return acquired;
  }
  const basePreferences = canonicalPreferences(acquired.householdPreferences);
  const preferences = new Map(basePreferences.map((preference) => [preference.externalPersonId, preference]));
  const localPeople = new Map((acquired.individuals || []).map((person) => [Number(person.id), person]));
  const localFamilies = new Map((acquired.families || []).map((family) => [Number(family.id), family]));
  const externalLinks = new Map();
  const individualLinks = new Map();
  for (const link of acquired.personLinks || []) {
    const externalId = String(link.externalPersonId);
    const individualId = Number(link.individualId);
    if (!externalLinks.has(externalId)) externalLinks.set(externalId, new Set());
    externalLinks.get(externalId).add(individualId);
    if (!individualLinks.has(individualId)) individualLinks.set(individualId, new Set());
    individualLinks.get(individualId).add(externalId);
  }
  const establishedId = (externalId) => {
    const ids = externalLinks.get(externalId);
    if (ids?.size !== 1) return null;
    const id = [...ids][0];
    return individualLinks.get(id)?.size === 1 && localPeople.has(id) ? id : null;
  };
  const sourceIds = new Set();
  const eligibleSets = acquired.eligibleByBatch instanceof Map ? acquired.eligibleByBatch.values() : Object.values(acquired.eligibleByBatch || {});
  for (const ids of eligibleSets) for (const id of ids) sourceIds.add(String(id));
  const directory = new Map();
  for (const list of [acquired.snapshot.people, acquired.ineligibleMemberPeople, acquired.contextPeople, acquired.matchingPeople]) {
    for (const person of list || []) if (!directory.has(String(person.id))) directory.set(String(person.id), person);
  }
  const localHouseholdExternalIds = new Set(preferences.keys());
  for (const [id, person] of directory) if ((householdIds(person)?.length || 0) > 1 && establishedId(id) !== null) localHouseholdExternalIds.add(id);
  const externalFamilies = new Map((acquired.snapshot.families || []).map((family) => [String(family.id), family]));
  const sourceFingerprints = new Map();
  for (const id of new Set([...directory.keys(), ...preferences.keys()])) {
    const ids = householdIds(directory.get(id));
    let evidence = ids && acquired.snapshot.complete !== false ? [] : null;
    for (const householdId of ids || []) {
      const family = externalFamilies.get(householdId);
      const members = family?.householdMemberExternalIds ?? family?.memberExternalIds;
      if (!Array.isArray(members) || members.some((memberId) => typeof memberId !== 'string' || !memberId.trim()) || !members.includes(id)) {
        evidence = null;
        break;
      }
      if (evidence) evidence.push({ householdId, members: [...new Set(members)].sort() });
    }
    sourceFingerprints.set(id, evidence === null ? null : crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex'));
  }
  const localInvalidReasons = new Map();
  const sourceChangedIds = new Set();
  for (const [id, saved] of preferences) {
    const local = localPeople.get(saved.individualId);
    const familyId = local?.familyId == null ? null : Number(local.familyId);
    if (establishedId(id) !== saved.individualId) localInvalidReasons.set(id, 'The established LMPG person link has changed. Forget this arrangement before choosing again.');
    else if (familyId !== saved.familyId || saved.familyId !== null && !localFamilies.has(saved.familyId)) localInvalidReasons.set(id, 'The remembered LMPG family has changed or was deleted. Forget this arrangement before choosing again.');
    else if (sourceFingerprints.get(id) !== null && sourceFingerprints.get(id) !== saved.sourceFingerprint) sourceChangedIds.add(id);
  }
  for (const id of sourceChangedIds) localHouseholdExternalIds.delete(id);

  const participantsByGroup = new Map();
  const newGroupsByMembership = new Map();
  for (const id of [...sourceIds].sort()) {
    const saved = preferences.get(id);
    if (saved) {
      if (!participantsByGroup.has(saved.groupId)) participantsByGroup.set(saved.groupId, []);
      participantsByGroup.get(saved.groupId).push(id);
    } else if (establishedId(id) !== null) {
      const ids = householdIds(directory.get(id));
      if (!ids || ids.length <= 1) continue;
      const membershipKey = JSON.stringify(ids);
      if (!newGroupsByMembership.has(membershipKey)) newGroupsByMembership.set(membershipKey, []);
      newGroupsByMembership.get(membershipKey).push(id);
    }
  }
  for (const ids of newGroupsByMembership.values()) participantsByGroup.set(participantGroupId(ids), ids);
  const groups = [...participantsByGroup].map(([id, participantIds]) => {
    let invalidReason = null;
    const people = participantIds.map((externalPersonId) => {
      const saved = preferences.get(externalPersonId);
      const individualId = saved?.individualId ?? establishedId(externalPersonId);
      const local = localPeople.get(individualId);
      const source = directory.get(externalPersonId);
      const currentFamilyId = local?.familyId == null ? null : Number(local.familyId);
      invalidReason ||= localInvalidReasons.get(externalPersonId) || null;
      if (currentFamilyId !== null && !localFamilies.has(currentFamilyId)) invalidReason ||= 'The current LMPG family is unavailable. Review the local person record before choosing again.';
      return { externalPersonId, individualId, firstName: source?.firstName || local?.firstName || '', lastName: source?.lastName || local?.lastName || '',
        currentFamilyId, currentFamilyName: localFamilies.get(currentFamilyId)?.familyName || null, sourceFingerprint: sourceFingerprints.get(externalPersonId) ?? null };
    });
    if (participantIds.some((personId) => sourceFingerprints.get(personId) == null)) invalidReason ||= 'Planning Center household membership is missing or incomplete. Refresh the source before choosing an arrangement.';
    const sourceChanged = !invalidReason && participantIds.some((personId) => sourceChangedIds.has(personId));
    if (sourceChanged) invalidReason = 'Planning Center household membership changed. Review the updated household.';
    const sourceHouseholdIds = new Set(participantIds.flatMap((personId) => householdIds(directory.get(personId)) || []));
    for (const [familyId, family] of externalFamilies) {
      if ((family.householdMemberExternalIds || family.memberExternalIds || []).some((memberId) => participantIds.includes(String(memberId)))) sourceHouseholdIds.add(familyId);
    }
    const sourceHouseholds = [...sourceHouseholdIds].sort().map((externalFamilyId) => {
      const family = externalFamilies.get(externalFamilyId);
      const memberIds = new Set((family?.householdMemberExternalIds || family?.memberExternalIds || []).map(String));
      for (const personId of participantIds) if (householdIds(directory.get(personId))?.includes(externalFamilyId)) memberIds.add(personId);
      return { externalFamilyId, name: family?.name || family?.familyName || externalFamilyId,
        members: [...memberIds].sort().map((externalPersonId) => ({ externalPersonId, firstName: directory.get(externalPersonId)?.firstName || '',
          lastName: directory.get(externalPersonId)?.lastName || '', inSource: sourceIds.has(externalPersonId) })) };
    });
    const familyIds = new Set(people.map((person) => person.currentFamilyId));
    const sharedFamilyId = familyIds.size === 1 ? people[0].currentFamilyId : null;
    const saved = participantIds.some((personId) => preferences.has(personId));
    const displayName = localFamilies.get(sharedFamilyId)?.familyName || '';
    const usableName = (name) => name && !/^unknown(?:\s+(?:household|family))?$/i.test(name.trim());
    const sourceNames = [...new Set(sourceHouseholds.map((household) => household.name.trim()))];
    const suggestedName = sourceNames.length === 1 && usableName(sourceNames[0])
      ? sourceNames[0] : usableName(displayName) ? displayName : buildFamilyName(people);
    return { id, people, sourceHouseholds, selectedDestination: saved && !invalidReason && sharedFamilyId !== null ? { kind: 'existing', familyId: sharedFamilyId } : { kind: 'keep' },
      displayName, suggestedName, saved, sourceChanged, invalidReason };
  }).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const explicitNamesByFamily = new Map();
  const decisions = Object.entries(edits).map(([groupId, choice]) => {
    const group = groupsById.get(groupId);
    if (!group) throw invalid('This LMPG household group is no longer available. Refresh the review.');
    const { destination } = choice;
    if (group.invalidReason && !group.sourceChanged && destination.kind !== 'forget') throw invalid(group.invalidReason);
    if (destination.kind !== 'forget') for (const person of group.people) localHouseholdExternalIds.add(person.externalPersonId);
    let targetFamilyId = null;
    if (destination.kind === 'existing') {
      if (!localFamilies.has(destination.familyId)) throw invalid('The selected LMPG family is no longer available. Refresh the review.');
      targetFamilyId = destination.familyId;
    } else if (destination.kind === 'keep') {
      const ids = new Set(group.people.map((person) => person.currentFamilyId));
      if (ids.size === 1) targetFamilyId = group.people[0].currentFamilyId;
      if (choice.displayName && targetFamilyId === null) throw invalid('A name can be changed while keeping this arrangement only when everyone shares one LMPG family.');
    }
    const resolvedName = choice.displayName || null;
    if (resolvedName && targetFamilyId !== null) {
      const prior = explicitNamesByFamily.get(targetFamilyId);
      if (prior && prior !== resolvedName) throw invalid('Choose one LMPG name for each destination family across all cards.');
      explicitNamesByFamily.set(targetFamilyId, resolvedName);
    }
    return { groupId, destination, resolvedName, fromName: localFamilies.get(targetFamilyId)?.familyName || null,
      people: group.people.map((person) => ({ externalPersonId: person.externalPersonId, individualId: person.individualId, fromFamilyId: person.currentFamilyId, sourceFingerprint: person.sourceFingerprint })) };
  });
  const familyOptions = [...localFamilies.values()].sort((a, b) => Number(a.id) - Number(b.id)).map((family) => ({
    id: Number(family.id), familyName: family.familyName,
    memberNames: [...localPeople.values()].filter((person) => Number(person.familyId) === Number(family.id))
      .map((person) => [person.firstName, person.lastName].filter(Boolean).join(' ').trim()).filter(Boolean).sort((a, b) => a.localeCompare(b, 'en')),
  }));
  return { ...acquired, localHouseholdExternalIds,
    householdChoiceContext: { version: 2, groups, localFamilies: familyOptions, edits, basePreferences, decisions } };
}

function decorateHouseholdChoicePlan(plan, acquired) {
  return acquired.householdChoiceContext ? { ...plan, householdChoices: acquired.householdChoiceContext } : plan;
}

module.exports = { canonicalHouseholdChoices, canonicalPreferences, projectHouseholdChoices, decorateHouseholdChoicePlan };
