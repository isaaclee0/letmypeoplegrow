'use strict';

// Normalizes raw Elvanto "person" records (as returned by
// server/services/elvanto/httpClient.js's getAll(), or any equivalent
// already-fetched plain JS object/array) into the Task 5 provider-neutral
// normalized person/family shape that server/services/peopleSync/matcher.js
// and plan.js already consume — the same job Task 8's
// planningCenter/projection.js#toNormalizedPcoPerson/projectPcoHouseholds did
// for Planning Center.
//
// This module does NOT call httpClient.js and makes no network calls: it is
// a pure, side-effect-free transform from raw records to the normalized
// shape, so it can be fully covered by fixtures + node:test without any
// mocking.
//
// ─── Field-name provenance (see fixtures/people.js for the full rationale) ──
//
// Confirmed against existing code in this repo (server/routes/integrations.js,
// the legacy one-shot Elvanto importer, and server/services/elvanto/
// httpClient.test.js):
//   id, firstname, lastname, preferred_name, family_id, family_relationship
//   ('Primary Contact' | 'Spouse' | 'Child'), archived (0/1 or '0'/'1').
//
// Given directly by this task's own spec (authoritative, not inferred):
//   deceased, contact (same '1'/'0'-style flags as archived) — status
//   precedence deceased > archived > contact > active.
//
// Inferred, NOT independently confirmed against Elvanto's API docs (the repo
// has no code path exercising these): category/category_id, date_modified,
// custom_fields, demographics. Handled defensively below (accepting more than
// one plausible wire shape) rather than blocking Task 12 on confirming them —
// flagged clearly in this task's report for Task 13/14 to revisit once real
// Elvanto responses are available.
//
// Elvanto's real API doesn't return group/department/service-type/location
// membership on the person record itself (confirmed by the legacy importer's
// separate groups/getAll.json, services/getAll.json, departments/getAll.json,
// locations/getAll.json calls) — a person's own memberships have to be
// assembled by the CALLER from those separate endpoints. normalizePerson's
// second argument, `memberships`, is that already-assembled per-person bundle
// (`{ groups, departments, serviceTypes, locations }`, each a plain array of
// strings); normalizeSnapshot's second argument, `groupMemberships`, is the
// same bundle keyed by raw person ID (a Map or plain object) for every person
// in the snapshot, looked up per record. This is a structural design decision
// for this task to make explicit for Task 13/14: neither the exact shape
// Elvanto's group-membership endpoints return, nor how Task 14's adapter will
// assemble this map, is specified anywhere upstream of this task.
//
// Task 13 (server/services/elvanto/filter.js, metadata.js) resolves that open
// question and requires it be followed here: every group/serviceType/location
// entry in the `memberships` bundle above, and every key AND value in
// `raw.custom_fields`, MUST be Elvanto's stable ID — never a display name or
// label — even though the fixtures/tests in *this* file use plain names
// ('Choir', 'Sunday AM', 'Main Campus') as opaque strings to exercise
// dedupe/sort only. filter.js's isElvantoEligible() matches
// attributes.groups/serviceTypes/locations against config.{groups,
// serviceTypes,locations}.ids, and attributes.customFields is looked up by
// config.customFields[].fieldId with values compared against
// config.customFields[].values — both sides of every comparison are IDs
// sourced from metadata.js's definition lists (groups[].id, customFields[].id,
// customFields[].values[].id, etc). Whoever assembles the real `memberships`/
// `groupMemberships` bundle (Task 14's adapter) must key/populate it with
// those same stable IDs, or eligibility and member counts will silently
// compute to zero with no error anywhere. attributes.departments is the one
// exception — Elvanto's departments endpoint has no separate ID, so it stays
// a flat array of department NAME strings (see metadata.js's header note).
//
// Per this project's global constraint, LMPG individuals do not store email
// or mobile, so neither field is read here even if present on a raw record —
// they are simply never copied into the normalized shape or its attributes.

function stableId(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function trimmedOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Unlike trimmedOrEmpty (used only for firstname/lastname, which Elvanto
// always sends as strings), this also coerces a bare number to a string
// before trimming — family_id/category_id/etc. are exactly the kind of
// identifier field that can arrive as either a string or a number depending
// on the API response (server/services/peopleSync/matcher.js's
// canonicalExternal() already has to tolerate both for familyId across
// providers), so silently treating a numeric ID as blank here would be a
// real correctness bug, not just a style nit.
function trimmedOrNull(value) {
  if (value === null || value === undefined) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  return trimmed ? trimmed : null;
}

function truthyFlag(value) {
  // Elvanto's confirmed convention for `archived` is a '1'/'0' string (see
  // the legacy importer's `p.archived === 1 || p.archived === '1'`). Also
  // accept numeric 1 and boolean true defensively, in case a different
  // Elvanto response shape (or a future API version) returns those instead —
  // documented here rather than assumed silently.
  return value === '1' || value === 1 || value === true;
}

function hasUsableName(raw) {
  return Boolean(trimmedOrEmpty(raw && raw.firstname)) || Boolean(trimmedOrEmpty(raw && raw.lastname));
}

// Returns the skip reason code for an invalid raw record, or null if the
// record is usable. Missing ID takes precedence over missing name: without a
// stable ID there is nothing else to say about the record.
function classifyInvalid(raw) {
  if (!stableId(raw && raw.id)) return 'MISSING_ID';
  if (!hasUsableName(raw)) return 'MISSING_NAME';
  return null;
}

// ─── Status precedence: deceased > archived > contact > active ────────────
function deriveElvantoState(raw) {
  if (!raw) return 'active';
  if (truthyFlag(raw.deceased)) return 'deceased';
  if (truthyFlag(raw.archived)) return 'archived';
  if (truthyFlag(raw.contact)) return 'contact';
  return 'active';
}

// ─── Child state, from family_relationship ONLY ────────────────────────────
// Deliberately does NOT infer from birthday/age — the task spec only ever
// derives this from family_relationship, and explicitly requires blank/absent
// signal to stay null rather than become a guess. 'Primary Contact' and
// 'Spouse' are treated as definitionally adult relationship labels (not an
// age guess — an explicit relationship designation), matching the same three
// labels the legacy Elvanto importer already recognizes
// (routes/integrations.js: 'Primary Contact' | 'Spouse' | 'Child').
const CHILD_RELATIONSHIPS = new Set(['child']);
const ADULT_RELATIONSHIPS = new Set(['primary contact', 'spouse']);

function deriveChildState(raw) {
  const relationship = trimmedOrEmpty(raw && raw.family_relationship).toLowerCase();
  if (!relationship) return null;
  if (CHILD_RELATIONSHIPS.has(relationship)) return true;
  if (ADULT_RELATIONSHIPS.has(relationship)) return false;
  return null;
}

// ─── attributes sub-shape helpers ───────────────────────────────────────────

function sortedUniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  const cleaned = value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(cleaned)].sort();
}

// Demographics' raw wire shape is not confirmed (see file-header note), so
// this accepts either an object map (`{ field: value }`) or an array of
// `{ field | name | key, value }` entries, and normalizes both into a sorted
// array of `{ field, value }` — matching the Interfaces section's
// `demographics: []` shape. Blank/null/undefined values are dropped, the same
// way projection.js's projectPerson() drops blank PCO field-datum values.
function normalizeDemographics(raw) {
  const entries = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const field = item.field ?? item.name ?? item.key;
      const value = item.value;
      if (field === null || field === undefined) continue;
      if (value === null || value === undefined || value === '') continue;
      entries.push({ field: String(field), value });
    }
  } else if (raw && typeof raw === 'object') {
    for (const [field, value] of Object.entries(raw)) {
      if (value === null || value === undefined || value === '') continue;
      entries.push({ field, value });
    }
  }
  return entries.sort((a, b) => a.field.localeCompare(b.field));
}

// customFields keeps whatever value shape Elvanto sends per field (a single
// string, or an array for a multi-select/checkbox-style field) — normalizer
// never collapses a list to a single value or vice versa. Accepts either an
// object map (the assumed common case) or an array of
// `{ name | field | id, value }` entries (defensively, for an alternate wire
// shape), converting the array form into the same object shape.
function normalizeCustomFields(raw) {
  const result = {};
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const name = item.name ?? item.field ?? item.id;
      if (name === null || name === undefined) continue;
      result[String(name)] = item.value;
    }
  } else if (raw && typeof raw === 'object') {
    Object.assign(result, raw);
  }
  const sorted = {};
  for (const key of Object.keys(result).sort()) sorted[key] = result[key];
  return sorted;
}

function membershipList(memberships, key) {
  return sortedUniqueStrings(memberships && memberships[key]);
}

function categoryIdOf(raw) {
  if (!raw) return null;
  if (raw.category && typeof raw.category === 'object') {
    return trimmedOrNull(raw.category.id !== undefined && raw.category.id !== null ? String(raw.category.id) : null);
  }
  if (raw.category_id !== undefined && raw.category_id !== null) {
    return trimmedOrNull(String(raw.category_id));
  }
  return null;
}

// ─── normalizePerson ─────────────────────────────────────────────────────────
//
// Returns the Task 5 normalized person shape, or null when the record is
// missing a stable ID or both usable names (see classifyInvalid above) —
// normalizeSnapshot is what turns a null result into a `skipped` entry with a
// reason code; normalizePerson itself stays a plain, reusable per-record
// transform with no bookkeeping of its own.
function normalizePerson(raw, memberships = {}) {
  if (classifyInvalid(raw)) return null;

  return {
    provider: 'elvanto',
    id: stableId(raw.id),
    firstName: trimmedOrEmpty(raw.firstname),
    preferredName: trimmedOrNull(raw.preferred_name),
    lastName: trimmedOrEmpty(raw.lastname),
    state: deriveElvantoState(raw),
    child: deriveChildState(raw),
    familyId: trimmedOrNull(raw.family_id),
    familyRelationship: trimmedOrNull(raw.family_relationship),
    categoryId: categoryIdOf(raw),
    modifiedAt: trimmedOrNull(raw.date_modified),
    attributes: {
      groups: membershipList(memberships, 'groups'),
      demographics: normalizeDemographics(raw.demographics),
      departments: membershipList(memberships, 'departments'),
      serviceTypes: membershipList(memberships, 'serviceTypes'),
      locations: membershipList(memberships, 'locations'),
      customFields: normalizeCustomFields(raw.custom_fields),
    },
  };
}

function lookupMemberships(groupMemberships, rawId) {
  if (!groupMemberships) return {};
  const key = stableId(rawId);
  if (groupMemberships instanceof Map) return groupMemberships.get(key) || {};
  if (typeof groupMemberships === 'object') return groupMemberships[key] || {};
  return {};
}

function compareStableId(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─── normalizeSnapshot ───────────────────────────────────────────────────────
//
// Returns { people, families, skipped }. This exact shape is a structural
// design decision this task has to make explicit (the spec describes the
// pieces but not the container): `people`/`families` mirror pcoAdapter.js's
// fetchSnapshot() `people`/`families` fields exactly, and `skipped` is added
// alongside them (rather than, say, nested under people) so a caller can
// destructure all three siblings the same way. Task 14's Elvanto adapter is
// expected to call this and copy `people`/`families` onto its own
// fetchSnapshot() result (adding provider/mode/complete/fetchedAt/watermark
// the same way pcoAdapter.js does), and to surface `skipped` separately
// (e.g. into a sync run's audit/summary) rather than silently dropping it.
function normalizeSnapshot(rawPeople, groupMemberships) {
  const people = [];
  const skipped = [];

  for (const raw of rawPeople || []) {
    const reason = classifyInvalid(raw);
    if (reason) {
      const id = stableId(raw && raw.id);
      skipped.push({ id: id || null, reason });
      continue;
    }
    const memberships = lookupMemberships(groupMemberships, raw.id);
    people.push(normalizePerson(raw, memberships));
  }

  people.sort((a, b) => compareStableId(a.id, b.id));
  skipped.sort((a, b) => compareStableId(a.id || '', b.id || '') || compareStableId(a.reason, b.reason));

  return { people, families: buildElvantoFamilies(people), skipped };
}

// ─── buildElvantoFamilies ────────────────────────────────────────────────────
//
// Groups already-normalized people (normalizePerson's output — familyId is
// the raw Elvanto family_id, familyRelationship is the raw
// 'Primary Contact' | 'Spouse' | 'Child' | other string) by familyId. People
// with no familyId ("solo" people) are excluded from the result entirely —
// same convention as planningCenter/projection.js's projectPcoHouseholds,
// which only ever creates a family entry for a person with a householdId.
//
// Unlike projectPcoHouseholds, this ALSO derives a `name`, because Elvanto's
// family_relationship vocabulary lets us identify a real primary contact
// deterministically (PCO's normalized shape has no equivalent signal at this
// layer), and Task 13's addFamilies/renameFamily plan actions need a reviewed
// name to propose. Naming mirrors the spirit of
// server/services/planningCenter/familyName.js's buildFamilyName (adults
// first, primary/head member first, "Lastname, Firstname and Firstname") —
// re-implemented locally here rather than imported from the planningCenter/
// directory, so this Elvanto-specific module has no dependency on another
// provider's module.
function buildFamilyName(orderedMembers) {
  const adults = orderedMembers.filter((member) => member.child !== true);
  const nameMembers = adults.length ? adults : orderedMembers;
  const lastName = (nameMembers[0] && nameMembers[0].lastName) || 'Unknown';
  const firstNames = nameMembers
    .map((member) => member.preferredName || member.firstName)
    .filter(Boolean);
  return firstNames.length ? `${lastName}, ${firstNames.join(' and ')}` : lastName;
}

function isPrimaryContact(person) {
  return trimmedOrEmpty(person.familyRelationship).toLowerCase() === 'primary contact';
}

function buildElvantoFamilies(people) {
  const byFamily = new Map();
  for (const person of people || []) {
    if (person.familyId === null || person.familyId === undefined) continue;
    const key = stableId(person.familyId);
    if (!key) continue;
    if (!byFamily.has(key)) byFamily.set(key, []);
    byFamily.get(key).push(person);
  }

  const families = [];
  for (const [familyId, members] of byFamily) {
    const sortedMembers = [...members].sort((a, b) => compareStableId(a.id, b.id));
    const primaryContact = sortedMembers.find(isPrimaryContact) || null;
    const orderedForName = primaryContact
      ? [primaryContact, ...sortedMembers.filter((member) => member !== primaryContact)]
      : sortedMembers;

    families.push({
      id: familyId,
      name: buildFamilyName(orderedForName),
      memberExternalIds: sortedMembers.map((member) => member.id),
      primaryContactExternalId: primaryContact ? primaryContact.id : null,
    });
  }

  return families.sort((a, b) => compareStableId(a.id, b.id));
}

module.exports = {
  normalizePerson,
  normalizeSnapshot,
  deriveElvantoState,
  deriveChildState,
  buildElvantoFamilies,
};
