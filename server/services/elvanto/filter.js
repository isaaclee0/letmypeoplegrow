'use strict';

// Elvanto's batch filter — schema version 1 — plus its validator and
// eligibility evaluator (Task 13 of the provider-neutral people-sync
// project). Sibling to server/services/planningCenter/eligibility.js and
// server/services/peopleSync/pcoAdapter.js#validatePcoFilter, which
// establish the same `{ ok, value, errors }` validation-result contract and
// (for PCO) a much simpler single-dimension filter. Elvanto's filter is
// richer: several independent dimensions, each with its own any/all
// selection operator, all ANDed together.
//
// ─── Filter schema version 1 shape ─────────────────────────────────────────
//
//   {
//     statuses: string[],                                  // non-empty, from VALID_STATUSES
//     categoryIds: string[],                                // matched with plain .includes()
//     groups:        { ids: string[],    operator: 'any'|'all' },
//     demographics:  { values: string[], operator: 'any'|'all' },
//     departments:   { values: string[], operator: 'any'|'all' },
//     serviceTypes:  { ids: string[],    operator: 'any'|'all' },
//     locations:     { ids: string[],    operator: 'any'|'all' },
//     customFields:  [{ fieldId: string, values: string[], operator: 'any'|'all' }],
//   }
//
// ─── Convention this task sets for Task 14 (the adapter) ───────────────────
//
// Task 12's normalizer (server/services/elvanto/normalizer.js) deliberately
// left the *contents* of a normalized person's attributes.groups/
// serviceTypes/locations/customFields unspecified — its own header note
// says "neither the exact shape Elvanto's group-membership endpoints
// return, nor how Task 14's adapter will assemble this map, is specified
// anywhere upstream of this task." (Task 12's own normalizer.test.js
// fixtures use plain display names like 'Choir'/'Sunday AM'/'Main Campus'
// as opaque strings for exercising dedupe/sort only — not a statement that
// names are the real-world convention.) This task resolves that open
// question, matching metadata.js's id-bearing definition lists:
//
//   - attributes.groups / attributes.serviceTypes / attributes.locations
//     MUST hold the group/service-type/location's stable ID — the same ID
//     metadata.js's groups[].id / serviceTypes[].id / locations[].id use,
//     and the same ID this file's config.groups.ids / .serviceTypes.ids /
//     .locations.ids compare against. Never a display name.
//   - attributes.customFields MUST be keyed by the custom field's stable ID
//     (matching metadata.js's customFields[].id and this file's
//     config.customFields[].fieldId), not by display name.
//   - attributes.departments stays a flat array of department NAME strings
//     (matching config.departments.values) because Elvanto's departments
//     endpoint has no separate numeric ID to key by — see metadata.js's
//     header note for why.
//   - attributes.demographics stays Task 12's `[{ field, value }]` pairs;
//     isElvantoEligible (below) flattens it to a bag of raw `value`s,
//     discarding which demographic field each value came from, matching
//     metadata.js's field-agnostic demographics tally. Elvanto exposes no
//     stable "demographic definition" endpoint, so a value is a value
//     regardless of which field it lives on.
//
// ─── Where the church-wide "include contacts" setting is enforced ──────────
//
// people_sync_settings.elvanto_include_contacts (church-level, default on)
// is NOT part of this filter schema and isElvantoEligible does not take an
// includeContacts parameter. It is enforced one layer up, in the
// provider-neutral plan builder: server/services/peopleSync/plan.js's
// computePeopleSyncPlan() already excludes 'contact'-state external people
// from populationIds entirely when `input.settings.includeContacts ===
// false` (see plan.js's `normalizeState(externalPerson.state) === 'contact'
// && input.settings?.includeContacts === false` check, which runs before
// any batch/filter eligibility is consulted). That population gate applies
// uniformly to every provider's plan, Elvanto included, so a per-provider
// filter module re-implementing it here would just create a second,
// divergent copy of the same rule. filter.test.js proves the *shape* of
// this guarantee — a batch filter that explicitly allows the 'contact'
// status still cannot make a contact-state person eligible once that
// person has already been removed from the population the filter is
// evaluated over.

const FILTER_SCHEMA_VERSION = 1;
const { evaluateFilterV2, validateFilterV2 } = require('../peopleSync/filterEngine');

const VALID_STATUSES = new Set(['active', 'contact', 'archived', 'deceased']);
const VALID_OPERATORS = new Set(['any', 'all']);
const TOP_LEVEL_KEYS = new Set([
  'statuses', 'categoryIds', 'groups', 'demographics', 'departments', 'serviceTypes', 'locations', 'customFields',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function dedupeStrings(values) {
  return [...new Set(values)];
}

// Validates and normalizes a { ids|values, operator } dimension. `member` is
// 'ids' or 'values' (the two vocabularies the version-1 schema uses).
function validateSelectionSet(raw, label, member, errors) {
  if (!isPlainObject(raw)) {
    errors.push(`${label} must be an object with { ${member}, operator }.`);
    return null;
  }
  const list = raw[member];
  const listOk = isStringArray(list);
  if (!listOk) errors.push(`${label}.${member} must be an array of strings.`);
  const operatorOk = VALID_OPERATORS.has(raw.operator);
  if (!operatorOk) errors.push(`${label}.operator must be "any" or "all".`);
  if (!listOk || !operatorOk) return null;
  return { [member]: dedupeStrings(list), operator: raw.operator };
}

function validateCustomFieldRules(raw, errors) {
  if (!Array.isArray(raw)) {
    errors.push('customFields must be an array.');
    return null;
  }
  const byFieldId = new Map();
  for (const rule of raw) {
    if (!isPlainObject(rule) || typeof rule.fieldId !== 'string' || !rule.fieldId) {
      errors.push('Each customFields rule needs a string fieldId.');
      continue;
    }
    if (!isStringArray(rule.values)) {
      errors.push(`customFields[${rule.fieldId}].values must be an array of strings.`);
      continue;
    }
    if (!VALID_OPERATORS.has(rule.operator)) {
      errors.push(`customFields[${rule.fieldId}].operator must be "any" or "all".`);
      continue;
    }
    // Duplicate fieldIds are normalized away (first occurrence wins), same
    // spirit as dedupeStrings() for a plain ID/value array.
    if (!byFieldId.has(rule.fieldId)) {
      byFieldId.set(rule.fieldId, { fieldId: rule.fieldId, values: dedupeStrings(rule.values), operator: rule.operator });
    }
  }
  if (errors.length > 0) return null;
  return [...byFieldId.values()];
}

// Strict allow-list validator for an Elvanto batch filter. Returns
// { ok: true, value: <sanitized config>, errors: [] } on success, or
// { ok: false, value: null, errors: [...] } listing every problem found
// (not just the first) — mirrors pcoAdapter.js#validatePcoFilter's
// contract shape exactly.
function validateElvantoFilter(config, schemaVersion = FILTER_SCHEMA_VERSION) {
  if (schemaVersion === 2) {
    const dimensions = new Map();
    for (const branch of Array.isArray(config && config.branches) ? config.branches : []) {
      for (const group of Array.isArray(branch && branch.groups) ? branch.groups : []) {
        if (typeof group?.dimensionId === 'string') dimensions.set(group.dimensionId, new Set(group.values || []));
      }
    }
    for (const group of Array.isArray(config && config.exclusions) ? config.exclusions : []) {
      if (typeof group?.dimensionId === 'string') dimensions.set(group.dimensionId, new Set(group.values || []));
    }
    return validateFilterV2(config, {
      dimensions: [...dimensions].map(([id, values]) => ({ id, cardinality: 'multi', values: [...values].map((value) => ({ id: value })) })),
    });
  }
  if (schemaVersion !== FILTER_SCHEMA_VERSION) {
    return { ok: false, value: null, errors: [`Unsupported elvanto filter schema version: ${schemaVersion}`] };
  }
  if (!isPlainObject(config)) {
    return { ok: false, value: null, errors: ['Filter config must be an object.'] };
  }

  const errors = [];
  for (const key of Object.keys(config)) {
    if (!TOP_LEVEL_KEYS.has(key)) errors.push(`Unknown filter key: ${key}`);
  }

  if (!isStringArray(config.statuses) || config.statuses.length === 0) {
    errors.push('statuses must be a non-empty array of strings.');
  } else if (!config.statuses.every((status) => VALID_STATUSES.has(status))) {
    errors.push('statuses contains an unknown status.');
  }

  if (!isStringArray(config.categoryIds)) errors.push('categoryIds must be an array of strings.');

  const groups = validateSelectionSet(config.groups, 'groups', 'ids', errors);
  const serviceTypes = validateSelectionSet(config.serviceTypes, 'serviceTypes', 'ids', errors);
  const locations = validateSelectionSet(config.locations, 'locations', 'ids', errors);
  const demographics = validateSelectionSet(config.demographics, 'demographics', 'values', errors);
  const departments = validateSelectionSet(config.departments, 'departments', 'values', errors);
  const customFields = validateCustomFieldRules(config.customFields, errors);

  if (errors.length > 0) return { ok: false, value: null, errors };

  return {
    ok: true,
    errors: [],
    value: {
      statuses: dedupeStrings(config.statuses),
      categoryIds: dedupeStrings(config.categoryIds),
      groups, demographics, departments, serviceTypes, locations, customFields,
    },
  };
}

// ─── Evaluation ──────────────────────────────────────────────────────────

// True when `selected` (the batch's configured allow-list for one
// dimension) is empty — an unconfigured dimension is ignored, never a
// reason to exclude everyone — or when `values` (the person's own values
// for that dimension) satisfy the any/all operator against `selected`.
// Comparison is string-based so numeric-looking IDs from either side match
// regardless of whether they arrived as a number or a string.
function matchesSet(values, selected, operator) {
  const wanted = Array.isArray(selected) ? selected : [];
  if (wanted.length === 0) return true;

  const raw = values === null || values === undefined ? [] : Array.isArray(values) ? values : [values];
  const have = new Set(raw.filter((item) => item !== null && item !== undefined).map(String));

  if (operator === 'all') return wanted.every((item) => have.has(String(item)));
  return wanted.some((item) => have.has(String(item)));
}

// Task 12's attributes.demographics is `[{ field, value }]`; this file's
// filter dimension (and metadata.js's tally) operate on the flat bag of
// `value`s, dropping which field each came from. Also tolerates a
// caller that already hands over a flat array of scalar values.
function demographicValues(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => (item && typeof item === 'object' && 'value' in item ? item.value : item))
    .filter((value) => value !== null && value !== undefined);
}

// Evaluates a single normalized Elvanto person (Task 12's normalizePerson()
// output) against an already-validated filter config (validateElvantoFilter's
// `.value`, or any config already known to match that shape). Every
// dimension is independently optional (empty = ignored) and every
// non-empty dimension combines with the others via AND — there is no
// any-source-matches-wins semantics here (unlike PCO's eligibility.js),
// because Elvanto's filter is a single richly-dimensioned allow-list, not a
// set of alternative sources.
function isElvantoEligible(person, config, schemaVersion = FILTER_SCHEMA_VERSION) {
  if (schemaVersion === 2) {
    const attributes = (person && person.attributes) || {};
    const dimensions = {
      status: person?.state ? [String(person.state)] : [],
      category: person?.categoryId == null ? [] : [String(person.categoryId)],
      groups: (attributes.groups || []).map(String),
      demographics: demographicValues(attributes.demographics).map(String),
      departments: (attributes.departments || []).map(String),
      service_types: (attributes.serviceTypes || []).map(String),
      locations: (attributes.locations || []).map(String),
    };
    for (const [fieldId, values] of Object.entries(attributes.customFields || {})) {
      dimensions[`custom_field:${fieldId}`] = (Array.isArray(values) ? values : [values]).filter((value) => value != null).map(String);
    }
    return evaluateFilterV2({ externalPersonId: String(person?.id || ''), dimensions }, config);
  }
  const attributes = (person && person.attributes) || {};

  if (!Array.isArray(config.statuses) || !config.statuses.includes(person && person.state)) return false;

  if (Array.isArray(config.categoryIds) && config.categoryIds.length > 0) {
    const categoryId = person && person.categoryId;
    if (categoryId === null || categoryId === undefined || !config.categoryIds.includes(categoryId)) return false;
  }

  if (!matchesSet(attributes.groups, config.groups.ids, config.groups.operator)) return false;
  if (!matchesSet(demographicValues(attributes.demographics), config.demographics.values, config.demographics.operator)) return false;
  if (!matchesSet(attributes.departments, config.departments.values, config.departments.operator)) return false;
  if (!matchesSet(attributes.serviceTypes, config.serviceTypes.ids, config.serviceTypes.operator)) return false;
  if (!matchesSet(attributes.locations, config.locations.ids, config.locations.operator)) return false;

  const customFields = Array.isArray(config.customFields) ? config.customFields : [];
  return customFields.every((rule) =>
    matchesSet((attributes.customFields && attributes.customFields[rule.fieldId]) || [], rule.values, rule.operator));
}

module.exports = {
  FILTER_SCHEMA_VERSION,
  VALID_STATUSES,
  validateElvantoFilter,
  isElvantoEligible,
  matchesSet,
};
