const { test } = require('node:test');
const assert = require('node:assert');
const { projectPerson } = require('./projection');

test('projectPerson maps attributes and first household id', () => {
  const raw = {
    id: '123',
    attributes: { first_name: 'Sarah', last_name: 'Wierenga', status: 'active', membership: 'Church Members', child: false },
    relationships: { households: { data: [{ id: 'h1' }, { id: 'h2' }] } },
  };
  assert.deepStrictEqual(projectPerson(raw), {
    id: '123', firstName: 'Sarah', lastName: 'Wierenga',
    status: 'active', membership: 'Church Members', child: false, householdId: 'h1',
  });
});

test('projectPerson handles missing fields and no household', () => {
  const p = projectPerson({ id: '9', attributes: { child: true } });
  assert.strictEqual(p.firstName, '');
  assert.strictEqual(p.lastName, '');
  assert.strictEqual(p.status, null);
  assert.strictEqual(p.membership, null);
  assert.strictEqual(p.child, true);
  assert.strictEqual(p.householdId, null);
});
