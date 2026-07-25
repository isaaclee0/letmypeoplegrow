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
// normalizer.js's header note (Task 12, amended after Task 13's review) and
// filter.js's header note (Task 13) both spell this out, and it bears
// repeating here because THIS file is the one that actually populates the
// bundle they depend on: every group/serviceType/location entry threaded
// into a person's `memberships` bundle below, and every KEY in the
// `custom_fields` map attached to a raw person before normalization, MUST
// be Elvanto's stable ID — never a display name. `departments` is the one
// exception and stays name-based (Elvanto's departments endpoint has no
// separate ID). Getting this wrong produces no error anywhere: filter.js's
// isElvantoEligible() compares attributes.groups/serviceTypes/locations
// against metadata.js's id-bearing definition lists, so a name-keyed bundle
// just silently matches nobody. See the explicit "ID, not name" comments
// inline at fetchMembershipDimension() and attachCustomFieldMap() below —
// those are the exact two places this rule has to be honoured.
//
// ─── Wire-format assumptions NOT independently confirmed against Elvanto's
// own API docs (documented here, per this task's own brief, rather than
// blocking on them) ──────────────────────────────────────────────────────
//
//   - `fields[]` is the request param key for asking Elvanto's
//     `people/getAll.json` / `groups/getAll.json` / etc. to include
//     optional fields beyond their default response shape. This matches
//     this task's own spec text verbatim ("fully paginated groups with
//     `fields[]=people`"). The existing legacy one-shot importer
//     (server/routes/integrations.js) instead sends a single comma-joined
//     `fields=family,demographics` param for the same purpose; since
//     httpClient.js's params are a plain JS object (one value per key) and
//     this task's file list does not include modifying httpClient.js, this
//     adapter sends one `'fields[]'` key whose value is an array of field
//     names — httpClient.js's real transport (`String(array)`) serializes
//     that as a single comma-joined value on the wire, which is consistent
//     with the legacy importer's own confirmed comma-joined convention even
//     though the key name differs. Tests in this file assert against the
//     `'fields[]'` array we hand to the client, not the final query string.
//   - Base fields already confirmed returned WITHOUT an explicit `fields[]`
//     request (per the legacy importer's `/elvanto/families` route, which
//     fetches `people/getAll.json` with NO fields param and still reads
//     `firstname`/`lastname`/`preferred_name`/`family_id`/
//     `family_relationship`/`archived` straight off each result): those six
//     are NOT added to this adapter's `fields[]` list. Everything else
//     normalizer.js reads (`family` details beyond the default family_id/
//     family_relationship pairing, `contact`, `deceased`, `category`,
//     `date_modified`, `demographics`) is requested explicitly, since the
//     legacy debug-dump route already shows at least `demographics` is NOT
//     part of the default response shape.
//   - Custom field values are requested as individual `custom_<id>` entries
//     inside that same `fields[]` list (per this task's own spec text) and
//     are assumed to come back as top-level `custom_<id>` properties on
//     each raw person object (not nested under a single object) — this
//     adapter reads them back out under that same convention in
//     attachCustomFieldMap() below, which is also where the request-side ID
//     convention becomes the response-side ID convention (see the "ID, not
//     name" rule above). The field is confirmed keyed by ID this way; the
//     VALUE at that key is a separate, still-unconfirmed assumption — see
//     attachCustomFieldMap()'s own inline note for why a value-side
//     label-vs-ID ambiguity is not resolved here.
//   - Per-container membership lookup: this task's own spec text confirms
//     `fields[]=people` for the GROUPS endpoint only. normalizer.js's
//     header note (Task 12) already established that ALL FOUR membership
//     dimensions (groups, departments, serviceTypes, locations) need
//     caller-assembled membership data, by the same reasoning ("Elvanto's
//     real API doesn't return group/department/service-type/location
//     membership on the person record itself"). This adapter extends the
//     confirmed groups convention to all four analogous "container"
//     endpoints (metadata.js's DEFINITION_ENDPOINTS), assuming they expose
//     their own membership list the same way when `fields[]=people` is
//     requested, and reads it back as `container.people.person` — mirroring
//     the one other place in this repo requesting a specific group's
//     people (`groups/getInfo.json?id=X&fields=people`) and the general
//     "collection wrapping a plural itemKey" envelope httpClient.js/
//     metadata.js already rely on everywhere else.
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
// people it does return. There is no cross-call cache anywhere in this
// module (every fetchSnapshot() call builds a brand-new client and refetches
// every membership dimension from scratch), so this is true by
// construction rather than by a special-cased flag — fetchFullSnapshot()
// and fetchIncrementalSnapshot() both call the exact same
// fetchMembershipIndex() helper.

const { createElvantoClient } = require('./httpClient');
const { normalizeSnapshot } = require('./normalizer');
const { DEFINITION_ENDPOINTS, fetchElvantoMetadata, asArray } = require('./metadata');
const { validateElvantoFilter, isElvantoEligible } = require('./filter');

const FIVE_MINUTES_MS = 5 * 60 * 1000;

const PEOPLE_PATH = '/people/getAll.json';
const PEOPLE_COLLECTION_KEY = 'people';
const PEOPLE_ITEM_KEY = 'person';

// Optional fields normalizer.js reads that are NOT part of Elvanto's
// default people/getAll.json response shape (see the header note above for
// which fields ARE already confirmed default and therefore excluded here).
const BASE_OPTIONAL_PEOPLE_FIELDS = ['family', 'contact', 'deceased', 'category', 'date_modified', 'demographics'];

// The four "container" endpoints whose per-item people list this adapter
// must reverse-index into a per-person membership bundle. Reuses
// metadata.js's own DEFINITION_ENDPOINTS so the path/collectionKey/itemKey
// for each never drifts out of sync between metadata discovery and
// membership indexing.
const MEMBERSHIP_DIMENSIONS = ['groups', 'serviceTypes', 'locations', 'departments'];

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

// ─── Optional people fields ─────────────────────────────────────────────────

function buildPeopleFields(customFieldIds) {
  const customFields = [...new Set((customFieldIds || []).map((id) => stableId(id)).filter(Boolean))]
    .map((id) => `custom_${id}`);
  return [...BASE_OPTIONAL_PEOPLE_FIELDS, ...customFields];
}

// Reads back the `custom_<id>` top-level properties this adapter asked
// Elvanto for (see buildPeopleFields above) and assembles them into the
// `custom_fields` map normalizer.js expects — keyed by the custom field's
// stable ID, exactly matching the request-side `custom_<id>` convention.
//
// *** ID, not name: `key` below is the raw customFieldIds entry (a stable
// Elvanto custom-field ID), never a field label — this is the exact
// convention filter.js's isElvantoEligible()/config.customFields[].fieldId
// and metadata.js's customFields[].id require. ***
//
// Any pre-existing `raw.custom_fields` value is deliberately NOT merged in:
// its shape/keying is unconfirmed (see normalizer.js's own header note), so
// merging it in could silently reintroduce name-keyed entries alongside
// the ID-keyed ones this adapter builds.
//
// *** UNCONFIRMED WIRE-FORMAT ASSUMPTION — flag for Task 22 verification
// against a live account: the VALUE at `raw[custom_<id>]` is passed through
// verbatim below, on the assumption that for a select/multi-select-style
// custom field Elvanto returns the selected OPTION'S STABLE ID (matching
// metadata.js's customFields[].values[].id and this file's config.
// customFields[].values), not that option's display label. Nothing in this
// repo exercises a real custom-field response, so this is genuinely
// unconfirmed — only the KEY (the field ID itself) is independently
// confirmed by this task's own spec text ("custom field names are
// requested using custom_<id>"). If Elvanto actually returns the label
// instead of the ID, filter.js's isElvantoEligible() customFields rule
// would silently match nobody (comparing a label against metadata.js's ID
// list) — the exact silent-zero-match failure mode the groups/
// serviceTypes/locations ID convention exists to prevent. This adapter
// deliberately does NOT attempt to build a label-to-ID mapping layer here:
// doing so without confirmed real data risks introducing an incorrect
// "fix" for an unconfirmed assumption, and a free-text (non-select) custom
// field has no option ID to map to in the first place, so passthrough is
// the only sound default absent live confirmation either way. ***
function attachCustomFieldMap(raw, customFieldIds) {
  const custom_fields = {};
  for (const rawId of customFieldIds || []) {
    const key = stableId(rawId);
    if (!key) continue;
    const wireKey = `custom_${key}`;
    if (raw && Object.prototype.hasOwnProperty.call(raw, wireKey)) {
      custom_fields[key] = raw[wireKey];
    }
  }
  return { ...raw, custom_fields };
}

// ─── Group/serviceType/location/department membership index ────────────────

function ensureMembershipEntry(index, rawPersonId) {
  const id = stableId(rawPersonId);
  if (!id) return null;
  if (!index.has(id)) index.set(id, { groups: [], departments: [], serviceTypes: [], locations: [] });
  return index.get(id);
}

async function fetchMembershipDimension(client, dimensionKey, index) {
  const endpoint = DEFINITION_ENDPOINTS[dimensionKey];
  const result = await client.getAll(endpoint.path, { 'fields[]': ['people'] }, endpoint.collectionKey, endpoint.itemKey);

  for (const container of result.items || []) {
    // *** ID, not name: groups/serviceTypes/locations key their membership
    // entry by the container's stable `id` — departments are the one
    // documented exception and key by `name` instead, because Elvanto's
    // departments endpoint has no separate ID (see metadata.js's header
    // note). This mirrors metadata.js's own buildGroups()/buildDepartments()
    // split exactly. ***
    const value = dimensionKey === 'departments'
      ? trimmedOrNull(container && container.name)
      : stableId(container && container.id);
    if (!value) continue;

    const members = asArray(container && container.people && container.people.person);
    for (const member of members) {
      const personId = member && typeof member === 'object' ? member.id : member;
      const entry = ensureMembershipEntry(index, personId);
      if (entry) entry[dimensionKey].push(value);
    }
  }
}

// Returns a Map<personId, { groups, departments, serviceTypes, locations }>
// — exactly the `groupMemberships` shape normalizer.js's normalizeSnapshot()
// looks up per person by raw ID. Always refetches every dimension from
// scratch (see the header note on why incremental mode must not reuse a
// stale index).
async function fetchMembershipIndex(client) {
  const index = new Map();
  await Promise.all(MEMBERSHIP_DIMENSIONS.map((dimension) => fetchMembershipDimension(client, dimension, index)));
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
  const [peopleResult, membershipIndex] = await Promise.all([
    client.getAll(PEOPLE_PATH, params, PEOPLE_COLLECTION_KEY, PEOPLE_ITEM_KEY),
    fetchMembershipIndex(client),
  ]);

  const rawPeople = dedupeByIdKeepingNewest(peopleResult.items)
    .map((raw) => attachCustomFieldMap(raw, customFieldIds));

  const { people, families, skipped } = normalizeSnapshot(rawPeople, membershipIndex);
  const watermark = computeWatermark(rawPeople);

  return { people, families, skipped, watermark };
}

// Full paginated fetch — every status (Active/Contact/Archived/Deceased),
// no date_modified filter. `complete: true` is unconditional here because
// client.getAll()/fetchMembershipIndex() never resolve on a partial
// failure: httpClient.js's getAll() explicitly does not catch a failed page
// and never returns accumulated partial items (see its own header note) —
// it throws instead, which propagates straight out of this function. There
// is therefore no reachable code path in this adapter that could construct
// `complete: false`; per this project's global constraint, an incomplete
// fetch must throw, never silently report itself as complete or partial.
async function fetchFullSnapshot(client, customFieldIds, now) {
  const params = { 'fields[]': buildPeopleFields(customFieldIds) };
  const { people, families, skipped, watermark } = await fetchNormalizedPeople(client, params, customFieldIds);

  return {
    provider: 'elvanto',
    mode: 'full',
    complete: true,
    fetchedAt: now().toISOString(),
    watermark,
    people,
    families,
    skipped,
  };
}

// Incremental fetch — Elvanto `search[date_modified]` five minutes before
// the stored watermark (UTC, see computeIncrementalSearchCutoff above).
// Still refreshes the full group/serviceType/location/department membership
// index from scratch (see the header note on why) rather than reusing
// anything from a prior call. Same unconditional `complete: true` reasoning
// as fetchFullSnapshot above.
async function fetchIncrementalSnapshot(client, watermark, customFieldIds, now) {
  const searchCutoff = computeIncrementalSearchCutoff(watermark);
  const params = { 'fields[]': buildPeopleFields(customFieldIds), 'search[date_modified]': searchCutoff };
  const { people, families, skipped, watermark: newWatermark } = await fetchNormalizedPeople(client, params, customFieldIds);

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
    isEligible: isElvantoEligible,
  };
}

module.exports = {
  createElvantoAdapter,
  // Exported for direct unit testing of the pieces fetchSnapshot composes,
  // in addition to the end-to-end adapter-level tests in adapter.test.js.
  buildPeopleFields,
  attachCustomFieldMap,
  fetchMembershipIndex,
  dedupeByIdKeepingNewest,
  computeWatermark,
  computeIncrementalSearchCutoff,
};
