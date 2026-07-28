'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  EMPTY_V2_FILTER,
  validateFilterV2,
  evaluateFilterV2,
  selectedDimensionIds,
  selectedPairs,
  summarizeFilter,
} = require('./filterEngine');

const metadata = {
  provider: 'elvanto',
  dimensions: [
    { id: 'status', label: 'Status', cardinality: 'single', category: 'People', values: [{ id: 'active', label: 'Active', count: 3 }, { id: 'inactive', label: 'Inactive', count: 1 }, { id: '$not_set', label: 'Not set', count: 0 }] },
    { id: 'category', label: 'Category', cardinality: 'single', category: 'People', values: [{ id: 'member', label: 'Member', count: 2 }, { id: 'visitor', label: 'Visitor', count: 2 }, { id: '$not_set', label: 'Not set', count: 0 }] },
    { id: 'groups', label: 'Groups', cardinality: 'multi', category: 'Groups', values: [{ id: 'youth', label: 'Youth', count: 2 }, { id: 'music', label: 'Music', count: 1 }, { id: 'blocked', label: 'Blocked', count: 1 }, { id: 'suspended', label: 'Suspended', count: 1 }, { id: '$not_set', label: 'Not set', count: 0 }] },
  ],
  snapshot: null,
};

const activeYouthMusician = { externalPersonId: 'one', dimensions: { status: ['active'], groups: ['youth', 'music'] } };
const categoryMember = { externalPersonId: 'two', dimensions: { category: ['member'] } };
const activeYouthOnly = { externalPersonId: 'three', dimensions: { status: ['active'], groups: ['youth'] } };
const blockedCategoryMember = { externalPersonId: 'four', dimensions: { category: ['member'], groups: ['blocked'] } };

function validConfig(overrides = {}) {
  return { branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['active'] }] }], exclusions: [], ...overrides };
}

function codes(result) {
  return result.errors.map((error) => error.code);
}

test('evaluateFilterV2 follows the literal AND/OR/NOT truth table', () => {
  const filter = {
    branches: [
      { groups: [
        { dimensionId: 'status', mode: 'any', values: ['active'] },
        { dimensionId: 'groups', mode: 'all', values: ['youth', 'music'] },
      ] },
      { groups: [{ dimensionId: 'category', mode: 'any', values: ['member'] }] },
    ],
    exclusions: [{ dimensionId: 'groups', values: ['blocked', 'suspended'] }],
  };

  assert.equal(evaluateFilterV2(activeYouthMusician, filter), true);
  assert.equal(evaluateFilterV2(categoryMember, filter), true);
  assert.equal(evaluateFilterV2(activeYouthOnly, filter), false);
  assert.equal(evaluateFilterV2(blockedCategoryMember, filter), false);
});

test('evaluateFilterV2 handles $not_set, any, all, multiple exclusions, NOT-only, and an empty filter', () => {
  const noGroups = { externalPersonId: 'none', dimensions: { status: ['active'] } };
  const someGroups = { externalPersonId: 'some', dimensions: { status: ['active'], groups: ['youth', 'music'] } };

  assert.equal(evaluateFilterV2(noGroups, { branches: [{ groups: [{ dimensionId: 'groups', mode: 'any', values: ['$not_set'] }] }], exclusions: [] }), true);
  assert.equal(evaluateFilterV2(someGroups, { branches: [{ groups: [{ dimensionId: 'groups', mode: 'any', values: ['$not_set', 'music'] }] }], exclusions: [] }), true);
  assert.equal(evaluateFilterV2(someGroups, { branches: [{ groups: [{ dimensionId: 'groups', mode: 'all', values: ['youth', 'music'] }] }], exclusions: [] }), true);
  assert.equal(evaluateFilterV2(activeYouthOnly, { branches: [{ groups: [{ dimensionId: 'groups', mode: 'all', values: ['youth', 'music'] }] }], exclusions: [] }), false);
  assert.equal(evaluateFilterV2({ externalPersonId: 'excluded', dimensions: { groups: ['suspended'] } }, { branches: [], exclusions: [{ dimensionId: 'groups', values: ['blocked'] }, { dimensionId: 'groups', values: ['suspended'] }] }), false);
  assert.equal(evaluateFilterV2(noGroups, { branches: [], exclusions: [{ dimensionId: 'groups', values: ['blocked'] }] }), true);
  assert.equal(evaluateFilterV2(noGroups, EMPTY_V2_FILTER), false);
});

test('evaluateFilterV2 fails closed for malformed or unvalidated configs', () => {
  const facts = { externalPersonId: 'one', dimensions: { status: ['active'] } };
  const malformedConfigs = [
    { branches: [{ groups: [] }], exclusions: [] },
    { branches: [], exclusions: [{ dimensionId: 'status' }] },
    { branches: [null], exclusions: [] },
    { branches: [{ groups: [null] }], exclusions: [] },
    { branches: [], exclusions: [null] },
    { branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['active'], unexpected: true }] }], exclusions: [] },
  ];

  for (const config of malformedConfigs) {
    assert.doesNotThrow(() => assert.equal(evaluateFilterV2(facts, config), false));
  }
});

test('validateFilterV2 canonicalizes order and summaries are order-independent', () => {
  const first = validConfig({
    branches: [{ groups: [
      { dimensionId: 'groups', mode: 'any', values: ['music', 'youth'] },
      { dimensionId: 'status', mode: 'any', values: ['active'] },
    ] }],
    exclusions: [{ dimensionId: 'category', values: ['visitor', '$not_set'] }],
  });
  const second = validConfig({
    branches: [{ groups: [
      { dimensionId: 'status', mode: 'any', values: ['active'] },
      { dimensionId: 'groups', mode: 'any', values: ['youth', 'music'] },
    ] }],
    exclusions: [{ dimensionId: 'category', values: ['$not_set', 'visitor'] }],
  });
  const one = validateFilterV2(first, metadata);
  const two = validateFilterV2(second, metadata);

  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  assert.deepEqual(one.value, two.value);
  assert.deepEqual(summarizeFilter(first, metadata), summarizeFilter(second, metadata));
  assert.deepEqual(selectedDimensionIds(one.value), ['category', 'groups', 'status']);
  assert.deepEqual(selectedPairs(one.value), [
    { dimensionId: 'category', valueId: '$not_set' },
    { dimensionId: 'category', valueId: 'visitor' },
    { dimensionId: 'groups', valueId: 'music' },
    { dimensionId: 'groups', valueId: 'youth' },
    { dimensionId: 'status', valueId: 'active' },
  ]);
});

test('validateFilterV2 reports strict validation codes', () => {
  const cases = [
    [{ ...validConfig(), surprise: true }, 'UNKNOWN_ROOT_KEY'],
    [{ branches: Array.from({ length: 21 }, () => ({ groups: [{ dimensionId: 'status', mode: 'any', values: ['active'] }] })), exclusions: [] }, 'TOO_MANY_BRANCHES'],
    [{ branches: [{ groups: Array.from({ length: 51 }, () => ({ dimensionId: 'status', mode: 'any', values: ['active'] })) }], exclusions: [] }, 'TOO_MANY_GROUPS'],
    [{ branches: [{ groups: [{ dimensionId: 'groups', mode: 'any', values: Array.from({ length: 501 }, (_, index) => `value-${index}`) }] }], exclusions: [] }, 'TOO_MANY_VALUES'],
    [{ branches: [{ groups: [] }], exclusions: [] }, 'EMPTY_BRANCH'],
    [{ branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: [] }] }], exclusions: [] }, 'EMPTY_GROUP'],
    [{ branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['active'] }, { dimensionId: 'status', mode: 'any', values: ['inactive'] }] }], exclusions: [] }, 'DUPLICATE_BRANCH_DIMENSION'],
    [validConfig({ exclusions: [{ dimensionId: 'groups', values: ['blocked'] }, { dimensionId: 'groups', values: ['suspended'] }] }), 'DUPLICATE_EXCLUSION_DIMENSION'],
    [validConfig({ branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['active', 'active'] }] }] }), 'DUPLICATE_VALUE'],
    [validConfig({ branches: [{ groups: [{ dimensionId: 'status', mode: 'all', values: ['active'] }] }] }), 'SINGLE_DIMENSION_ALL'],
    [validConfig({ branches: [{ groups: [{ dimensionId: 'groups', mode: 'all', values: ['$not_set', 'youth'] }] }] }), 'NOT_SET_ALL_CONFLICT'],
    [validConfig({ exclusions: [{ dimensionId: 'status', values: ['active'] }] }), 'INCLUDE_EXCLUDE_CONFLICT'],
    [validConfig({ branches: [{ groups: [{ dimensionId: 'missing', mode: 'any', values: ['active'] }] }] }), 'UNKNOWN_DIMENSION'],
    [validConfig({ branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['missing'] }] }] }), 'UNKNOWN_VALUE'],
    [validConfig({ branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: [1] }] }] }), 'MALFORMED_VALUE'],
  ];

  for (const [config, expectedCode] of cases) {
    const result = validateFilterV2(config, metadata);
    assert.equal(result.ok, false, expectedCode);
    assert.ok(codes(result).includes(expectedCode), `${expectedCode}: ${JSON.stringify(result.errors)}`);
  }
});

test('validateFilterV2 accepts only explicitly allowed unresolved dimension/value pairs', () => {
  const config = validConfig({ branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['gone'] }] }] });
  const rejected = validateFilterV2(config, metadata);
  assert.equal(rejected.ok, false);
  assert.ok(codes(rejected).includes('UNKNOWN_VALUE'));

  const accepted = validateFilterV2(config, metadata, { allowedUnresolvedPairs: new Set([JSON.stringify(['status', 'gone'])]) });
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.unresolved, [{ dimensionId: 'status', valueId: 'gone' }]);
  assert.deepEqual(accepted.value, config);
});

test('validateFilterV2 retains an absent dimension only when every selected pair is explicitly allowed', () => {
  const retained = validConfig({ branches: [{ groups: [{ dimensionId: 'custom_field:retired', mode: 'all', values: ['one', 'two'] }] }] });
  const rejected = validateFilterV2(retained, metadata, {
    allowedUnresolvedPairs: new Set([JSON.stringify(['custom_field:retired', 'one'])]),
  });
  assert.equal(rejected.ok, false);
  assert.ok(codes(rejected).includes('UNKNOWN_DIMENSION'));

  const accepted = validateFilterV2(retained, metadata, {
    allowedUnresolvedPairs: new Set([
      JSON.stringify(['custom_field:retired', 'one']),
      JSON.stringify(['custom_field:retired', 'two']),
    ]),
  });
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.unresolved, [
    { dimensionId: 'custom_field:retired', valueId: 'one' },
    { dimensionId: 'custom_field:retired', valueId: 'two' },
  ]);
  assert.deepEqual(accepted.value, retained);
});

test('tuple identity keeps colon-containing dimension and value IDs distinct', () => {
  const colonMetadata = {
    provider: 'elvanto',
    dimensions: [
      { id: 'a', label: 'A', cardinality: 'multi', category: 'Test', values: [{ id: 'known', label: 'Known', count: 0 }] },
      { id: 'a:b', label: 'A:B', cardinality: 'multi', category: 'Test', values: [{ id: 'known', label: 'Known', count: 0 }] },
    ],
    snapshot: null,
  };
  const firstPair = { dimensionId: 'a', valueId: 'b:c' };
  const secondPair = { dimensionId: 'a:b', valueId: 'c' };
  const allowed = new Set([JSON.stringify(['a', 'b:c'])]);

  const first = validateFilterV2({ branches: [{ groups: [{ dimensionId: 'a', mode: 'any', values: ['b:c'] }] }], exclusions: [] }, colonMetadata, { allowedUnresolvedPairs: allowed });
  const second = validateFilterV2({ branches: [{ groups: [{ dimensionId: 'a:b', mode: 'any', values: ['c'] }] }], exclusions: [] }, colonMetadata, { allowedUnresolvedPairs: allowed });
  const distinct = {
    branches: [{ groups: [{ dimensionId: 'a', mode: 'any', values: ['b:c'] }] }],
    exclusions: [{ dimensionId: 'a:b', values: ['c'] }],
  };

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.ok(codes(second).includes('UNKNOWN_VALUE'));
  assert.equal(validateFilterV2(distinct, colonMetadata, { allowedUnresolvedPairs: new Set([JSON.stringify(['a', 'b:c']), JSON.stringify(['a:b', 'c'])]) }).ok, true);
  assert.deepEqual(selectedPairs(distinct), [firstPair, secondPair]);
});
