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

function mapIncluded(included, fieldDataById, primaryContacts, contextById, memberIds) {
  for (const resource of Array.isArray(included) ? included : []) {
    if (!resource || typeof resource !== 'object') continue;
    if (resource.type === 'FieldDatum' && resource.id) {
      fieldDataById.set(resource.id, resource);
    } else if (resource.type === 'Household' && resource.id && resource.attributes && resource.attributes.primary_contact_id) {
      primaryContacts.set(resource.id, resource.attributes.primary_contact_id);
    }
  }
  for (const resource of Array.isArray(included) ? included : []) {
    if (!resource || resource.type !== 'Person' || !resource.id || memberIds.has(String(resource.id))) continue;
    // Project contextual people while this page's FieldDatum map is still
    // available; retain neither their raw provider record nor raw page data.
    contextById.set(String(resource.id), projectPerson(resource, fieldDataById));
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
  const memberUrl = `${API}/lists/${encodeURIComponent(sourceExternalId)}/people?per_page=100&include=households.people,field_data`;

  await client.getAll(memberUrl, async (envelope) => {
    const fieldDataById = new Map();
    const pageMembers = Array.isArray(envelope.data) ? envelope.data : [];
    for (const resource of pageMembers) {
      const id = resource && resource.id !== null && resource.id !== undefined ? String(resource.id).trim() : '';
      if (!resource || resource.type !== 'Person' || !id) {
        throw new PcoSourceError('Planning Center List membership contains a malformed Person resource', 'SYNC_SOURCE_INCOMPLETE', {});
      }
      memberIds.add(id);
    }
    mapIncluded(envelope.included, fieldDataById, primaryContacts, contextById, memberIds);
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
    families: projectPcoHouseholds([...memberRawPeople, ...contextRawPeople], primaryContacts),
  };
}

module.exports = { listPlanningCenterSources, fetchPlanningCenterSourceSnapshot, finiteIntegerOrNull, validIsoOrNull };
