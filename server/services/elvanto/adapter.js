'use strict';

// Elvanto provider adapter (Task 14 of the provider-neutral people-sync
// project) — the composition point that turns Tasks 11-13 into the exact
// Task 5 adapter contract (`provider`, `validateConnection`, `fetchSnapshot`,
// `fetchMetadata`, `validateFilter`, `isEligible`), the same shape
// server/services/peopleSync/pcoAdapter.js already provides for Planning
// Center. This module makes the real network calls Tasks 11-13
// deliberately did not: httpClient.js only transports bytes, normalizer.js
// only reshapes already-fetched raw records, and metadata.js/filter.js only
// discover/evaluate against an already-normalized snapshot. Everything
// about WHICH Elvanto endpoints get called, with WHICH params, and how
// their raw responses get assembled into normalizer.js's `rawPeople` /
// `groupMemberships` inputs, is decided here.
//
// Like pcoAdapter.js, this module does NOT call
// providerRegistry.registerProvider() at require time — see
// providerRegistry.js's registerBuiltInProviders() for the one place both
// providers get wired into the live registry.
//
// ─── THE SINGLE MOST IMPORTANT RULE IN THIS FILE ───────────────────────────
//
// Groups, service types, locations and custom-field keys/selected options use
// stable Elvanto IDs. Departments remain name-based. Getting this wrong
// produces no error: filter.js would simply match nobody, so the adapter,
// metadata and filter conventions must remain aligned.
//
// ─── Live-verified wire format ─────────────────────────────────────────────
//
//   - array query values are repeated `fields[]` parameters;
//   - base identity/status fields arrive without fields[], while family,
//     demographics, departments, service_types and locations are requested;
//   - groups/getAll.json with fields[]=people supplies group membership;
//   - service types, locations and departments are embedded in person data;
//   - custom_<id> person fields contain selected option IDs in nested
//     custom_field entries; and
//   - custom-field definitions use people/customFields/getAll.json.
//   - Elvanto's `date_modified` wire format is assumed to be a bare, already
//     UTC `"YYYY-MM-DD HH:MM:SS"` string with no timezone marker (matching
//     fixtures/people.js's fixture values), consistent with this task's own
//     "UTC `date_modified` watermark" framing. `search[date_modified]` is
//     assumed to accept that identical format back.
//   - `search[date_modified]` is assumed to be the request param key for
//     Elvanto's documented `people/search` change-detection filter (per
//     this task's own spec text) layered onto the same `people/getAll.json`
//     path rather than a separate endpoint, since nothing in this repo
//     exercises a distinct `/people/search.json` path and `getAll.json`
//     already accepts a plain `search` param for name search (see the
//     legacy `/elvanto/families` route's `search=` query param).
//
// ─── Watermark semantics ────────────────────────────────────────────────────
//
// The watermark this adapter returns/consumes is always a raw Elvanto
// `date_modified` string (never a wall-clock timestamp) — the greatest
// valid `date_modified` seen across every fetched, deduplicated raw person,
// computed AFTER pagination and overlap de-duplication succeed. An
// incremental fetch's search cutoff is that same stored watermark, parsed
// as UTC, minus a fixed five-minute overlap, then re-formatted back into
// Elvanto's own wire format — never wall-clock `now()`. `now` is only used
// for `fetchedAt` (an observability timestamp, never persisted as a
// watermark).
//
// ─── Why group membership is refetched on every incremental call ──────────
//
// A person's own `date_modified` does not change when Elvanto adds or
// removes them from a GROUP (a separate entity) — this is exactly why a
// periodic full reconciliation is mandatory regardless of incremental
// success (see this task's own "mandatory periodic full path" framing, and
// the project's global missing-person-archival constraint). This adapter's
// job is narrower but related: fetchIncrementalSnapshot() must never reuse
// a stale membership index for whatever (possibly small) set of changed
// people it does return. There is no cross-call cache: both snapshot modes
// build a fresh client and group membership index.

const { createElvantoClient } = require('./httpClient');
const { normalizeSnapshot } = require('./normalizer');
const { DEFINITION_ENDPOINTS, fetchElvantoMetadata, asArray } = require('./metadata');
const { validateElvantoFilter, isElvantoEligible } = require('./filter');
const { evaluateFilterV2 } = require('../peopleSync/filterEngine');

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const NOT_SET = '$not_set';

const PEOPLE_PATH = '/people/getAll.json';
const PEOPLE_COLLECTION_KEY = 'people';
const PEOPLE_ITEM_KEY = 'person';

// Verified optional people fields (live API). Default identity/status/family_id/
// contact/archived/deceased/category/date_modified fields arrive without
// fields[]; `groups` is not a people field.
const BASE_OPTIONAL_PEOPLE_FIELDS = [
  'family',
  'demographics',
  'departments',
  'service_types',
  'locations',
];

const GROUPS_ENDPOINT = DEFINITION_ENDPOINTS.groups || {
  path: '/groups/getAll.json',
  collectionKey: 'groups',
  itemKey: 'group',
};

function stableId(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function trimmedOrNull(value) {
  if (value === null || value === undefined) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  return trimmed ? trimmed : null;
}

function sortByLabelThenId(items) {
  return [...items].sort((a, b) => {
    const labelA = String(a.name ?? '').toLowerCase();
    const labelB = String(b.name ?? '').toLowerCase();
    if (labelA !== labelB) return labelA < labelB ? -1 : 1;
    const idA = String(a.id ?? '');
    const idB = String(b.id ?? '');
    if (idA === idB) return 0;
    return idA < idB ? -1 : 1;
  });
}

function sortNames(names) {
  return [...names].sort((a, b) => {
    const lowerA = String(a).toLowerCase();
    const lowerB = String(b).toLowerCase();
    if (lowerA !== lowerB) return lowerA < lowerB ? -1 : 1;
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });
}

function canonicalFilterValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed === NOT_SET ? '$$not_set' : trimmed;
}

function filterValues(values) {
  return [...new Set(asArray(values).map(canonicalFilterValue).filter(Boolean))].sort();
}

function filterCounts(facts, dimensionId) {
  const counts = new Map();
  let notSetCount = 0;
  for (const fact of facts || []) {
    const values = fact && fact.dimensions && fact.dimensions[dimensionId];
    if (!Array.isArray(values) || values.length === 0) {
      notSetCount += 1;
      continue;
    }
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  }
  return { counts, notSetCount };
}

function filterDimension({ id, label, cardinality, category, metadataValues = [], facts, valueLabels = new Map(), omitValues = new Set() }) {
  const { counts, notSetCount } = filterCounts(facts, id);
  const valueIds = filterValues([...metadataValues, ...counts.keys()]).filter((value) => !omitValues.has(value));
  return {
    id,
    label,
    cardinality,
    category,
    values: [
      ...valueIds.map((value) => ({ id: value, label: valueLabels.get(value) || value, count: counts.get(value) || 0 })),
      ...(notSetCount > 0 ? [{ id: NOT_SET, label: 'Not set', count: notSetCount }] : []),
    ],
  };
}

function toElvantoFilterFacts(person, coveredDimensionIds) {
  const covered = coveredDimensionIds instanceof Set ? coveredDimensionIds : new Set(coveredDimensionIds || []);
  const attributes = person && person.attributes || {};
  const candidates = {
    status: [person && person.state],
    category: [person && person.categoryId],
    groups: attributes.groups,
    demographics: asArray(attributes.demographics).map((entry) => entry && entry.value),
    departments: attributes.departments,
    service_types: attributes.serviceTypes,
    locations: attributes.locations,
  };
  const dimensions = {};
  for (const [dimensionId, values] of Object.entries(candidates)) {
    if (!covered.has(dimensionId)) continue;
    const normalized = filterValues(values);
    if (normalized.length) dimensions[dimensionId] = normalized;
  }
  for (const dimensionId of covered) {
    if (!dimensionId.startsWith('custom_field:')) continue;
    const fieldId = dimensionId.slice('custom_field:'.length);
    const values = filterValues(attributes.customFields && attributes.customFields[fieldId]);
    if (values.length) dimensions[dimensionId] = values;
  }
  return { externalPersonId: String(person && person.id || ''), dimensions };
}

function metadataItems(items, valueKey = 'id') {
  const labels = new Map();
  const values = [];
  for (const item of asArray(items)) {
    const value = canonicalFilterValue(item && item[valueKey]);
    if (!value) continue;
    values.push(value);
    const label = item && (item.name || item.value);
    if (typeof label === 'string' && label.trim()) labels.set(value, label.trim());
  }
  return { values, labels };
}

function buildElvantoFilterDimensions({ facts = [], providerMetadata = {}, coveredDimensionIds } = {}) {
  const covered = coveredDimensionIds === undefined
    ? null
    : new Set(coveredDimensionIds instanceof Set ? coveredDimensionIds : coveredDimensionIds || []);
  const isCovered = (dimensionId) => !covered || covered.has(dimensionId);
  const categories = metadataItems(providerMetadata.categories);
  const groups = metadataItems(providerMetadata.groups);
  const demographics = metadataItems(providerMetadata.demographics, 'value');
  const departments = metadataItems(providerMetadata.departments, 'value');
  const serviceTypes = metadataItems(providerMetadata.serviceTypes);
  const locations = metadataItems(providerMetadata.locations);
  const candidates = [
    filterDimension({ id: 'status', label: 'Status', cardinality: 'single', category: 'People', facts, omitValues: new Set(['archived', 'deceased']) }),
    filterDimension({ id: 'category', label: 'Category', cardinality: 'single', category: 'People', metadataValues: categories.values, valueLabels: categories.labels, facts }),
    filterDimension({ id: 'groups', label: 'Groups', cardinality: 'multi', category: 'Groups', metadataValues: groups.values, valueLabels: groups.labels, facts }),
    filterDimension({ id: 'demographics', label: 'Demographics', cardinality: 'multi', category: 'People', metadataValues: demographics.values, valueLabels: demographics.labels, facts }),
    filterDimension({ id: 'departments', label: 'Departments', cardinality: 'multi', category: 'People', metadataValues: departments.values, valueLabels: departments.labels, facts }),
    filterDimension({ id: 'service_types', label: 'Service types', cardinality: 'multi', category: 'People', metadataValues: serviceTypes.values, valueLabels: serviceTypes.labels, facts }),
    filterDimension({ id: 'locations', label: 'Locations', cardinality: 'multi', category: 'People', metadataValues: locations.values, valueLabels: locations.labels, facts }),
  ];
  const dimensions = candidates.filter((dimension) => isCovered(dimension.id));
  for (const field of asArray(providerMetadata.customFields)) {
    if (!field || typeof field.id !== 'string' || !field.id) continue;
    if (!isCovered(`custom_field:${field.id}`)) continue;
    const values = metadataItems(field.values);
    dimensions.push(filterDimension({
      id: `custom_field:${field.id}`,
      label: field.name || `Custom field ${field.id}`,
      cardinality: field.type === 'select_multi' ? 'multi' : 'single',
      category: 'Custom fields',
      metadataValues: values.values,
      valueLabels: values.labels,
      facts,
    }));
  }
  return dimensions.sort((left, right) => left.id.localeCompare(right.id));
}

// ─── Optional people fields ─────────────────────────────────────────────────

function buildPeopleFields(customFieldIds) {
  const customFields = [...new Set((customFieldIds || []).map((id) => stableId(id)).filter(Boolean))]
    .map((id) => `custom_${id}`);
  return [...BASE_OPTIONAL_PEOPLE_FIELDS, ...customFields];
}

function idsFrom(value) {
  return asArray(value)
    .map((item) => {
      if (item && typeof item === 'object') return stableId(item.id);
      return stableId(item);
    })
    .filter(Boolean);
}

function departmentNamesFrom(departments) {
  const names = [];
  for (const dept of asArray(departments)) {
    if (!dept || typeof dept !== 'object') {
      const name = trimmedOrNull(dept);
      if (name) names.push(name);
      continue;
    }
    const name = trimmedOrNull(dept.name);
    if (name) names.push(name);
    const subs = dept.sub_departments && dept.sub_departments.sub_department !== undefined
      ? dept.sub_departments.sub_department
      : dept.sub_departments;
    for (const sub of asArray(subs)) {
      const subName = trimmedOrNull(sub && typeof sub === 'object' ? sub.name : sub);
      if (subName) names.push(subName);
    }
  }
  return names;
}

function directMemberships(raw) {
  return {
    serviceTypes: idsFrom(raw && raw.service_types && raw.service_types.service_type !== undefined
      ? raw.service_types.service_type
      : raw && raw.service_types),
    locations: idsFrom(raw && raw.locations && raw.locations.location !== undefined
      ? raw.locations.location
      : raw && raw.locations),
    departments: departmentNamesFrom(raw && raw.departments && raw.departments.department !== undefined
      ? raw.departments.department
      : raw && raw.departments),
  };
}

// Selected select/multi-select options arrive as nested custom_field entries
// with stable option IDs. Scalars pass through for free-text fields.
function projectCustomValue(rawValue) {
  if (rawValue === null || rawValue === undefined) return rawValue;
  if (typeof rawValue === 'object') {
    if (rawValue.custom_field !== undefined) {
      return idsFrom(rawValue.custom_field);
    }
    if (Array.isArray(rawValue)) {
      return idsFrom(rawValue);
    }
  }
  return rawValue;
}

function attachCustomFieldMap(raw, customFieldIds) {
  const custom_fields = {};
  for (const rawId of customFieldIds || []) {
    const key = stableId(rawId);
    if (!key) continue;
    const wireKey = `custom_${key}`;
    if (raw && Object.prototype.hasOwnProperty.call(raw, wireKey)) {
      custom_fields[key] = projectCustomValue(raw[wireKey]);
    }
  }
  return { ...raw, custom_fields };
}

function buildSnapshotDefinitions(rawPeople) {
  const serviceTypes = new Map();
  const locations = new Map();
  const departments = new Set();

  for (const raw of rawPeople || []) {
    for (const item of asArray(raw && raw.service_types && raw.service_types.service_type !== undefined
      ? raw.service_types.service_type
      : raw && raw.service_types)) {
      if (!item || typeof item !== 'object') continue;
      const id = stableId(item.id);
      if (!id) continue;
      serviceTypes.set(id, { id, name: trimmedOrNull(item.name) || '' });
    }
    for (const item of asArray(raw && raw.locations && raw.locations.location !== undefined
      ? raw.locations.location
      : raw && raw.locations)) {
      if (!item || typeof item !== 'object') continue;
      const id = stableId(item.id);
      if (!id) continue;
      locations.set(id, { id, name: trimmedOrNull(item.name) || '' });
    }
    for (const name of departmentNamesFrom(raw && raw.departments && raw.departments.department !== undefined
      ? raw.departments.department
      : raw && raw.departments)) {
      departments.add(name);
    }
  }

  return {
    serviceTypes: sortByLabelThenId([...serviceTypes.values()]),
    locations: sortByLabelThenId([...locations.values()]),
    departments: sortNames([...departments]),
  };
}

// ─── Group membership index (groups/getAll only) ───────────────────────────

function ensureMembershipEntry(index, rawPersonId) {
  const id = stableId(rawPersonId);
  if (!id) return null;
  if (!index.has(id)) index.set(id, { groups: [], departments: [], serviceTypes: [], locations: [] });
  return index.get(id);
}

async function fetchGroupMembershipIndex(client) {
  const index = new Map();
  const result = await client.getAll(
    GROUPS_ENDPOINT.path,
    { 'fields[]': ['people'] },
    GROUPS_ENDPOINT.collectionKey,
    GROUPS_ENDPOINT.itemKey
  );

  for (const container of result.items || []) {
    const value = stableId(container && container.id);
    if (!value) continue;
    const members = asArray(container && container.people && container.people.person);
    for (const member of members) {
      const personId = member && typeof member === 'object' ? member.id : member;
      const entry = ensureMembershipEntry(index, personId);
      if (entry) entry.groups.push(value);
    }
  }
  return index;
}

function mergeDirectMemberships(index, rawPeople) {
  for (const raw of rawPeople || []) {
    const entry = ensureMembershipEntry(index, raw && raw.id);
    if (!entry) continue;
    const direct = directMemberships(raw);
    entry.serviceTypes.push(...direct.serviceTypes);
    entry.locations.push(...direct.locations);
    entry.departments.push(...direct.departments);
  }
  return index;
}

// ─── Overlap de-duplication ──────────────────────────────────────────────────

// String-comparable because Elvanto's date_modified is a fixed-width,
// zero-padded "YYYY-MM-DD HH:MM:SS" (see header note) — lexicographic order
// matches chronological order. A missing/blank value always sorts lowest so
// it never wins a de-dup tie-break or a watermark max over a real value.
function compareDateModified(a, b) {
  const av = trimmedOrNull(a);
  const bv = trimmedOrNull(b);
  if (av === bv) return 0;
  if (av === null) return -1;
  if (bv === null) return 1;
  return av < bv ? -1 : 1;
}

// The same raw person can appear more than once across a single fetch's
// pages — deliberately, for incremental mode's overlap window (see header
// note), but defensively handled here regardless of mode. Records missing a
// stable ID are passed through untouched (nothing to de-duplicate against)
// and left for normalizeSnapshot's own MISSING_ID skip handling.
function dedupeByIdKeepingNewest(rawPeople) {
  const byId = new Map();
  const passthrough = [];

  for (const raw of rawPeople || []) {
    const id = stableId(raw && raw.id);
    if (!id) {
      passthrough.push(raw);
      continue;
    }
    const existing = byId.get(id);
    if (!existing || compareDateModified(raw && raw.date_modified, existing && existing.date_modified) > 0) {
      byId.set(id, raw);
    }
  }

  return [...passthrough, ...byId.values()];
}

// The output watermark: the greatest valid date_modified across every
// fetched (post-de-dup) raw person — NEVER wall-clock time. Returns null
// when nothing has a usable date_modified (e.g. an empty church, or a
// wire shape that omitted it entirely).
function computeWatermark(rawPeople) {
  let max = null;
  for (const raw of rawPeople || []) {
    const value = trimmedOrNull(raw && raw.date_modified);
    if (value === null) continue;
    if (max === null || compareDateModified(value, max) > 0) max = value;
  }
  return max;
}

// ─── Incremental search cutoff ──────────────────────────────────────────────

// Elvanto's date_modified has no timezone marker of its own; treating the
// space-separated form as UTC (appending 'Z' after swapping the separator)
// is the same "UTC date_modified" assumption this task's spec text calls
// for.
function parseElvantoUtc(value) {
  const trimmed = trimmedOrNull(value);
  if (!trimmed) return null;
  const isoCandidate = trimmed.includes('T') ? trimmed : `${trimmed.replace(' ', 'T')}Z`;
  const parsed = new Date(isoCandidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatElvantoUtc(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// Five minutes before the stored watermark, in Elvanto's own wire format —
// a deliberate overlap so a change landing right at the previous run's
// boundary timestamp is never dropped (de-duplicated back out by
// dedupeByIdKeepingNewest above, using whichever copy has the newest
// date_modified).
function computeIncrementalSearchCutoff(watermark) {
  const baseline = parseElvantoUtc(watermark);
  if (!baseline) {
    throw new Error('Elvanto incremental fetchSnapshot requires a valid watermark; use mode "full" for the first sync.');
  }
  return formatElvantoUtc(new Date(baseline.getTime() - FIVE_MINUTES_MS));
}

// ─── People fetch + normalization ───────────────────────────────────────────

async function fetchNormalizedPeople(client, params, customFieldIds) {
  const [peopleResult, groupIndex] = await Promise.all([
    client.getAll(PEOPLE_PATH, params, PEOPLE_COLLECTION_KEY, PEOPLE_ITEM_KEY),
    fetchGroupMembershipIndex(client),
  ]);

  const rawPeople = dedupeByIdKeepingNewest(peopleResult.items)
    .map((raw) => attachCustomFieldMap(raw, customFieldIds));

  const membershipIndex = mergeDirectMemberships(groupIndex, rawPeople);
  const { people, families, skipped } = normalizeSnapshot(rawPeople, membershipIndex);
  const watermark = computeWatermark(rawPeople);
  // Definitions come from raw people before custom-field map attachment is
  // required; membership fields live on the original raw objects.
  const definitions = buildSnapshotDefinitions(peopleResult.items);

  return { people, families, skipped, watermark, definitions };
}

// Full paginated fetch — every status (Active/Contact/Archived/Deceased),
// no date_modified filter. `complete: true` is unconditional here because
// client.getAll()/fetchGroupMembershipIndex() never resolve on a partial
// failure: httpClient.js's getAll() explicitly does not catch a failed page
// and never returns accumulated partial items (see its own header note) —
// it throws instead, which propagates straight out of this function. There
// is therefore no reachable code path in this adapter that could construct
// `complete: false`; per this project's global constraint, an incomplete
// fetch must throw, never silently report itself as complete or partial.
async function fetchFullSnapshot(client, customFieldIds, now) {
  const params = { 'fields[]': buildPeopleFields(customFieldIds) };
  const { people, families, skipped, watermark, definitions } = await fetchNormalizedPeople(client, params, customFieldIds);

  return {
    provider: 'elvanto',
    mode: 'full',
    complete: true,
    fetchedAt: now().toISOString(),
    watermark,
    people,
    families,
    skipped,
    definitions,
  };
}

// Incremental fetch — Elvanto `search[date_modified]` five minutes before
// the stored watermark (UTC, see computeIncrementalSearchCutoff above).
// Still refreshes group membership from scratch (see the header note on why)
// rather than reusing anything from a prior call. Same unconditional
// `complete: true` reasoning as fetchFullSnapshot above.
async function fetchIncrementalSnapshot(client, watermark, customFieldIds, now) {
  const searchCutoff = computeIncrementalSearchCutoff(watermark);
  const params = { 'fields[]': buildPeopleFields(customFieldIds), 'search[date_modified]': searchCutoff };
  const { people, families, skipped, watermark: newWatermark, definitions } = await fetchNormalizedPeople(client, params, customFieldIds);

  return {
    provider: 'elvanto',
    mode: 'incremental',
    complete: true,
    fetchedAt: now().toISOString(),
    // Nothing changed this run is a legitimate outcome (an empty, but
    // complete, incremental fetch) — fall back to the incoming watermark
    // rather than regressing to null, since the stored watermark is still
    // valid and must not be lost.
    watermark: newWatermark || watermark,
    people,
    families,
    skipped,
    definitions,
  };
}

// ─── Adapter composition ────────────────────────────────────────────────────

function createElvantoAdapter({ clientFactory = createElvantoClient, now = () => new Date(), store } = {}) {
  return {
    provider: 'elvanto',

    // A small, cheap authenticated request — validates the API key without
    // pulling the whole roster. httpClient.js already guarantees the raw
    // API key/Authorization header never appears in any thrown
    // ElvantoError's message/details (see its own redact()); this adapter
    // adds nothing on top and does not catch, so ELVANTO_AUTH (401/403) and
    // ELVANTO_UNAVAILABLE (transport failure / non-2xx) propagate exactly
    // as httpClient.js classifies them.
    async validateConnection({ credentials } = {}) {
      const client = clientFactory({ apiKey: credentials && credentials.apiKey });
      await client.get(PEOPLE_PATH, { page: 1, page_size: 10 });
      return { ok: true, metadata: { connectionLabel: 'Connected via API key' } };
    },

    async fetchSnapshot({ credentials, mode, watermark, customFieldIds = [] } = {}) {
      const client = clientFactory({ apiKey: credentials && credentials.apiKey });
      return mode === 'incremental'
        ? fetchIncrementalSnapshot(client, watermark, customFieldIds, now)
        : fetchFullSnapshot(client, customFieldIds, now);
    },

    // Task 5's actual adapter contract is fetchMetadata({ churchId,
    // credentials, force }) — see the project plan's Task 5 pseudocode.
    // This task's OWN Step 4 pseudocode (fetchMetadata({ credentials,
    // snapshot })) omitted churchId, which silently made Task 13's
    // stale-cache-on-outage fallback (fetchElvantoMetadata's
    // options.churchId branch — see metadata.js's own header note) dead
    // code when reached only through this adapter: with no churchId,
    // metadata.js always takes its "no caching" path and a live Elvanto
    // outage during metadata discovery throws instead of serving the
    // last-known-good cached filter picker data. Fixed after review: accept
    // and thread churchId through.
    //
    // `force` is accepted for contract-shape parity with PCO's
    // fetchMetadata (which threads it into a genuine TTL-bypass cache
    // read), but is a deliberate no-op here: unlike PCO's people cache,
    // fetchElvantoMetadata never preferentially serves a cache when a live
    // fetch succeeds — it always calls out to Elvanto fresh and only ever
    // falls back to the persisted cache when that live fetch fails. There
    // is no "prefer cache" mode here for `force` to bypass.
    //
    // `store` is only ever supplied by a test via createElvantoAdapter's
    // own `store` option (see above) — omitted entirely in production so
    // fetchElvantoMetadata falls through to its own real default
    // (connectionStore.js, the actual DB-backed cache).
    async fetchMetadata({ churchId, credentials, force, snapshot } = {}) {
      const client = clientFactory({ apiKey: credentials && credentials.apiKey });
      const options = { churchId };
      if (store) options.store = store;
      return fetchElvantoMetadata(client, snapshot, options);
    },

    validateFilter: validateElvantoFilter,
    isEligible(person, filterConfig, filterSchemaVersion = 1) {
      if (filterSchemaVersion !== 2) return isElvantoEligible(person, filterConfig, filterSchemaVersion);
      const attributes = person?.attributes || {};
      const covered = new Set([
        'status', 'category', 'groups', 'demographics', 'departments', 'service_types', 'locations',
        ...Object.keys(attributes.customFields || {}).map((fieldId) => `custom_field:${fieldId}`),
      ]);
      return evaluateFilterV2(toElvantoFilterFacts(person, covered), filterConfig);
    },
    toFilterFacts: toElvantoFilterFacts,
    buildFilterDimensions: buildElvantoFilterDimensions,
    isInFilterPopulation(person, settings) {
      if (!person || person.state === 'archived' || person.state === 'deceased') return false;
      return !(person.state === 'contact' && settings && settings.includeContacts === false);
    },
  };
}

module.exports = {
  createElvantoAdapter,
  // Exported for direct unit testing of the pieces fetchSnapshot composes,
  // in addition to the end-to-end adapter-level tests in adapter.test.js.
  buildPeopleFields,
  attachCustomFieldMap,
  fetchGroupMembershipIndex,
  directMemberships,
  buildSnapshotDefinitions,
  dedupeByIdKeepingNewest,
  computeWatermark,
  computeIncrementalSearchCutoff,
};
