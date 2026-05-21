const { test } = require('node:test');
const assert = require('node:assert');
const { tallyMembership } = require('./summary');

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
