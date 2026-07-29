// Provider-neutral adapter over Planning Center's existing fetch/cache/filter code
// (Task 8 of the provider-neutral people-sync project). This module is a
// compatibility wrapper, not a reimplementation: it does not change PCO's real fetch,
// cache, or filter behaviour. Nothing in the existing PCO pipeline (diffEngine.js,
// apply.js, routes/integrations.js, the cron scheduler) requires or is affected by
// this file yet — later tasks (9, 10, 15) are what actually route production traffic
// through it.
//
// This module intentionally does NOT call providerRegistry.registerProvider() at
// require time. Per the project plan (Task 14, "Register the adapter once at
// startup"), real registration happens via a `registerBuiltInProviders()` added to
// providerRegistry.js in Task 14, once the Elvanto adapter also exists — that keeps
// one single place responsible for wiring both providers into the live registry,
// and keeps this module side-effect-free so it can be required freely (including
// by this file's own tests) without any risk of a duplicate-registration throw.
const { validateFilterV2 } = require('./filterEngine');
const { listPlanningCenterSources, fetchPlanningCenterSourceSnapshot } = require('../planningCenter/sourceAdapter');

// PCO's batch filter shape ({ membershipFilterEnabled, membershipAllowlist,
// fieldFilterEnabled, fieldFilters }) has had exactly one shape since it shipped, so
// this is filter schema version 1. A future incompatible change to what a PCO batch's
// filterConfig looks like would need a version 2 here alongside a migration — see
// server/services/peopleSync/batchRepository.js's filterSchemaVersion column.
const FILTER_SCHEMA_VERSION = 1;
const NOT_SET = '$not_set';

function validateV2FilterWithoutProviderMetadata(config) {
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

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function canonicalValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Existing PCO filter metadata uses this display-only absence sentinel.
  // Canonical v2 facts represent the same condition by omitting the key.
  if (trimmed === '(none)') return null;
  return trimmed === NOT_SET ? '$$not_set' : trimmed;
}

function sortedValues(values) {
  return [...new Set((values || []).map(canonicalValue).filter(Boolean))].sort();
}

function valuesForFacts(facts, dimensionId) {
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

function dimension({ id, label, cardinality, category, metadataValues = [], facts, countsAvailable = true }) {
  const { counts, notSetCount } = valuesForFacts(facts, id);
  const ids = sortedValues([...metadataValues, ...counts.keys()]);
  return {
    id,
    label,
    cardinality,
    category,
    values: [
      ...ids.map((value) => ({ id: value, label: value, count: countsAvailable ? (counts.get(value) || 0) : null })),
      ...(countsAvailable
        ? (notSetCount > 0 ? [{ id: NOT_SET, label: 'Not set', count: notSetCount }] : [])
        : [{ id: NOT_SET, label: 'Not set', count: null }]),
    ],
  };
}

function toPcoFilterFacts(person, coveredDimensionIds) {
  const covered = coveredDimensionIds instanceof Set ? coveredDimensionIds : new Set(coveredDimensionIds || []);
  // The live PCO cache stores projected people while filter snapshots store
  // normalized people. Treat both representations deliberately here.
  const attributes = person && person.attributes || {
    membership: person && person.membership,
    fieldValues: person && person.fieldValues,
  };
  const dimensions = {};
  if (covered.has('membership')) {
    const values = sortedValues([attributes.membership]);
    if (values.length) dimensions.membership = values;
  }
  for (const dimensionId of covered) {
    if (!dimensionId.startsWith('custom_field:')) continue;
    const fieldId = dimensionId.slice('custom_field:'.length);
    const values = sortedValues(attributes.fieldValues && attributes.fieldValues[fieldId]);
    if (values.length) dimensions[dimensionId] = values;
  }
  return { externalPersonId: String(person && person.id || ''), dimensions };
}

function metadataPerson(person) {
  const attributes = person && person.attributes || {};
  return {
    membership: person?.membership ?? attributes.membership ?? null,
    fieldValues: person?.fieldValues ?? attributes.fieldValues ?? {},
  };
}

function isActivePcoPerson(person) {
  return person && (person.state === 'active' || person.status === 'active');
}

function buildPcoFilterDimensions({ facts = [], providerMetadata = {}, coveredDimensionIds } = {}) {
  const covered = coveredDimensionIds === undefined
    ? null
    : new Set(coveredDimensionIds instanceof Set ? coveredDimensionIds : coveredDimensionIds || []);
  const countsAvailable = (dimensionId) => !covered || covered.has(dimensionId);
  const memberships = (providerMetadata.memberships || []).map((item) => item && item.membership);
  const fieldDefinitions = Array.isArray(providerMetadata.fieldDefinitions) ? providerMetadata.fieldDefinitions : [];
  const dimensions = [];
  dimensions.push(dimension({
    id: 'membership', label: 'Membership', cardinality: 'single', category: 'People', metadataValues: memberships, facts,
    countsAvailable: countsAvailable('membership'),
  }));
  for (const field of fieldDefinitions) {
    if (!field || typeof field.id !== 'string' || !field.id) continue;
    const id = `custom_field:${field.id}`;
    dimensions.push(dimension({
      id,
      label: field.name || `Custom field ${field.id}`,
      cardinality: field.dataType === 'checkboxes' ? 'multi' : 'single',
      category: 'Custom fields',
      metadataValues: field.options || [],
      facts,
      countsAvailable: countsAvailable(id),
    }));
  }
  return dimensions.sort((left, right) => left.id.localeCompare(right.id));
}

// Validates the filter portion of a PCO batch only — name/schedule/gathering fields
// are a separate concern (see routes/integrations.js's validateBatchBody, which this
// does not replace). Mirrors that function's existing membership/field-filter rules
// so the two don't silently diverge, but lives here so Task 9+ can validate a bare
// filterConfig against the Task 5 adapter contract without a whole batch body.
function validatePcoFilter(filterConfig, schemaVersion = FILTER_SCHEMA_VERSION) {
  if (schemaVersion === 2) return validateV2FilterWithoutProviderMetadata(filterConfig);
  if (schemaVersion !== FILTER_SCHEMA_VERSION) {
    return { ok: false, value: null, errors: [`Unsupported planning_center filter schema version: ${schemaVersion}`] };
  }

  const cfg = filterConfig || {};
  const errors = [];
  if (typeof cfg.membershipFilterEnabled !== 'boolean') errors.push('membershipFilterEnabled must be a boolean.');
  if (typeof cfg.fieldFilterEnabled !== 'boolean') errors.push('fieldFilterEnabled must be a boolean.');
  if (!isStringArray(cfg.membershipAllowlist)) errors.push('membershipAllowlist must be an array of strings.');

  let fieldFilters = null;
  if (!Array.isArray(cfg.fieldFilters)) {
    errors.push('fieldFilters must be an array.');
  } else {
    const allValid = cfg.fieldFilters.every((rule) =>
      rule && typeof rule.fieldDefinitionId === 'string' && isStringArray(rule.values));
    if (!allValid) {
      errors.push('Each field filter rule needs a fieldDefinitionId and an array of string values.');
    } else {
      fieldFilters = cfg.fieldFilters;
    }
  }

  if (errors.length > 0) return { ok: false, value: null, errors };

  return {
    ok: true,
    errors: [],
    value: {
      membershipFilterEnabled: cfg.membershipFilterEnabled,
      membershipAllowlist: [...cfg.membershipAllowlist],
      fieldFilterEnabled: cfg.fieldFilterEnabled,
      fieldFilters: fieldFilters.map((rule) => ({ fieldDefinitionId: rule.fieldDefinitionId, values: [...rule.values] })),
    },
  };
}

// Dependencies stay injectable so source reads can be exercised without a network
// connection. Source enumeration/snapshots intentionally do not compose the old
// full-people cache.
const defaultDeps = {
  async validateToken(accessToken) {
    // Keep the legacy PCO sync module out of this adapter's require graph. It
    // currently depends on filter-preview modules that import validatePcoFilter
    // from here; lazy loading avoids that old migration-cycle warning while this
    // source adapter remains independent of the full-people cache.
    return require('../planningCenterSync').validatePlanningCenterToken(accessToken);
  },
  async listSources({ accessToken }) {
    return listPlanningCenterSources({ accessToken });
  },
  async fetchSourceSnapshot({ accessToken, sourceKind, sourceExternalId }) {
    return fetchPlanningCenterSourceSnapshot({ accessToken, sourceKind, sourceExternalId });
  },
};

// Factory (not a singleton) so tests can inject fakes for every dependency without
// touching module state or making network calls. It returns only the source-era
// contract; providerRegistry is migrated in the subsequent source-runtime task.
function createPcoAdapter(deps = {}) {
  const resolved = { ...defaultDeps, ...deps };

  return {
    provider: 'planning_center',

    async validateConnection({ credentials } = {}) {
      return resolved.validateToken(credentials && credentials.accessToken);
    },

    // Source reads use the church's already-established connection, but are
    // deliberately independent from the legacy full-people cache. A List is a
    // provider-owned selection, not a client-side filter over that cache.
    async listSources({ credentials } = {}) {
      return resolved.listSources({ accessToken: credentials && credentials.accessToken });
    },

    async fetchSourceSnapshot({ credentials, sourceKind, sourceExternalId } = {}) {
      return resolved.fetchSourceSnapshot({
        accessToken: credentials && credentials.accessToken,
        sourceKind,
        sourceExternalId,
      });
    },

    // Planning Center terminal-state handling is source hygiene rather than a
    // configurable local filter. Accept both the source snapshot's normalized
    // state and the existing raw PCO projection while old call sites migrate.
    isLifecycleEligible(person) {
      return !!person && (person.state === 'active' || person.status === 'active');
    },
  };
}

module.exports = { createPcoAdapter, validatePcoFilter, FILTER_SCHEMA_VERSION, metadataPerson, isActivePcoPerson };
