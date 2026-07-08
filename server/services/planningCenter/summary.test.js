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
    { fieldValues: { f1: ['Connected'], f2: ['Yes'] } },
    { fieldValues: { f1: ['Connected'] } },
    { fieldValues: { f1: ['New'] } },
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
  assert.deepStrictEqual(tallyField([{ fieldValues: { f2: ['X'] } }], 'f1'), { total: 1, values: [{ value: '(none)', count: 1 }] });
});

test('tallyField counts each selected value separately for a person with multiple checked boxes on one field', () => {
  const people = [
    { fieldValues: { f1: ['Red', 'Blue'] } },
    { fieldValues: { f1: ['Blue'] } },
    { fieldValues: { f1: [] } }, // no boxes checked -> (none)
  ];
  const result = tallyField(people, 'f1');
  assert.strictEqual(result.total, 3);
  assert.deepStrictEqual(result.values, [
    { value: 'Blue', count: 2 },
    { value: 'Red', count: 1 },
    { value: '(none)', count: 1 },
  ]);
});

test('tallyField seeds canonicalOptions at count 0 so unclaimed PCO options still surface', () => {
  const people = [
    { fieldValues: { f1: ['Connected'] } },
    { fieldValues: { f1: ['Connected'] } },
  ];
  const result = tallyField(people, 'f1', ['Connected', 'New', 'Lapsed']);
  assert.strictEqual(result.total, 2);
  assert.deepStrictEqual(result.values, [
    { value: 'Connected', count: 2 },
    { value: 'New', count: 0 },
    { value: 'Lapsed', count: 0 },
  ]);
});

test('tallyField treats a stray null/blank entry in the values array as (none), not a literal null option', () => {
  const people = [
    { fieldValues: { f1: [null] } },
    { fieldValues: { f1: [''] } },
    { fieldValues: { f1: ['Connected'] } },
  ];
  const result = tallyField(people, 'f1');
  assert.strictEqual(result.total, 3);
  assert.deepStrictEqual(result.values, [
    { value: '(none)', count: 2 },
    { value: 'Connected', count: 1 },
  ]);
});

test('tallyField canonicalOptions does not duplicate a value that people also have', () => {
  const result = tallyField([{ fieldValues: { f1: ['New'] } }], 'f1', ['New']);
  assert.deepStrictEqual(result.values, [{ value: 'New', count: 1 }]);
});
