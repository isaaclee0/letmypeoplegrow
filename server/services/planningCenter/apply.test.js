const { test } = require('node:test');
const assert = require('node:assert');
const { buildFamilyName, groupAdds } = require('./apply');

test('buildFamilyName uses adults first', () => {
  const name = buildFamilyName([
    { firstName: 'Mark', lastName: 'Arroyo', isChild: false },
    { firstName: 'Christine', lastName: 'Arroyo', isChild: false },
    { firstName: 'Kid', lastName: 'Arroyo', isChild: true },
  ]);
  assert.strictEqual(name, 'Arroyo, Mark and Christine');
});

test('buildFamilyName falls back to all members when no adults', () => {
  const name = buildFamilyName([{ firstName: 'Kid', lastName: 'Arroyo', isChild: true }]);
  assert.strictEqual(name, 'Arroyo, Kid');
});

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
