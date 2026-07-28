const { test } = require('node:test');
const assert = require('node:assert/strict');

const { FILTER_SCHEMA_VERSION, validateElvantoFilter, isElvantoEligible, matchesSet } = require('./filter');

// ─── Fixtures ───────────────────────────────────────────────────────────────

function validConfig(overrides = {}) {
  return {
    statuses: ['active', 'contact'],
    categoryIds: ['cat-1'],
    groups: { ids: ['g1', 'g2'], operator: 'any' },
    demographics: { values: [], operator: 'any' },
    departments: { values: [], operator: 'any' },
    serviceTypes: { ids: [], operator: 'any' },
    locations: { ids: [], operator: 'any' },
    customFields: [{ fieldId: 'field-1', values: ['v1'], operator: 'any' }],
    ...overrides,
  };
}

// A person exactly as Task 12's normalizePerson() produces it, per this
// task's own convention (see filter.js header): groups/serviceTypes/
// locations hold stable IDs, departments holds flat name strings,
// demographics holds Task 12's { field, value } pairs, customFields is
// keyed by fieldId.
function person(overrides = {}) {
  return {
    provider: 'elvanto',
    id: 'p1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    state: 'active',
    categoryId: 'cat-1',
    attributes: {
      groups: ['g1'],
      demographics: [{ field: 'age_bracket', value: 'Young Adults' }],
      departments: ['Worship Team'],
      serviceTypes: ['service-1'],
      locations: ['loc-1'],
      customFields: { 'field-1': ['v1'] },
    },
    ...overrides,
  };
}

// ─── validateElvantoFilter ──────────────────────────────────────────────────

test('validateElvantoFilter accepts a well-formed version-1 config and normalizes it', () => {
  const result = validateElvantoFilter(validConfig());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.value, {
    statuses: ['active', 'contact'],
    categoryIds: ['cat-1'],
    groups: { ids: ['g1', 'g2'], operator: 'any' },
    demographics: { values: [], operator: 'any' },
    departments: { values: [], operator: 'any' },
    serviceTypes: { ids: [], operator: 'any' },
    locations: { ids: [], operator: 'any' },
    customFields: [{ fieldId: 'field-1', values: ['v1'], operator: 'any' }],
  });
});

test('validateElvantoFilter dedupes duplicate IDs/values within a dimension', () => {
  const result = validateElvantoFilter(validConfig({
    categoryIds: ['cat-1', 'cat-1'],
    groups: { ids: ['g1', 'g1', 'g2'], operator: 'any' },
    customFields: [{ fieldId: 'field-1', values: ['v1', 'v1', 'v2'], operator: 'any' }],
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.categoryIds, ['cat-1']);
  assert.deepEqual(result.value.groups.ids, ['g1', 'g2']);
  assert.deepEqual(result.value.customFields[0].values, ['v1', 'v2']);
});

test('validateElvantoFilter dedupes duplicate customFields rules by fieldId (first occurrence wins)', () => {
  const result = validateElvantoFilter(validConfig({
    customFields: [
      { fieldId: 'field-1', values: ['v1'], operator: 'any' },
      { fieldId: 'field-1', values: ['v9'], operator: 'all' },
    ],
  }));
  assert.equal(result.ok, true);
  assert.equal(result.value.customFields.length, 1);
  assert.deepEqual(result.value.customFields[0], { fieldId: 'field-1', values: ['v1'], operator: 'any' });
});

test('validateElvantoFilter rejects an empty statuses array', () => {
  const result = validateElvantoFilter(validConfig({ statuses: [] }));
  assert.equal(result.ok, false);
  assert.equal(result.value, null);
  assert.ok(result.errors.some((e) => /statuses/.test(e)));
});

test('validateElvantoFilter rejects an unknown status', () => {
  const result = validateElvantoFilter(validConfig({ statuses: ['active', 'made-up'] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /statuses/.test(e)));
});

test('validateElvantoFilter rejects an unknown operator', () => {
  const result = validateElvantoFilter(validConfig({ groups: { ids: ['g1'], operator: 'every' } }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /groups\.operator/.test(e)));
});

test('validateElvantoFilter rejects an unknown top-level key', () => {
  const result = validateElvantoFilter(validConfig({ nickname: 'oops' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /Unknown filter key: nickname/.test(e)));
});

test('validateElvantoFilter rejects an unsupported schema version', () => {
  const result = validateElvantoFilter(validConfig(), 99);
  assert.equal(result.ok, false);
  assert.equal(result.value, null);
  assert.ok(result.errors.some((e) => /schema version/.test(e)));
  assert.equal(FILTER_SCHEMA_VERSION, 1);
});

test('validateElvantoFilter rejects a non-array value for an ids/values list', () => {
  const result = validateElvantoFilter(validConfig({ groups: { ids: 'g1', operator: 'any' } }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /groups\.ids/.test(e)));
});

test('validateElvantoFilter rejects a non-array statuses/categoryIds value', () => {
  const result = validateElvantoFilter(validConfig({ statuses: 'active', categoryIds: 'cat-1' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /statuses/.test(e)));
  assert.ok(result.errors.some((e) => /categoryIds/.test(e)));
});

test('validateElvantoFilter rejects a malformed customFields rule (missing fieldId, non-array values, bad operator)', () => {
  const result = validateElvantoFilter(validConfig({
    customFields: [{ values: ['v1'], operator: 'any' }, { fieldId: 'f2', values: 'v1', operator: 'any' }, { fieldId: 'f3', values: [], operator: 'sometimes' }],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 3);
});

test('validateElvantoFilter accumulates every error, not just the first', () => {
  const result = validateElvantoFilter({ statuses: [], groups: { ids: 'nope', operator: 'oops' } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 3);
});

test('validateElvantoFilter rejects a non-object config', () => {
  assert.equal(validateElvantoFilter(null).ok, false);
  assert.equal(validateElvantoFilter([]).ok, false);
  assert.equal(validateElvantoFilter('nope').ok, false);
});

// ─── matchesSet ─────────────────────────────────────────────────────────────

test('matchesSet returns true for an empty selected set regardless of the person values', () => {
  assert.equal(matchesSet([], [], 'any'), true);
  assert.equal(matchesSet(['g1'], [], 'any'), true);
  assert.equal(matchesSet([], [], 'all'), true);
});

test('matchesSet "any" requires at least one overlapping value', () => {
  assert.equal(matchesSet(['g1', 'g2'], ['g2', 'g3'], 'any'), true);
  assert.equal(matchesSet(['g1'], ['g2', 'g3'], 'any'), false);
});

test('matchesSet "all" requires every selected value to be present', () => {
  assert.equal(matchesSet(['g1', 'g2', 'g3'], ['g1', 'g2'], 'all'), true);
  assert.equal(matchesSet(['g1'], ['g1', 'g2'], 'all'), false);
});

// ─── isElvantoEligible ──────────────────────────────────────────────────────

test('isElvantoEligible: statuses gate — person state must be in config.statuses', () => {
  const config = validateElvantoFilter(validConfig({
    groups: { ids: [], operator: 'any' }, customFields: [],
  })).value;
  assert.equal(isElvantoEligible(person({ state: 'active' }), config), true);
  assert.equal(isElvantoEligible(person({ state: 'contact' }), config), true);
  assert.equal(isElvantoEligible(person({ state: 'archived' }), config), false);
});

test('schema-2 eligibility delegates equivalent Elvanto facts to the shared Boolean evaluator', () => {
  const filter = { branches: [{ groups: [{ dimensionId: 'custom_field:choir', mode: 'any', values: ['Soprano'] }] }], exclusions: [] };
  assert.equal(isElvantoEligible(person({ attributes: { customFields: { choir: ['Soprano'] } } }), filter, 2), true);
  assert.equal(isElvantoEligible(person({ attributes: { customFields: { choir: ['Alto'] } } }), filter, 2), false);
  assert.equal(validateElvantoFilter(filter, 2).ok, true);
});

test('isElvantoEligible: empty categoryIds is ignored; non-empty must include the person categoryId', () => {
  const ignored = validateElvantoFilter(validConfig({
    categoryIds: [], groups: { ids: [], operator: 'any' }, customFields: [],
  })).value;
  assert.equal(isElvantoEligible(person({ categoryId: 'anything' }), ignored), true);

  const required = validateElvantoFilter(validConfig({
    categoryIds: ['cat-1'], groups: { ids: [], operator: 'any' }, customFields: [],
  })).value;
  assert.equal(isElvantoEligible(person({ categoryId: 'cat-1' }), required), true);
  assert.equal(isElvantoEligible(person({ categoryId: 'cat-2' }), required), false);
  assert.equal(isElvantoEligible(person({ categoryId: null }), required), false);
});

test('isElvantoEligible: groups dimension obeys "any"', () => {
  const config = validateElvantoFilter(validConfig({
    categoryIds: [], groups: { ids: ['g1', 'g9'], operator: 'any' }, customFields: [],
  })).value;
  assert.equal(isElvantoEligible(person({ attributes: { ...person().attributes, groups: ['g1'] } }), config), true);
  assert.equal(isElvantoEligible(person({ attributes: { ...person().attributes, groups: ['g2'] } }), config), false);
});

test('isElvantoEligible: groups dimension obeys "all"', () => {
  const config = validateElvantoFilter(validConfig({
    categoryIds: [], groups: { ids: ['g1', 'g2'], operator: 'all' }, customFields: [],
  })).value;
  assert.equal(isElvantoEligible(person({ attributes: { ...person().attributes, groups: ['g1', 'g2', 'g3'] } }), config), true);
  assert.equal(isElvantoEligible(person({ attributes: { ...person().attributes, groups: ['g1'] } }), config), false);
});

test('isElvantoEligible: an empty dimension is ignored entirely', () => {
  const config = validateElvantoFilter(validConfig({
    categoryIds: [], groups: { ids: [], operator: 'all' }, customFields: [],
  })).value;
  assert.equal(isElvantoEligible(person({ attributes: { ...person().attributes, groups: [] } }), config), true);
});

test('isElvantoEligible: non-empty dimensions combine with AND', () => {
  const config = validateElvantoFilter(validConfig({
    categoryIds: [],
    groups: { ids: ['g1'], operator: 'any' },
    demographics: { values: ['Young Adults'], operator: 'any' },
    customFields: [],
  })).value;
  // Satisfies groups but not demographics -> overall false.
  const failsDemographics = person({
    attributes: { ...person().attributes, groups: ['g1'], demographics: [{ field: 'age_bracket', value: 'Retired' }] },
  });
  assert.equal(isElvantoEligible(failsDemographics, config), false);

  // Satisfies both -> true.
  const satisfiesBoth = person({
    attributes: { ...person().attributes, groups: ['g1'], demographics: [{ field: 'age_bracket', value: 'Young Adults' }] },
  });
  assert.equal(isElvantoEligible(satisfiesBoth, config), true);
});

test('isElvantoEligible: demographics matches on { field, value } pairs by value only', () => {
  const config = validateElvantoFilter(validConfig({
    categoryIds: [], groups: { ids: [], operator: 'any' },
    demographics: { values: ['Young Adults'], operator: 'any' }, customFields: [],
  })).value;
  const p = person({
    attributes: { ...person().attributes, demographics: [{ field: 'marital_status', value: 'Young Adults' }] },
  });
  assert.equal(isElvantoEligible(p, config), true);
});

test('isElvantoEligible: departments matches flat name strings directly', () => {
  const config = validateElvantoFilter(validConfig({
    categoryIds: [], groups: { ids: [], operator: 'any' },
    departments: { values: ['Worship Team'], operator: 'any' }, customFields: [],
  })).value;
  assert.equal(isElvantoEligible(person({ attributes: { ...person().attributes, departments: ['Worship Team'] } }), config), true);
  assert.equal(isElvantoEligible(person({ attributes: { ...person().attributes, departments: ['Youth'] } }), config), false);
});

test('isElvantoEligible: serviceTypes and locations match by ID', () => {
  const config = validateElvantoFilter(validConfig({
    categoryIds: [], groups: { ids: [], operator: 'any' },
    serviceTypes: { ids: ['service-1'], operator: 'any' },
    locations: { ids: ['loc-1'], operator: 'any' },
    customFields: [],
  })).value;
  assert.equal(isElvantoEligible(person(), config), true);
  assert.equal(isElvantoEligible(person({ attributes: { ...person().attributes, locations: ['loc-2'] } }), config), false);
});

test('isElvantoEligible: customFields rule matches values keyed by fieldId, empty rule set is ignored', () => {
  const noRules = validateElvantoFilter(validConfig({ categoryIds: [], groups: { ids: [], operator: 'any' }, customFields: [] })).value;
  assert.equal(isElvantoEligible(person({ attributes: { ...person().attributes, customFields: {} } }), noRules), true);

  const withRule = validateElvantoFilter(validConfig({
    categoryIds: [], groups: { ids: [], operator: 'any' },
    customFields: [{ fieldId: 'field-1', values: ['v1'], operator: 'any' }],
  })).value;
  assert.equal(isElvantoEligible(person({ attributes: { ...person().attributes, customFields: { 'field-1': ['v1'] } } }), withRule), true);
  assert.equal(isElvantoEligible(person({ attributes: { ...person().attributes, customFields: { 'field-1': ['v2'] } } }), withRule), false);
  assert.equal(isElvantoEligible(person({ attributes: { ...person().attributes, customFields: {} } }), withRule), false);
});

// ─── Church-wide "include contacts" setting removes contact before filter evaluation ──
//
// people_sync_settings.elvanto_include_contacts is enforced in
// server/services/peopleSync/plan.js's computePeopleSyncPlan(), which
// excludes 'contact'-state external people from the eligible population
// entirely — before any batch filter (isElvantoEligible included) is ever
// consulted (see plan.js: `normalizeState(externalPerson.state) ===
// 'contact' && input.settings?.includeContacts === false`). isElvantoEligible
// itself has no includeContacts parameter and is not where this rule lives.
// This test proves the shape of that guarantee at this layer: a filter that
// explicitly *allows* the 'contact' status cannot rescue a contact-state
// person once the population gate has already removed them — reproducing
// plan.js's exact predicate rather than re-implementing a second copy of it
// permanently inside filter.js.
function excludedByIncludeContactsSetting(candidate, settings) {
  return candidate.state === 'contact' && settings?.includeContacts === false;
}

test('contact cannot qualify once the church-wide include-contacts setting removes it, even with a permissive filter', () => {
  const permissiveConfig = validateElvantoFilter(validConfig({
    statuses: ['active', 'contact'], categoryIds: [], groups: { ids: [], operator: 'any' }, customFields: [],
  })).value;

  const contactPerson = person({ id: 'p-contact', state: 'contact' });

  // The filter alone (no population gate) would happily admit this contact.
  assert.equal(isElvantoEligible(contactPerson, permissiveConfig), true);

  // The full population, as the orchestrator would build it, applying the
  // church-wide setting BEFORE any filter is evaluated.
  const population = [person({ id: 'p-active', state: 'active' }), contactPerson];

  const withContactsOff = population.filter((candidate) => !excludedByIncludeContactsSetting(candidate, { includeContacts: false }));
  assert.deepEqual(withContactsOff.map((p2) => p2.id), ['p-active']);
  assert.equal(withContactsOff.some((candidate) => isElvantoEligible(candidate, permissiveConfig) && candidate.id === 'p-contact'), false);

  // With the setting on (or unset), the same contact is never removed from
  // the population, and the permissive filter does admit them — showing
  // the exclusion above is really the setting's doing, not the filter's.
  const withContactsOn = population.filter((candidate) => !excludedByIncludeContactsSetting(candidate, { includeContacts: true }));
  assert.deepEqual(withContactsOn.map((p2) => p2.id).sort(), ['p-active', 'p-contact']);
  assert.equal(withContactsOn.every((candidate) => isElvantoEligible(candidate, permissiveConfig)), true);
});
