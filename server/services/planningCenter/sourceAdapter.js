'use strict';

const { createPcoReadClient, PcoSourceError } = require('./readClient');
const { projectPerson, toNormalizedPcoPerson, projectPcoHouseholds } = require('./projection');

const API = 'https://api.planningcenteronline.com/people/v2';

function unavailable(message) {
  return new PcoSourceError(message, 'SYNC_SOURCE_UNAVAILABLE', {});
}

function finiteIntegerOrNull(value) {
  return Number.isFinite(value) && Number.isInteger(value) ? value : null;
}

function validIsoOrNull(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function listDto(resource) {
  const id = resource && resource.id;
  const externalId = id === null || id === undefined ? '' : String(id).trim();
  const name = String(resource && resource.attributes && resource.attributes.name || '').trim();
  const attributes = resource && resource.attributes || {};
  if (!resource || resource.type !== 'List' || !externalId || !name || attributes.invalid === true) return null;
  return {
    kind: 'planning_center_list',
    externalId,
    name,
    memberCount: finiteIntegerOrNull(attributes.total_people),
    providerRefreshedAt: validIsoOrNull(attributes.refreshed_at),
  };
}

function createClient(options, requestScope = 'account') {
  return options.client || createPcoReadClient({
    accessToken: options.accessToken,
    request: options.request,
    sleep: options.sleep,
    maxRetries: options.maxRetries,
    signal: options.signal,
    // Account-wide calls must surface invalid/revoked credentials, while a
    // membership call after a successful stable-ID List resolution can safely
    // treat a 403 as a source-specific visibility failure.
    requestScope,
  });
}

async function listPlanningCenterSources(options = {}) {
  const client = createClient(options, 'account');
  const result = await client.getAll(`${API}/lists?per_page=100`);
  return result.items.map(listDto).filter(Boolean).sort((left, right) =>
    left.name.localeCompare(right.name) || left.externalId.localeCompare(right.externalId)
  );
}

function assertResolvableList(resource, expectedExternalId) {
  const dto = listDto(resource);
  const attributes = resource && resource.attributes || {};
  if (!dto || dto.externalId !== expectedExternalId || attributes.archived === true ||
      attributes.archived_at !== null && attributes.archived_at !== undefined || attributes.status === 'archived') {
    throw unavailable('Planning Center List source is unavailable');
  }
  return dto;
}

function mapIncluded(included, fieldDataById, primaryContacts, householdNames, householdMembers, contextById, memberIds) {
  for (const resource of Array.isArray(included) ? included : []) {
    if (!resource || typeof resource !== 'object') continue;
    if (resource.type === 'FieldDatum' && resource.id) {
      fieldDataById.set(resource.id, resource);
    } else if (resource.type === 'Household' && resource.id) {
      const attributes = resource.attributes || {};
      const name = String(attributes.name ?? '').trim();
      if (name && householdNames.get(resource.id) && householdNames.get(resource.id) !== name) {
        throw new PcoSourceError('Planning Center household names disagree', 'SYNC_SOURCE_INCOMPLETE', {});
      }
      if (name || !householdNames.has(resource.id)) householdNames.set(resource.id, name);
      if (attributes.primary_contact_id) primaryContacts.set(resource.id, attributes.primary_contact_id);
      const people = resource.relationships?.people?.data;
      if (resource.relationships?.people && (!Array.isArray(people) || people.some(person => person?.type !== 'Person' || !String(person?.id ?? '').trim()))) {
        throw new PcoSourceError('Planning Center household roster is malformed', 'SYNC_SOURCE_INCOMPLETE', {});
      }
      if (Array.isArray(people)) {
        const ids = [...new Set(people.map(person => String(person.id).trim()))].sort();
        const count = attributes.member_count;
        if (count != null && (!Number.isInteger(count) || count !== ids.length)) {
          throw new PcoSourceError('Planning Center household roster is incomplete', 'SYNC_SOURCE_INCOMPLETE', {});
        }
        if (householdMembers.has(resource.id) && JSON.stringify(householdMembers.get(resource.id)) !== JSON.stringify(ids)) {
          throw new PcoSourceError('Planning Center household rosters disagree', 'SYNC_SOURCE_INCOMPLETE', {});
        }
        // Retain only identity references for the review display. Do not fill in
        // an included Person's unknown household membership from this relation.
        householdMembers.set(resource.id, ids);
      }
    }
  }
  for (const resource of Array.isArray(included) ? included : []) {
    if (!resource || resource.type !== 'Person' || !resource.id || memberIds.has(String(resource.id))) continue;
    // Project contextual people while this page's FieldDatum map is still
    // available; retain neither their raw provider record nor raw page data.
    contextById.set(String(resource.id), projectPerson(resource, fieldDataById));
  }
}

// Included identities may become members on later pages. Keep their explicit
// evidence so membership/context deduplication cannot hide a contradiction.
function observePersonEvidence(envelope, observations) {
  const people = Array.isArray(envelope.data) ? envelope.data : [envelope.data];
  for (const resource of [...people, ...(Array.isArray(envelope.included) ? envelope.included : [])]) {
    if (resource?.type !== 'Person' || !resource.id) continue;
    const values = {};
    if (['active', 'inactive'].includes(resource.attributes?.status)) values.status = resource.attributes.status;
    if (typeof resource.attributes?.child === 'boolean') values.child = resource.attributes.child;
    const memberships = resource.relationships?.households?.data;
    if (Array.isArray(memberships) && memberships.every(household => household?.id)) {
      values.households = JSON.stringify([...new Set(memberships.map(household => String(household.id)))].sort());
    }
    for (const [field, value] of Object.entries(values)) {
      const key = `${resource.id}:${field}`;
      if (observations.has(key) && observations.get(key) !== value) {
        throw new PcoSourceError('Planning Center person observations disagree', 'SYNC_SOURCE_INCOMPLETE', {});
      }
      observations.set(key, value);
    }
  }
}

async function fetchPlanningCenterSourceSnapshot(options = {}) {
  const sourceKind = options.sourceKind;
  const sourceExternalId = options.sourceExternalId === null || options.sourceExternalId === undefined
    ? '' : String(options.sourceExternalId).trim();
  if (sourceKind !== 'planning_center_list' || !sourceExternalId) throw unavailable('Planning Center List source is unavailable');

  const resolvingClient = createClient(options, 'account');
  const resolved = await resolvingClient.getJson(`${API}/lists/${encodeURIComponent(sourceExternalId)}`);
  const source = assertResolvableList(resolved.data, sourceExternalId);
  const client = createClient(options, 'source');

  const membersById = new Map();
  const contextById = new Map();
  const memberIds = new Set();
  const primaryContacts = new Map();
  const householdNames = new Map();
  const householdMembers = new Map();
  const personStates = new Map();
  const memberUrl = `${API}/lists/${encodeURIComponent(sourceExternalId)}/people?per_page=100&include=households.people,field_data`;

  await client.getAll(memberUrl, async (envelope) => {
    observePersonEvidence(envelope, personStates);
    const fieldDataById = new Map();
    const pageMembers = Array.isArray(envelope.data) ? envelope.data : [];
    for (const resource of pageMembers) {
      const id = resource && resource.id !== null && resource.id !== undefined ? String(resource.id).trim() : '';
      if (!resource || resource.type !== 'Person' || !id) {
        throw new PcoSourceError('Planning Center List membership contains a malformed Person resource', 'SYNC_SOURCE_INCOMPLETE', {});
      }
      memberIds.add(id);
    }
    mapIncluded(envelope.included, fieldDataById, primaryContacts, householdNames, householdMembers, contextById, memberIds);
    for (const resource of pageMembers) {
      const id = String(resource.id).trim();
      membersById.set(id, projectPerson(resource, fieldDataById));
      contextById.delete(id);
    }
  });

  // An included context Person can be observed before it appears as a source
  // member on a later page. Source membership always wins that race.
  for (const memberId of memberIds) contextById.delete(memberId);
  const memberRawPeople = [...membersById.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const contextRawPeople = [...contextById.values()]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const people = memberRawPeople.map(toNormalizedPcoPerson);
  const contextPeople = contextRawPeople.map(toNormalizedPcoPerson);

  return {
    provider: 'planning_center',
    source,
    complete: true,
    fetchedAt: new Date().toISOString(),
    memberExternalIds: [...memberIds].sort(),
    people,
    contextPeople,
    families: projectPcoHouseholds([...memberRawPeople, ...contextRawPeople], primaryContacts, householdNames, householdMembers),
  };
}

async function fetchPlanningCenterAllSnapshot(options = {}) {
  const client = createClient(options, 'account');
  const membersById = new Map();
  const contextById = new Map();
  const memberIds = new Set();
  const primaryContacts = new Map();
  const householdNames = new Map();
  const householdMembers = new Map();
  const personStates = new Map();

  const include = options.includeFieldData === false ? 'households.people' : 'households.people,field_data';
  await client.getAll(`${API}/people?per_page=100&include=${include}`, async (envelope) => {
    observePersonEvidence(envelope, personStates);
    const fieldDataById = new Map();
    const pageMembers = Array.isArray(envelope.data) ? envelope.data : [];
    for (const resource of pageMembers) {
      const id = resource && resource.id !== null && resource.id !== undefined ? String(resource.id).trim() : '';
      if (!resource || resource.type !== 'Person' || !id) {
        throw new PcoSourceError('Planning Center people response contains a malformed Person resource', 'SYNC_SOURCE_INCOMPLETE', {});
      }
      memberIds.add(id);
    }
    mapIncluded(envelope.included, fieldDataById, primaryContacts, householdNames, householdMembers, contextById, memberIds);
    for (const resource of pageMembers) {
      const id = String(resource.id).trim();
      membersById.set(id, projectPerson(resource, fieldDataById));
      contextById.delete(id);
    }
  });

  for (const memberId of memberIds) contextById.delete(memberId);
  const memberRawPeople = [...membersById.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const contextRawPeople = [...contextById.values()]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));

  return {
    provider: 'planning_center',
    source: { kind: 'all', externalId: 'all', name: 'Everyone', memberCount: memberIds.size, providerRefreshedAt: null },
    complete: true,
    fetchedAt: new Date().toISOString(),
    memberExternalIds: [...memberIds].sort(),
    people: memberRawPeople.map(toNormalizedPcoPerson),
    contextPeople: contextRawPeople.map(toNormalizedPcoPerson),
    families: projectPcoHouseholds([...memberRawPeople, ...contextRawPeople], primaryContacts, householdNames, householdMembers),
  };
}

// Lists often exclude inactive people. Read established identities explicitly
// so leaving a List cannot hide an inactive status from lifecycle sync. Large
// sets use directory pages to avoid hundreds of sequential requests; any ID
// absent from that directory still requires a direct lookup. These records
// are not evidence of membership in any configured source.
async function fetchPlanningCenterLinkedSnapshot(options = {}) {
  const ids = [...new Set((options.externalPersonIds || []).map(id => String(id ?? '').trim()))].sort();
  if (ids.some(id => !id)) {
    throw new PcoSourceError('Planning Center linked person ID is missing', 'SYNC_SOURCE_INCOMPLETE', {});
  }
  const client = createClient(options, 'account');
  const requestedIds = new Set(ids);
  const peopleById = new Map();
  const contextById = new Map();
  const primaryContacts = new Map();
  const householdNames = new Map();
  const householdMembers = new Map();
  const personStates = new Map();

  function collect(envelope, resources, directoryPage = false) {
    for (const resource of resources) {
      if (!resource || resource.type !== 'Person' || !requestedIds.has(String(resource.id)) ||
        !['active', 'inactive'].includes(resource.attributes?.status) ||
        typeof resource.attributes?.child !== 'boolean' ||
        typeof resource.attributes?.first_name !== 'string' ||
        !(typeof resource.attributes?.last_name === 'string' || resource.attributes?.last_name === null)) {
        throw new PcoSourceError('Planning Center linked person response is incomplete', 'SYNC_SOURCE_INCOMPLETE', {});
      }
    }
    const householdIds = new Set(resources.flatMap(resource => {
      const memberships = resource.relationships?.households?.data;
      return Array.isArray(memberships) ? memberships.map(household => String(household?.id)) : [];
    }));
    const pageIncluded = Array.isArray(envelope.included) ? envelope.included : [];
    const householdRelatives = new Set(pageIncluded.filter(resource =>
      resource?.type === 'Household' && householdIds.has(String(resource.id)))
      .flatMap(resource => Array.isArray(resource.relationships?.people?.data)
        ? resource.relationships.people.data.map(person => String(person?.id)) : []));
    const included = !directoryPage ? pageIncluded : pageIncluded.filter(resource => resource?.type === 'FieldDatum' ||
      (resource?.type === 'Household' && householdIds.has(String(resource.id))) ||
      (resource?.type === 'Person' && (requestedIds.has(String(resource.id)) || householdRelatives.has(String(resource.id)) ||
        (Array.isArray(resource.relationships?.households?.data) &&
          resource.relationships.households.data.some(household => householdIds.has(String(household?.id)))))));
    observePersonEvidence(envelope, personStates);
    const fieldDataById = new Map();
    mapIncluded(included, fieldDataById, primaryContacts, householdNames, householdMembers, contextById, requestedIds);
    for (const resource of resources) peopleById.set(String(resource.id), projectPerson(resource, fieldDataById));
  }

  if (ids.length > 100) {
    await client.getAll(`${API}/people?per_page=100&include=households.people,field_data`, envelope => {
      collect(envelope, envelope.data.filter(resource => requestedIds.has(String(resource?.id))), true);
    });
  }
  for (const id of ids) {
    if (peopleById.has(id)) continue;
    options.signal?.throwIfAborted();
    const envelope = await client.getJson(`${API}/people/${encodeURIComponent(id)}?include=households.people,field_data`);
    options.signal?.throwIfAborted();
    if (String(envelope.data?.id) !== id) {
      throw new PcoSourceError('Planning Center linked person response is incomplete', 'SYNC_SOURCE_INCOMPLETE', {});
    }
    collect(envelope, [envelope.data]);
  }
  const people = ids.map(id => peopleById.get(id));
  for (const person of people) for (const householdId of person.householdIds || []) {
    const roster = householdMembers.get(householdId);
    if (!roster || !roster.includes(String(person.id))) {
      throw new PcoSourceError('Planning Center linked household roster is incomplete', 'SYNC_SOURCE_INCOMPLETE', {});
    }
  }
  const contextPeople = [...contextById.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return {
    provider: 'planning_center',
    complete: true,
    fetchedAt: new Date().toISOString(),
    people: people.map(toNormalizedPcoPerson),
    contextPeople: contextPeople.map(toNormalizedPcoPerson),
    families: projectPcoHouseholds([...people, ...contextPeople], primaryContacts, householdNames, householdMembers),
  };
}

module.exports = {
  listPlanningCenterSources,
  fetchPlanningCenterSourceSnapshot,
  fetchPlanningCenterAllSnapshot,
  fetchPlanningCenterLinkedSnapshot,
  finiteIntegerOrNull,
  validIsoOrNull,
};
