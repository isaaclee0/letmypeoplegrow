const { test } = require('node:test');
const assert = require('node:assert');
const { groupAdds, computeGatheringRemovals } = require('./apply');

test('groupAdds groups by household, solo for null household', () => {
  const groups = groupAdds([
    { pcoId: 'a', householdId: 'h1', firstName: 'A', lastName: 'X', isChild: false },
    { pcoId: 'b', householdId: 'h1', firstName: 'B', lastName: 'X', isChild: false },
    { pcoId: 'c', householdId: null, firstName: 'C', lastName: 'Y', isChild: false },
  ]);
  assert.strictEqual(groups.length, 2);
  const h1 = groups.find((g) => g.householdId === 'h1');
  assert.strictEqual(h1.members.length, 2);
  const solo = groups.find((g) => g.householdId === null);
  assert.strictEqual(solo.members.length, 1);
});

test('groupAdds keeps two null-household people as separate solo groups', () => {
  const groups = groupAdds([
    { pcoId: 'x', householdId: null, firstName: 'X', lastName: 'One', isChild: false },
    { pcoId: 'y', householdId: null, firstName: 'Y', lastName: 'Two', isChild: false },
  ]);
  assert.strictEqual(groups.length, 2);
  assert.ok(groups.every((g) => g.householdId === null && g.members.length === 1));
});

test('computeGatheringRemovals keeps only ids not in the touched set', () => {
  const owned = [1, 2, 3];
  const touched = new Set([2]);
  assert.deepStrictEqual(computeGatheringRemovals(owned, touched), [1, 3]);
});

test('computeGatheringRemovals returns empty when everyone owned is still touched', () => {
  assert.deepStrictEqual(computeGatheringRemovals([1, 2], new Set([1, 2])), []);
});

test('computeGatheringRemovals returns everyone owned when the touched set is empty', () => {
  assert.deepStrictEqual(computeGatheringRemovals([5, 6], new Set()), [5, 6]);
});

test('computeGatheringRemovals returns empty for an empty owned list', () => {
  assert.deepStrictEqual(computeGatheringRemovals([], new Set([1])), []);
});
