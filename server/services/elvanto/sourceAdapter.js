'use strict';

const {
  createElvantoClient,
  ELVANTO_AUTH,
  ELVANTO_UNAVAILABLE,
  ELVANTO_RESPONSE,
  ELVANTO_PAGINATION,
} = require('./httpClient');
const { normalizeSnapshot } = require('./normalizer');

const CATEGORY_ENDPOINT = { path: '/people/categories/getAll.json', collectionKey: 'categories', itemKey: 'category', kind: 'elvanto_category' };
const GROUP_ENDPOINT = { path: '/groups/getAll.json', collectionKey: 'groups', itemKey: 'group', kind: 'elvanto_group' };
const PEOPLE_PATH = '/people/getAll.json';
const PEOPLE_COLLECTION_KEY = 'people';
const PEOPLE_ITEM_KEY = 'person';
const SEARCH_PATH = '/people/search.json';
const PAGE_SIZE = 1000;
const MAX_PAGES = 1000;

function sourceError(message, code = 'SYNC_SOURCE_UNAVAILABLE') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function classifiedReadFailure(error, { sourceResolved = false } = {}) {
  const code = error && error.code;
  const status = error && error.details && error.details.status;
  if (code === 'SYNC_SOURCE_UNAVAILABLE' || code === 'SYNC_SOURCE_INCOMPLETE' ||
      code === 'SYNC_SOURCE_RATE_LIMIT' || code === 'SYNC_SOURCE_CHECK_FAILED') return error;
  if (code === ELVANTO_AUTH) {
    return sourceResolved && status === 403
      ? sourceError('Elvanto source is unavailable')
      : error;
  }
  if (code === ELVANTO_RESPONSE || code === ELVANTO_PAGINATION) {
    return sourceError('Elvanto source response is incomplete', 'SYNC_SOURCE_INCOMPLETE');
  }
  if (code === ELVANTO_UNAVAILABLE && status === 429) {
    return sourceError('Elvanto source read was rate limited', 'SYNC_SOURCE_RATE_LIMIT');
  }
  return sourceError('Elvanto source check failed', 'SYNC_SOURCE_CHECK_FAILED');
}

function stableId(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function sourceDto(raw, kind) {
  const externalId = stableId(raw && raw.id);
  const name = typeof (raw && raw.name) === 'string' ? raw.name.trim() : '';
  if (!externalId || !name) return null;
  return { kind, externalId, name, memberCount: null, providerRefreshedAt: null };
}

function sortSources(items) {
  return [...items].sort((left, right) => {
    const leftName = left.name.toLocaleLowerCase();
    const rightName = right.name.toLocaleLowerCase();
    return leftName.localeCompare(rightName) || left.externalId.localeCompare(right.externalId);
  });
}

function normalizeKindItems(items, kind) {
  const ids = new Set();
  const sources = [];
  for (const item of items || []) {
    const source = sourceDto(item, kind);
    if (!source) continue;
    if (ids.has(source.externalId)) {
      throw sourceError('Elvanto source enumeration contains a duplicate source ID', 'SYNC_SOURCE_INCOMPLETE');
    }
    ids.add(source.externalId);
    sources.push(source);
  }
  return sortSources(sources);
}

function sourceClient(options = {}) {
  if (options.client) return options.client;
  return createElvantoClient({
    apiKey: options.apiKey,
    request: options.request,
    sleep: options.sleep,
    maxRetries: options.maxRetries,
    now: options.now,
  });
}

async function fetchDefinitions(client, endpoint) {
  const result = await client.getAll(endpoint.path, {}, endpoint.collectionKey, endpoint.itemKey);
  return normalizeKindItems(result && result.items, endpoint.kind);
}

async function listElvantoSources(options = {}) {
  const client = sourceClient(options);
  const [categories, groups] = await Promise.all([
    fetchDefinitions(client, CATEGORY_ENDPOINT),
    fetchDefinitions(client, GROUP_ENDPOINT),
  ]);
  return [...categories, ...groups];
}

async function resolveSource(client, sourceKind, sourceExternalId) {
  const endpoint = sourceKind === CATEGORY_ENDPOINT.kind ? CATEGORY_ENDPOINT
    : sourceKind === GROUP_ENDPOINT.kind ? GROUP_ENDPOINT : null;
  const externalId = stableId(sourceExternalId);
  if (!endpoint || !externalId) throw sourceError('Elvanto source is unavailable');
  try {
    const sources = await fetchDefinitions(client, endpoint);
    const selected = sources.find((source) => source.externalId === externalId);
    if (!selected) throw sourceError('Elvanto source is unavailable');
    return selected;
  } catch (err) {
    // Resolving the category/group is an account-scoped enumeration read, so
    // a 403 here can be an invalid/revoked account credential. Do not turn it
    // into a source-specific absence before any source was resolved.
    throw classifiedReadFailure(err);
  }
}

function peopleFromSearch(data) {
  const collection = data && data.people;
  if (!collection || typeof collection !== 'object' || Array.isArray(collection)) {
    throw sourceError('Elvanto source membership response is malformed', 'SYNC_SOURCE_INCOMPLETE');
  }
  const raw = collection.person;
  const items = raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const total = Number.isInteger(collection.total) && collection.total >= 0 ? collection.total : null;
  return { items, total };
}

async function fetchGroupPeople(client, sourceExternalId) {
  const people = [];
  let total = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const data = await client.post(SEARCH_PATH, {
      'search[groups]': sourceExternalId,
      page,
      page_size: PAGE_SIZE,
    });
    const parsed = peopleFromSearch(data);
    if (total === null) total = parsed.total;
    else if (parsed.total !== null && total !== parsed.total) {
      throw sourceError('Elvanto source membership pagination changed during the read', 'SYNC_SOURCE_INCOMPLETE');
    }
    people.push(...parsed.items);
    if (total !== null ? people.length >= total : parsed.items.length === 0) return people;
  }
  throw sourceError('Elvanto source membership pagination did not complete safely', 'SYNC_SOURCE_INCOMPLETE');
}

function groupMembershipContext(rawPeople, sourceExternalId) {
  const memberships = new Map();
  for (const raw of rawPeople || []) {
    const id = stableId(raw && raw.id);
    if (id) memberships.set(id, { groups: [sourceExternalId] });
  }
  return memberships;
}

async function fetchElvantoSourceSnapshot(options = {}) {
  const client = sourceClient(options);
  const source = await resolveSource(client, options.sourceKind, options.sourceExternalId);
  let rawPeople;
  try {
    rawPeople = source.kind === CATEGORY_ENDPOINT.kind
      ? (await client.getAll(PEOPLE_PATH, { category_id: source.externalId }, PEOPLE_COLLECTION_KEY, PEOPLE_ITEM_KEY)).items
      : await fetchGroupPeople(client, source.externalId);
  } catch (err) {
    throw classifiedReadFailure(err, { sourceResolved: true });
  }

  if (!Array.isArray(rawPeople)) {
    throw sourceError('Elvanto source membership response is malformed', 'SYNC_SOURCE_INCOMPLETE');
  }
  const normalized = normalizeSnapshot(rawPeople, source.kind === GROUP_ENDPOINT.kind
    ? groupMembershipContext(rawPeople, source.externalId)
    : undefined);
  const normalizedIds = new Set(normalized.people.map((person) => stableId(person && person.id)));
  if (normalized.skipped.length > 0 || normalized.people.length !== rawPeople.length ||
      normalizedIds.size !== normalized.people.length || normalizedIds.has('')) {
    throw sourceError('Elvanto source membership contains malformed people', 'SYNC_SOURCE_INCOMPLETE');
  }
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  return {
    provider: 'elvanto',
    source,
    complete: true,
    fetchedAt: now().toISOString(),
    providerRefreshedAt: null,
    memberExternalIds: normalized.people.map((person) => person.id),
    people: normalized.people,
    contextPeople: [],
    families: normalized.families,
  };
}

module.exports = { listElvantoSources, fetchElvantoSourceSnapshot, sourceDto, normalizeKindItems };
