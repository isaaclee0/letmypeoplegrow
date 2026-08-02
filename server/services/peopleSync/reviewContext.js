'use strict';

const crypto = require('node:crypto');
const { desiredPeopleType } = require('./plan');
const { canonicalLinkCorrections } = require('./linkCorrections');

const DECISION_CONTRACT_VERSION = 2;

function text(value) {
  return value === null || value === undefined ? '' : String(value);
}

function externalId(value) {
  const id = text(value);
  return id || null;
}

function individualId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function compareText(left, right) {
  return text(left).localeCompare(text(right), 'en');
}

function sortedUniqueIds(values, normalize, compare) {
  return [...new Set((values || []).map(normalize).filter((value) => value !== null))].sort(compare);
}

function eligibleManualIds(localPeople, personLinks) {
  const durableLinkedIds = new Set((personLinks || []).map((link) => individualId(link?.individualId)).filter(Boolean));
  return sortedUniqueIds(localPeople, (person) => {
    const id = individualId(person?.id);
    return id !== null && !durableLinkedIds.has(id) ? id : null;
  }, (left, right) => left - right);
}

function batchesFor(externalPersonId, batches, eligibleByBatch) {
  const source = eligibleByBatch instanceof Map ? eligibleByBatch : new Map(Object.entries(eligibleByBatch || {}));
  return (batches || []).filter((batch) => {
    const ids = source.get(batch?.id);
    const values = ids instanceof Set ? [...ids] : Array.isArray(ids) ? ids : [];
    return values.some((id) => externalId(id) === externalPersonId);
  });
}

function byExternalId(people) {
  const result = new Map();
  for (const person of people || []) {
    const id = externalId(person?.id);
    if (!id || result.has(id)) continue;
    result.set(id, person);
  }
  return result;
}

function reviewableExternalIds(plan) {
  const ids = [];
  for (const action of plan?.linkPeople || []) ids.push(externalId(action?.externalPersonId));
  for (const action of plan?.ambiguousPeople || []) ids.push(externalId(action?.externalPersonId));
  for (const action of plan?.addPeople || []) ids.push(externalId(action?.externalPersonId));
  return sortedUniqueIds(ids, (id) => id, compareText);
}

function actionCandidates(plan, externalPersonId) {
  const candidates = [];
  for (const action of plan?.linkPeople || []) {
    if (externalId(action?.externalPersonId) === externalPersonId) candidates.push(individualId(action?.individualId));
  }
  for (const action of plan?.ambiguousPeople || []) {
    if (externalId(action?.externalPersonId) !== externalPersonId) continue;
    candidates.push(...(action?.candidateIndividualIds || []).map(individualId));
  }
  return sortedUniqueIds(candidates, (id) => id, (left, right) => left - right);
}

function suggestedIndividualId(plan, externalPersonId, candidates) {
  const proposed = (plan?.linkPeople || [])
    .filter((action) => externalId(action?.externalPersonId) === externalPersonId)
    .map((action) => individualId(action?.individualId))
    .filter(Boolean)
    .sort((left, right) => left - right);
  if (proposed.length > 0) return proposed[0];
  return candidates.length === 1 ? candidates[0] : null;
}

function excludedByExternalId(exclusions) {
  const result = new Map();
  for (const exclusion of exclusions || []) {
    const personId = externalId(exclusion?.externalPersonId);
    const localId = individualId(exclusion?.individualId);
    if (!personId || !localId) continue;
    if (!result.has(personId)) result.set(personId, []);
    result.get(personId).push(localId);
  }
  for (const [personId, ids] of result) result.set(personId, sortedUniqueIds(ids, (id) => id, (left, right) => left - right));
  return result;
}

function heldExternalIds(holds) {
  return new Set((holds || []).map((hold) => externalId(hold?.externalPersonId)).filter(Boolean));
}

function createPerson(externalPerson, qualifyingBatches) {
  if (!externalPerson) return null;
  return {
    firstName: text(externalPerson.firstName),
    lastName: text(externalPerson.lastName),
    isChild: typeof externalPerson.child === 'boolean' ? externalPerson.child : null,
    externalFamilyId: externalPerson.familyId === undefined ? null : externalPerson.familyId,
    peopleType: desiredPeopleType(externalPerson, qualifyingBatches),
  };
}

function establishedLinksForSource(personLinks, sourceExternalIds) {
  const sourceIds = sourceExternalIds instanceof Set
    ? sourceExternalIds
    : new Set(sourceExternalIds || []);
  return Object.fromEntries((personLinks || [])
    .map((link) => [externalId(link?.externalPersonId), individualId(link?.individualId)])
    .filter(([personId, localId]) => personId !== null && localId !== null && sourceIds.has(personId))
    .sort(([left], [right]) => compareText(left, right))
    .map(([personId, localId]) => [personId, { individualId: localId }]));
}

function buildReviewContext(input = {}) {
  const basePersonLinks = input.basePersonLinks ?? input.personLinks ?? [];
  const projectedPersonLinks = input.projectedPersonLinks ?? basePersonLinks;
  const baseExclusions = input.baseExclusions ?? input.exclusions ?? [];
  const projectedExclusions = input.projectedExclusions ?? baseExclusions;
  const baseHolds = input.baseHolds ?? input.holds ?? [];
  const projectedHolds = input.projectedHolds ?? baseHolds;
  const externalPeople = byExternalId(input.externalPeople);
  const excluded = excludedByExternalId(projectedExclusions);
  const held = heldExternalIds(projectedHolds);
  const identities = {};
  for (const id of reviewableExternalIds(input.plan)) {
    const candidates = actionCandidates(input.plan, id);
    identities[id] = {
      suggestedIndividualId: suggestedIndividualId(input.plan, id, candidates),
      candidateIndividualIds: candidates,
      excludedIndividualIds: excluded.get(id) || [],
      held: held.has(id),
      canCreate: true,
      createPerson: createPerson(externalPeople.get(id), batchesFor(id, input.batches, input.eligibleByBatch)),
    };
  }
  return {
    version: DECISION_CONTRACT_VERSION,
    correctionContractVersion: 1,
    manualCandidateIndividualIds: eligibleManualIds(input.localPeople, projectedPersonLinks),
    localIdentityDigest: buildLocalIdentityDigest({
      localPeople: input.localPeople,
      localFamilies: input.localFamilies,
      personLinks: basePersonLinks,
      exclusions: baseExclusions,
      holds: baseHolds,
    }),
    establishedLinks: establishedLinksForSource(basePersonLinks, input.sourceExternalIds),
    projectedEstablishedLinks: establishedLinksForSource(projectedPersonLinks, input.sourceExternalIds),
    linkCorrections: canonicalLinkCorrections(input.linkCorrections),
    identities,
  };
}

function safeName(person) {
  return { firstName: text(person?.firstName), lastName: text(person?.lastName) };
}

function familyIdState(person) {
  if (!person || !Object.hasOwn(person, 'familyId') || person.familyId === undefined) return { state: 'unavailable' };
  if (person.familyId === null) return { state: 'none' };
  return null;
}

function familyById(families) {
  const result = new Map();
  for (const family of families || []) {
    const id = externalId(family?.id);
    if (!id || result.has(id)) continue;
    result.set(id, family);
  }
  return result;
}

function sortedMembers(people, ids) {
  return [...(people || [])]
    .filter((person) => ids.has(externalId(person?.id)))
    .sort((left, right) => compareText(left?.firstName, right?.firstName) ||
      compareText(left?.lastName, right?.lastName) || compareText(left?.id, right?.id));
}

function knownFamily(person, people, families) {
  const id = externalId(person.familyId);
  const family = families.get(id);
  if (!family) return { state: 'unavailable' };
  const memberIds = new Set((family?.memberExternalIds || []).map(externalId).filter(Boolean));
  for (const member of people || []) {
    if (externalId(member?.familyId) === id) memberIds.add(externalId(member?.id));
  }
  memberIds.delete(externalId(person?.id));
  const otherMembers = sortedMembers(people, memberIds);
  return {
    state: 'known',
    name: text(family?.name ?? family?.familyName),
    members: otherMembers.slice(0, 3).map(safeName),
    totalOtherMembers: memberIds.size,
  };
}

function buildDirectoryEntries(people, families, { local = false, reviewContext } = {}) {
  const familyMap = familyById(families);
  const eligible = new Set(reviewContext?.manualCandidateIndividualIds || []);
  return Object.fromEntries((people || [])
    .map((person) => {
      const id = externalId(person?.id);
      return id ? [id, person] : null;
    })
    .filter(Boolean)
    .sort(([left], [right]) => compareText(left, right))
    .map(([id, person]) => {
      const unavailable = familyIdState(person);
      const entry = { ...safeName(person), family: unavailable || knownFamily(person, people, familyMap) };
      if (local) entry.matchEligible = eligible.has(individualId(person.id));
      return [id, entry];
    }));
}

function buildLocalIdentityDigest({
  localPeople = [],
  localFamilies = [],
  personLinks = [],
  exclusions = [],
  holds = [],
} = {}) {
  const manualCandidateIndividualIds = eligibleManualIds(localPeople, personLinks);
  const directory = buildDirectoryEntries(localPeople, localFamilies, {
    local: true,
    reviewContext: { manualCandidateIndividualIds },
  });
  const peopleById = new Map((localPeople || []).map((person) => [individualId(person?.id), person]));
  const people = Object.keys(directory).map(Number).sort((left, right) => left - right).map((id) => {
    const person = peopleById.get(id) || {};
    return {
      id,
      firstName: text(person.firstName),
      lastName: text(person.lastName),
      familyId: individualId(person.familyId),
      family: directory[String(id)].family,
      peopleType: text(person.peopleType),
      isChild: typeof person.isChild === 'boolean' ? person.isChild : null,
      isActive: typeof person.isActive === 'boolean' ? person.isActive : null,
      matchEligible: directory[String(id)].matchEligible === true,
    };
  });
  const familiesById = new Map();
  for (const family of localFamilies || []) {
    const id = individualId(family?.id);
    if (id !== null && !familiesById.has(id)) familiesById.set(id, family);
  }
  const families = [...familiesById.entries()]
    .sort(([left], [right]) => left - right)
    .map(([id, family]) => ({ id, familyName: text(family?.familyName ?? family?.name) }));
  const providerLinks = (personLinks || [])
    .map((link) => ({
      externalPersonId: externalId(link?.externalPersonId),
      individualId: individualId(link?.individualId),
      missingFullSyncCount: Number(link?.missingFullSyncCount ?? 0),
    }))
    .filter((link) => link.externalPersonId !== null && link.individualId !== null)
    .sort((left, right) => compareText(left.externalPersonId, right.externalPersonId) ||
      left.individualId - right.individualId);
  const durableExclusions = (exclusions || [])
    .map((exclusion) => ({
      externalPersonId: externalId(exclusion?.externalPersonId),
      individualId: individualId(exclusion?.individualId),
    }))
    .filter((exclusion) => exclusion.externalPersonId !== null && exclusion.individualId !== null)
    .sort((left, right) => compareText(left.externalPersonId, right.externalPersonId) ||
      left.individualId - right.individualId);
  const durableHolds = (holds || [])
    .map((hold) => ({
      externalPersonId: externalId(hold?.externalPersonId),
      reason: text(hold?.reason),
    }))
    .filter((hold) => hold.externalPersonId !== null && hold.reason.length > 0)
    .sort((left, right) => compareText(left.externalPersonId, right.externalPersonId) ||
      compareText(left.reason, right.reason));
  const contract = { people, families, providerLinks, durableExclusions, durableHolds };
  return crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

function buildReviewDirectory({ externalPeople = [], externalFamilies = [], localPeople = [], localFamilies = [], reviewContext = {} } = {}) {
  return {
    external: buildDirectoryEntries(externalPeople, externalFamilies),
    local: buildDirectoryEntries(localPeople, localFamilies, { local: true, reviewContext }),
  };
}

module.exports = {
  DECISION_CONTRACT_VERSION,
  buildLocalIdentityDigest,
  buildReviewContext,
  buildReviewDirectory,
};
