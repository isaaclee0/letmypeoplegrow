const { test } = require('node:test');
const assert = require('node:assert');
const { buildFamilyName } = require('./familyName');

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
