'use strict';

// Discovers Elvanto's "definition" lists — categories, groups, service
// types, locations, departments, and custom fields — for the batch filter
// picker (Task 19) and for filter.js's validateElvantoFilter/
// isElvantoEligible (Task 13, this same task). See filter.js's header note
// for the ID-vs-name convention this module establishes for Task 14's
// adapter to follow when it assembles a normalized person's
// attributes.groups/serviceTypes/locations/customFields.
//
// ─── Endpoint provenance ────────────────────────────────────────────────────
//
// Confirmed against server/routes/integrations.js's existing
// `/elvanto/debug-dump` route — the one place already in this repo that
// enumerates Elvanto's definition endpoints for the legacy one-shot
// importer:
//   categories   -> GET /people/categories/getAll.json
//   groups       -> GET /groups/getAll.json
//   serviceTypes -> GET /services/types/getAll.json   (NOT /services/getAll.json,
//                   which lists individual service *instances* — the same
//                   debug-dump route lists both `services` and
//                   `service_types` as distinct endpoints)
//   locations    -> GET /locations/getAll.json
//   departments  -> GET /departments/getAll.json
//
// NOT confirmed anywhere in this repo (no existing code exercises a custom
// *field-definitions* endpoint — only per-person custom_fields values are
// ever referenced): assumed GET /people/customfields/getAll.json, following
// the same "/people/<subresource>/getAll.json" convention categories
// already uses. The collection/item envelope keys below are a consistent
// guess, not a confirmed wire format. This is a test-injected-client task —
// the exact path strings matter far less than this module's own internal
// contract (shape, sorting, counting, caching), so this is documented
// rather than blocked on.
//
// demographics has NO definitions endpoint at all — nothing in this repo
// references one, and Elvanto demographics read like a per-person
// free-form answer rather than a managed list. Its metadata entries are
// derived purely by tallying distinct attributes.demographics[].value
// already present in the normalized `snapshot`, never by an extra network
// call — this is the "distinct projected person values" instruction from
// the task spec.
//
// Elvanto's own group/service-type/location/department definitions may
// report their own member counts, but this module never trusts them:
// every count below is computed by tallying the already-fetched normalized
// `snapshot` instead, so metadata counts always agree with whatever
// eligibility.js/plan.js will actually see.

const defaultConnectionStore = require('../peopleSync/connectionStore');

const DEFINITION_ENDPOINTS = {
  categories: { path: '/people/categories/getAll.json', collectionKey: 'categories', itemKey: 'category' },
  groups: { path: '/groups/getAll.json', collectionKey: 'groups', itemKey: 'group' },
  serviceTypes: { path: '/services/types/getAll.json', collectionKey: 'service_types', itemKey: 'service_type' },
  locations: { path: '/locations/getAll.json', collectionKey: 'locations', itemKey: 'location' },
  departments: { path: '/departments/getAll.json', collectionKey: 'departments', itemKey: 'department' },
  customFields: { path: '/people/customfields/getAll.json', collectionKey: 'customfields', itemKey: 'customfield' },
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

// Sorts by case-insensitive label, then by ID as a tiebreaker — the exact
// rule Step 4 of the task spec calls for ("Sort every option by
// case-insensitive label then ID").
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

// demographics/departments have no ID at all (see header note), so they
// sort by their own value as both label and tiebreaker.
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

// `snapshot` is Task 12's normalizeSnapshot() result shape, { people,
// families, skipped } — but a bare array of already-normalized people is
// also accepted defensively (the natural shape for a hand-rolled test
// fixture, and matching this codebase's general tolerance for either shape
// at a module boundary — see normalizer.js's own demographics/custom-field
// parsing for the same defensive spirit). Anything else yields no people
// to tally, rather than throwing, since metadata discovery should not fail
// outright just because a caller passed an unexpected snapshot shape.
function peopleFrom(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  if (snapshot && Array.isArray(snapshot.people)) return snapshot.people;
  return [];
}

// Tallies occurrences of each stable key returned by `picker(person)` (an
// array of raw group IDs / department names / demographic values) across
// every person in the snapshot. Shared by every "count from snapshot"
// dimension below so the tally logic only exists once.
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

function buildServiceTypes(rawItems) {
  const items = asArray(rawItems)
    .map((raw) => ({ id: stableId(raw && raw.id), name: labelOf(raw) }))
    .filter((item) => item.id);
  return sortByLabelThenId(items);
}

function buildLocations(rawItems) {
  const items = asArray(rawItems)
    .map((raw) => ({ id: stableId(raw && raw.id), name: labelOf(raw) }))
    .filter((item) => item.id);
  return sortByLabelThenId(items);
}

// Departments have no stable ID in Elvanto's own definitions endpoint (see
// header note) — the endpoint is still called (it is the authoritative
// list of which department names exist), but the metadata entry is
// { value, count } rather than { id, name }, and the count is always
// tallied from the snapshot rather than trusted from the endpoint.
function buildDepartments(rawItems, people) {
  const counts = tallyBy(people, (person) => person && person.attributes && person.attributes.departments);
  const names = asArray(rawItems)
    .map((raw) => (raw && typeof raw.name === 'string' ? raw.name.trim() : ''))
    .filter(Boolean);
  const departments = [...new Set(names)].map((value) => ({ value, count: counts.get(value) || 0 }));
  return sortByValue(departments);
}

// No definitions endpoint exists for demographics at all (see header
// note) — every entry comes from tallying distinct
// attributes.demographics[].value across the snapshot, discarding which
// demographic field each value came from (matching filter.js's
// demographicValues() flattening for eligibility evaluation).
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
      const values = asArray(raw && raw.values)
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

// Pure computation: no caching, no church context — just definitions +
// snapshot in, normalized metadata object out. Never caches or returns raw
// people/credential data; only aggregated id/name/status/count/type
// summaries leave this function.
async function computeMetadata(client, snapshot, fetchedAt) {
  const people = peopleFrom(snapshot);
  const [categories, groups, serviceTypes, locations, departments, customFields] = await Promise.all([
    fetchDefinition(client, 'categories'),
    fetchDefinition(client, 'groups'),
    fetchDefinition(client, 'serviceTypes'),
    fetchDefinition(client, 'locations'),
    fetchDefinition(client, 'departments'),
    fetchDefinition(client, 'customFields'),
  ]);

  return {
    fetchedAt,
    categories: buildCategories(categories),
    groups: buildGroups(groups, people),
    demographics: buildDemographics(people),
    departments: buildDepartments(departments, people),
    serviceTypes: buildServiceTypes(serviceTypes),
    locations: buildLocations(locations),
    customFields: buildCustomFields(customFields),
  };
}

// Discovers Elvanto's batch-filter metadata and (when `options.churchId` is
// given) persists it through connectionStore.updateMetadataCache — the
// same generic per-church-per-provider cache Task 2 built, already used by
// the rest of this project (server/services/peopleSync/connectionStore.js).
//
// `options.store` defaults to the real connectionStore module and exists
// purely so tests never touch the database; `options.now` defaults to
// `Date.now` and exists so tests can pin `fetchedAt` to an exact ISO
// string.
//
// Contract:
//   - No `options.churchId`: pure fetch, no caching. Returns the metadata
//     object (the exact shape documented above) directly, or throws
//     whatever error `client.getAll` throws.
//   - `options.churchId` given, fetch succeeds: metadata is written through
//     connectionStore.updateMetadataCache(churchId, 'elvanto', metadata),
//     then the same bare metadata object is returned (matching the
//     "returned shape is exact" contract regardless of whether caching is
//     in play).
//   - `options.churchId` given, fetch fails, a cache exists: returns
//     { metadata: <cached>, stale: true, refreshing: false,
//     metadataCachedAt } instead of throwing — a live Elvanto outage
//     should not blank out an already-working filter picker.
//   - `options.churchId` given, fetch fails, no cache exists: propagates
//     the original (typed ElvantoError) failure — there is nothing safe to
//     fall back to.
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
