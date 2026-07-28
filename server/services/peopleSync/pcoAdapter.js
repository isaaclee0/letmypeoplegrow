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
const { isEligible, fromNormalized } = require('../planningCenter/eligibility');
const { toNormalizedPcoPerson, projectPcoHouseholds } = require('../planningCenter/projection');
const { getCachedPcoPeople, validatePlanningCenterToken } = require('../planningCenterSync');
const { fetchFieldDefinitions } = require('../planningCenter/fieldDefinitions');
const { tallyMembership } = require('../planningCenter/summary');

// PCO's batch filter shape ({ membershipFilterEnabled, membershipAllowlist,
// fieldFilterEnabled, fieldFilters }) has had exactly one shape since it shipped, so
// this is filter schema version 1. A future incompatible change to what a PCO batch's
// filterConfig looks like would need a version 2 here alongside a migration — see
// server/services/peopleSync/batchRepository.js's filterSchemaVersion column.
const FILTER_SCHEMA_VERSION = 1;
const NOT_SET = '$not_set';

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

function dimension({ id, label, cardinality, category, metadataValues = [], facts }) {
  const { counts, notSetCount } = valuesForFacts(facts, id);
  const ids = sortedValues([...metadataValues, ...counts.keys()]);
  return {
    id,
    label,
    cardinality,
    category,
    values: [
      ...ids.map((value) => ({ id: value, label: value, count: counts.get(value) || 0 })),
      ...(notSetCount > 0 ? [{ id: NOT_SET, label: 'Not set', count: notSetCount }] : []),
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
  const isCovered = (dimensionId) => !covered || covered.has(dimensionId);
  const memberships = (providerMetadata.memberships || []).map((item) => item && item.membership);
  const fieldDefinitions = Array.isArray(providerMetadata.fieldDefinitions) ? providerMetadata.fieldDefinitions : [];
  const dimensions = [];
  if (isCovered('membership')) dimensions.push(dimension({
    id: 'membership', label: 'Membership', cardinality: 'single', category: 'People', metadataValues: memberships, facts,
  }));
  for (const field of fieldDefinitions) {
    if (!field || typeof field.id !== 'string' || !field.id) continue;
    if (!isCovered(`custom_field:${field.id}`)) continue;
    dimensions.push(dimension({
      id: `custom_field:${field.id}`,
      label: field.name || `Custom field ${field.id}`,
      cardinality: field.dataType === 'checkboxes' ? 'multi' : 'single',
      category: 'Custom fields',
      metadataValues: field.options || [],
      facts,
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

// Default dependencies compose already-exported, already-tested PCO functions —
// nothing here reimplements HTTPS, token refresh, caching, or field-definition
// fetching. Injected in tests so no test in this file makes a real network call.
const defaultDeps = {
  fetchFieldDefinitions,
  async validateToken(accessToken) {
    return validatePlanningCenterToken(accessToken);
  },
  async fetchPeople(churchId, accessToken, options) {
    return getCachedPcoPeople(churchId, accessToken, options);
  },
  // Not wired into any current UI (the existing batch editor reads
  // planningCenter/metadataCache.js's persisted, church-scoped cache directly). This
  // gives the provider-neutral fetchMetadata contract a working PCO implementation
  // ahead of Task 9+ deciding whether/how to route the batch editor through it.
  async fetchMetadata(churchId, accessToken, options = {}, fieldDefinitionsFetcher = fetchFieldDefinitions, peopleFetcher = getCachedPcoPeople) {
    // Explicit filter refresh already fetched this full roster. Reuse that
    // exact snapshot rather than asking the PCO people cache/provider again.
    const peoplePromise = options.snapshot
      ? Promise.resolve({ people: options.snapshot.people || [] })
      : peopleFetcher(churchId, accessToken, options);
    const [{ people }, fieldDefinitions] = await Promise.all([peoplePromise, fieldDefinitionsFetcher(accessToken)]);
    // Metadata choices must describe the same eligible population as facts.
    // Archived/inactive-only memberships are not selectable positive values.
    return { memberships: tallyMembership(people.filter(isActivePcoPerson).map(metadataPerson)).values, fieldDefinitions };
  },
};

// Factory (not a singleton) so tests can inject fakes for every dependency without
// touching module state or making network calls. The object it returns is exactly
// the Task 5 adapter shape — providerRegistry.validateAdapter() rejects any adapter
// with extra own properties, so no helper methods or debug fields are attached here.
function createPcoAdapter(deps = {}) {
  const resolved = { ...defaultDeps, ...deps };

  return {
    provider: 'planning_center',

    async validateConnection({ credentials } = {}) {
      return resolved.validateToken(credentials && credentials.accessToken);
    },

    // PCO has no incremental fetch in this phase — every fetchSnapshot call
    // returns the complete current roster. `mode: 'full'` forces the underlying
    // 10-minute people cache to refresh (matching the existing "force" semantics
    // used by the "Refresh from Planning Center" button and the daily cron); any
    // other mode (including 'incremental', which PCO does not support) reuses the
    // cache. This does not change getCachedPcoPeople's own cache behaviour at all —
    // it only decides which of that function's existing two modes to ask for.
    async fetchSnapshot({ churchId, credentials, mode } = {}) {
      const accessToken = credentials && credentials.accessToken;
      const fetched = await resolved.fetchPeople(churchId, accessToken, { force: mode === 'full' });
      const rawPeople = fetched.people || [];
      return {
        provider: 'planning_center',
        mode: 'full',
        complete: true,
        fetchedAt: new Date(fetched.fetchedAt || Date.now()).toISOString(),
        watermark: null,
        people: rawPeople.map(toNormalizedPcoPerson),
        families: projectPcoHouseholds(rawPeople, fetched.householdPrimaryContacts),
      };
    },

    async fetchMetadata({ churchId, credentials, force, snapshot } = {}) {
      const accessToken = credentials && credentials.accessToken;
      return resolved.fetchMetadata(churchId, accessToken, snapshot === undefined ? { force } : { force, snapshot }, resolved.fetchFieldDefinitions, resolved.fetchPeople);
    },

    validateFilter: validatePcoFilter,

    // eligibility.js's isEligible() remains the single source of truth for PCO
    // filter semantics; fromNormalized() only reshapes the normalized person back
    // into what it already expects, so nothing about eligibility is reinterpreted.
    isEligible(person, filterConfig) {
      return isEligible(fromNormalized(person), filterConfig);
    },

    toFilterFacts: toPcoFilterFacts,

    buildFilterDimensions: buildPcoFilterDimensions,

    isInFilterPopulation(person) {
      return isActivePcoPerson(person);
    },
  };
}

module.exports = { createPcoAdapter, validatePcoFilter, FILTER_SCHEMA_VERSION, metadataPerson, isActivePcoPerson };
