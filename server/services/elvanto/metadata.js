'use strict';

// Discovers Elvanto's batch-filter metadata. Live discovery calls only the
// three verified definition endpoints (categories, groups, custom fields).
// Service types, locations, and departments have no standalone list
// endpoints — those definitions come from the sanitized lists attached to
// the adapter snapshot (`snapshot.definitions`). Counts always come from
// tallied normalized people attributes, never from provider-reported counts.

const defaultConnectionStore = require('../peopleSync/connectionStore');

const DEFINITION_ENDPOINTS = {
  categories: { path: '/people/categories/getAll.json', collectionKey: 'categories', itemKey: 'category' },
  groups: { path: '/groups/getAll.json', collectionKey: 'groups', itemKey: 'group' },
  customFields: {
    path: '/people/customFields/getAll.json',
    collectionKey: 'custom_fields',
    itemKey: 'custom_field',
  },
};

// Elvanto is known to send a collection containing exactly one item as a
// bare object instead of a one-element array (see httpClient.js's getAll()
// header note, which already handles this for the outer items list). The
// same behaviour shows up in *nested* item fields — e.g. a custom field
// with a single selectable value — so this single helper is reused for
// every such object-or-array field rather than re-deriving the same
// null/array/bare-object handling per field.
function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function stableId(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function labelOf(raw) {
  return raw && typeof raw.name === 'string' ? raw.name.trim() : '';
}

// Sorts by case-insensitive label, then by ID as a tiebreaker.
function sortByLabelThenId(items, labelKey = 'name', idKey = 'id') {
  return [...items].sort((a, b) => {
    const labelA = String(a[labelKey] ?? '').toLowerCase();
    const labelB = String(b[labelKey] ?? '').toLowerCase();
    if (labelA !== labelB) return labelA < labelB ? -1 : 1;
    const idA = String(a[idKey] ?? '');
    const idB = String(b[idKey] ?? '');
    if (idA === idB) return 0;
    return idA < idB ? -1 : 1;
  });
}

// demographics/departments have no ID at all, so they sort by their own
// value as both label and tiebreaker.
function sortByValue(items) {
  return [...items].sort((a, b) => {
    const valueA = String(a.value ?? '');
    const valueB = String(b.value ?? '');
    const lowerA = valueA.toLowerCase();
    const lowerB = valueB.toLowerCase();
    if (lowerA !== lowerB) return lowerA < lowerB ? -1 : 1;
    if (valueA === valueB) return 0;
    return valueA < valueB ? -1 : 1;
  });
}

function peopleFrom(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  if (snapshot && Array.isArray(snapshot.people)) return snapshot.people;
  return [];
}

function definitionsFrom(snapshot) {
  if (!snapshot || Array.isArray(snapshot) || !snapshot.definitions || typeof snapshot.definitions !== 'object') {
    return { serviceTypes: [], locations: [], departments: [] };
  }
  return {
    serviceTypes: asArray(snapshot.definitions.serviceTypes),
    locations: asArray(snapshot.definitions.locations),
    departments: asArray(snapshot.definitions.departments),
  };
}

function tallyBy(people, picker) {
  const counts = new Map();
  for (const person of people) {
    for (const raw of picker(person) || []) {
      const key = stableId(raw);
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

function buildCategories(rawItems) {
  const categories = asArray(rawItems)
    .map((raw) => ({ id: stableId(raw && raw.id), name: labelOf(raw) }))
    .filter((item) => item.id);
  return sortByLabelThenId(categories);
}

function buildGroups(rawItems, people) {
  const counts = tallyBy(people, (person) => person && person.attributes && person.attributes.groups);
  const groups = asArray(rawItems)
    .map((raw) => {
      const id = stableId(raw && raw.id);
      return {
        id,
        name: labelOf(raw),
        status: raw && typeof raw.status === 'string' ? raw.status : null,
        memberCount: counts.get(id) || 0,
      };
    })
    .filter((item) => item.id);
  return sortByLabelThenId(groups);
}

function buildServiceTypes(definitionItems) {
  const items = asArray(definitionItems)
    .map((raw) => ({ id: stableId(raw && raw.id), name: labelOf(raw) }))
    .filter((item) => item.id);
  return sortByLabelThenId(items);
}

function buildLocations(definitionItems) {
  const items = asArray(definitionItems)
    .map((raw) => ({ id: stableId(raw && raw.id), name: labelOf(raw) }))
    .filter((item) => item.id);
  return sortByLabelThenId(items);
}

// Departments stay name-based. Definition names come from the snapshot;
// counts are tallied from normalized people attributes.
function buildDepartments(definitionNames, people) {
  const counts = tallyBy(people, (person) => person && person.attributes && person.attributes.departments);
  const names = asArray(definitionNames)
    .map((raw) => {
      if (typeof raw === 'string') return raw.trim();
      if (raw && typeof raw.name === 'string') return raw.name.trim();
      if (raw && typeof raw.value === 'string') return raw.value.trim();
      return '';
    })
    .filter(Boolean);
  const departments = [...new Set(names)].map((value) => ({ value, count: counts.get(value) || 0 }));
  return sortByValue(departments);
}

function buildDemographics(people) {
  const counts = tallyBy(people, (person) => {
    const demographics = person && person.attributes && person.attributes.demographics;
    return Array.isArray(demographics) ? demographics.map((entry) => entry && entry.value) : [];
  });
  const demographics = [...counts.entries()].map(([value, count]) => ({ value, count }));
  return sortByValue(demographics);
}

function buildCustomFields(rawItems) {
  const fields = asArray(rawItems)
    .map((raw) => {
      const rawValues = raw && raw.values && raw.values.value !== undefined
        ? raw.values.value
        : raw && raw.values;
      const values = asArray(rawValues)
        .map((value) => ({ id: stableId(value && value.id), name: labelOf(value) }))
        .filter((value) => value.id);
      return {
        id: stableId(raw && raw.id),
        name: labelOf(raw),
        type: raw && typeof raw.type === 'string' ? raw.type : null,
        values: sortByLabelThenId(values),
      };
    })
    .filter((field) => field.id);
  return sortByLabelThenId(fields);
}

async function fetchDefinition(client, key) {
  const endpoint = DEFINITION_ENDPOINTS[key];
  const result = await client.getAll(endpoint.path, {}, endpoint.collectionKey, endpoint.itemKey);
  return result.items;
}

async function computeMetadata(client, snapshot, fetchedAt) {
  const people = peopleFrom(snapshot);
  const definitions = definitionsFrom(snapshot);
  const [categories, groups, customFields] = await Promise.all([
    fetchDefinition(client, 'categories'),
    fetchDefinition(client, 'groups'),
    fetchDefinition(client, 'customFields'),
  ]);

  return {
    fetchedAt,
    categories: buildCategories(categories),
    groups: buildGroups(groups, people),
    demographics: buildDemographics(people),
    departments: buildDepartments(definitions.departments, people),
    serviceTypes: buildServiceTypes(definitions.serviceTypes),
    locations: buildLocations(definitions.locations),
    customFields: buildCustomFields(customFields),
  };
}

async function fetchElvantoMetadata(client, snapshot, options = {}) {
  const { churchId = null, store = defaultConnectionStore, now = () => Date.now() } = options;
  const fetchedAt = new Date(now()).toISOString();

  let metadata;
  try {
    metadata = await computeMetadata(client, snapshot, fetchedAt);
  } catch (err) {
    if (!churchId) throw err;
    const connection = await store.getConnection(churchId, 'elvanto');
    const cached = connection && connection.metadata && connection.metadata.syncMetadata;
    if (!cached) throw err;
    return { metadata: cached, stale: true, refreshing: false, metadataCachedAt: connection.metadataCachedAt ?? null };
  }

  if (churchId) {
    await store.updateMetadataCache(churchId, 'elvanto', metadata);
  }

  return metadata;
}

module.exports = {
  DEFINITION_ENDPOINTS,
  fetchElvantoMetadata,
  asArray,
};
