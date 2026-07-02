const { test } = require('node:test');
const assert = require('node:assert');
const { tallyMembership, tallyField } = require('./summary');

test('tallyMembership counts by membership, sorted desc, with total', () => {
  const people = [
    { membership: 'Church Members' },
    { membership: 'Church Members' },
    { membership: 'Community Contact' },
    { membership: null },
  ];
  const result = tallyMembership(people);
  assert.strictEqual(result.total, 4);
  assert.deepStrictEqual(result.values, [
    { membership: 'Church Members', count: 2 },
    { membership: 'Community Contact', count: 1 },
    { membership: '(none)', count: 1 },
  ]);
});

test('tallyMembership handles empty input', () => {
  assert.deepStrictEqual(tallyMembership([]), { total: 0, values: [] });
});

test('tallyField counts by the given field id, sorted desc, with total', () => {
  const people = [
    { fieldValues: { f1: 'Connected', f2: 'Yes' } },
    { fieldValues: { f1: 'Connected' } },
    { fieldValues: { f1: 'New' } },
    { fieldValues: {} },
  ];
  const result = tallyField(people, 'f1');
  assert.strictEqual(result.total, 4);
  assert.deepStrictEqual(result.values, [
    { value: 'Connected', count: 2 },
    { value: 'New', count: 1 },
    { value: '(none)', count: 1 },
  ]);
});

test('tallyField handles empty input and a field id nobody has', () => {
  assert.deepStrictEqual(tallyField([], 'f1'), { total: 0, values: [] });
  assert.deepStrictEqual(tallyField([{ fieldValues: { f2: 'X' } }], 'f1'), { total: 1, values: [{ value: '(none)', count: 1 }] });
});
