const { test } = require('node:test');
const assert = require('node:assert');
const { isEligible } = require('./eligibility');

function person(overrides = {}) {
  return { id: 'p1', membership: null, fieldValues: {}, ...overrides };
}

test('membership-only: eligible when membership is allow-listed', () => {
  const cfg = { membershipFilterEnabled: true, membershipAllowlist: ['Church Members'], fieldFilterEnabled: false, fieldFilters: [] };
  assert.strictEqual(isEligible(person({ membership: 'Church Members' }), cfg), true);
  assert.strictEqual(isEligible(person({ membership: 'Community Contact' }), cfg), false);
});

test('membership disabled: membership match does not count', () => {
  const cfg = { membershipFilterEnabled: false, membershipAllowlist: ['Church Members'], fieldFilterEnabled: false, fieldFilters: [] };
  assert.strictEqual(isEligible(person({ membership: 'Church Members' }), cfg), false);
});

test('field-only: eligible when every rule matches (AND within source)', () => {
  const cfg = {
    membershipFilterEnabled: false, membershipAllowlist: [],
    fieldFilterEnabled: true,
    fieldFilters: [
      { fieldDefinitionId: 'f1', values: ['Connected'] },
      { fieldDefinitionId: 'f2', values: ['Yes'] },
    ],
  };
  assert.strictEqual(isEligible(person({ fieldValues: { f1: ['Connected'], f2: ['Yes'] } }), cfg), true);
  assert.strictEqual(isEligible(person({ fieldValues: { f1: ['Connected'], f2: ['No'] } }), cfg), false);
  assert.strictEqual(isEligible(person({ fieldValues: { f1: ['Connected'] } }), cfg), false); // f2 missing -> '(none)' -> no match
});

test('field-only: empty rule list matches nobody', () => {
  const cfg = { membershipFilterEnabled: false, membershipAllowlist: [], fieldFilterEnabled: true, fieldFilters: [] };
  assert.strictEqual(isEligible(person({ fieldValues: { f1: ['Connected'] } }), cfg), false);
});

test('field-only: missing field value is normalized to (none) and matches a (none) rule', () => {
  const cfg = {
    membershipFilterEnabled: false, membershipAllowlist: [],
    fieldFilterEnabled: true,
    fieldFilters: [{ fieldDefinitionId: 'f1', values: ['(none)'] }],
  };
  assert.strictEqual(isEligible(person({ fieldValues: {} }), cfg), true);
  assert.strictEqual(isEligible(person({ fieldValues: { f1: ['Connected'] } }), cfg), false);
  assert.strictEqual(isEligible(person({ fieldValues: { f1: [] } }), cfg), true, 'no checkboxes selected -> (none)');
});

test('field-only: a stray null/blank entry in fieldValues is treated as (none), not a real value that dodges the sentinel check', () => {
  const cfg = {
    membershipFilterEnabled: false, membershipAllowlist: [],
    fieldFilterEnabled: true,
    fieldFilters: [{ fieldDefinitionId: 'f1', values: ['Connected'] }],
  };
  assert.strictEqual(isEligible(person({ fieldValues: { f1: [null] } }), cfg), false, 'blank row must not match a real-value rule');
  assert.strictEqual(isEligible(person({ fieldValues: { f1: [''] } }), cfg), false);

  const noneCfg = { ...cfg, fieldFilters: [{ fieldDefinitionId: 'f1', values: ['(none)'] }] };
  assert.strictEqual(isEligible(person({ fieldValues: { f1: [null] } }), noneCfg), true, 'blank row must match via the (none) sentinel like a missing row would');
});

test('field disabled: field match does not count even with matching rules configured', () => {
  const cfg = {
    membershipFilterEnabled: false, membershipAllowlist: [],
    fieldFilterEnabled: false,
    fieldFilters: [{ fieldDefinitionId: 'f1', values: ['Connected'] }],
  };
  assert.strictEqual(isEligible(person({ fieldValues: { f1: ['Connected'] } }), cfg), false);
});

test('both enabled: OR — either source alone is sufficient', () => {
  const cfg = {
    membershipFilterEnabled: true, membershipAllowlist: ['Church Members'],
    fieldFilterEnabled: true, fieldFilters: [{ fieldDefinitionId: 'f1', values: ['Connected'] }],
  };
  assert.strictEqual(isEligible(person({ membership: 'Church Members', fieldValues: {} }), cfg), true, 'membership match alone');
  assert.strictEqual(isEligible(person({ membership: 'Community Contact', fieldValues: { f1: ['Connected'] } }), cfg), true, 'field match alone');
  assert.strictEqual(isEligible(person({ membership: 'Community Contact', fieldValues: { f1: ['Not Connected'] } }), cfg), false, 'neither matches');
  assert.strictEqual(isEligible(person({ membership: 'Church Members', fieldValues: { f1: ['Connected'] } }), cfg), true, 'both match');
});

test('field-only: multi-select checkboxes match if ANY selected value intersects the rule values', () => {
  const cfg = {
    membershipFilterEnabled: false, membershipAllowlist: [],
    fieldFilterEnabled: true,
    fieldFilters: [{ fieldDefinitionId: 'f1', values: ['Blue'] }],
  };
  assert.strictEqual(isEligible(person({ fieldValues: { f1: ['Red', 'Blue'] } }), cfg), true, 'rule value is one of several selected');
  assert.strictEqual(isEligible(person({ fieldValues: { f1: ['Red', 'Green'] } }), cfg), false, 'none of the selected values match');
});

test('field-only: AND across fields still holds when one field is a multi-select', () => {
  const cfg = {
    membershipFilterEnabled: false, membershipAllowlist: [],
    fieldFilterEnabled: true,
    fieldFilters: [
      { fieldDefinitionId: 'f1', values: ['Blue'] },
      { fieldDefinitionId: 'f2', values: ['Yes'] },
    ],
  };
  assert.strictEqual(isEligible(person({ fieldValues: { f1: ['Red', 'Blue'], f2: ['Yes'] } }), cfg), true);
  assert.strictEqual(isEligible(person({ fieldValues: { f1: ['Red', 'Blue'], f2: ['No'] } }), cfg), false, 'f1 matches but f2 does not');
});

test('both disabled: nobody is eligible', () => {
  const cfg = { membershipFilterEnabled: false, membershipAllowlist: ['Church Members'], fieldFilterEnabled: false, fieldFilters: [] };
  assert.strictEqual(isEligible(person({ membership: 'Church Members' }), cfg), false);
});
