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
    status: 'active', membership: 'Church Members', child: false, householdId: 'h1', fieldValues: {},
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
  assert.deepStrictEqual(p.fieldValues, {});
});

test('projectPerson extracts fieldValues from included FieldDatum entries', () => {
  const raw = {
    id: '123',
    attributes: { first_name: 'Sarah', last_name: 'Wierenga' },
    relationships: {
      field_data: { data: [{ type: 'FieldDatum', id: 'fd1' }, { type: 'FieldDatum', id: 'fd2' }] },
    },
  };
  const fieldDataById = new Map([
    ['fd1', { id: 'fd1', attributes: { value: 'Connected' }, relationships: { field_definition: { data: { id: 'f1' } } } }],
    ['fd2', { id: 'fd2', attributes: { value: 'Yes' }, relationships: { field_definition: { data: { id: 'f2' } } } }],
  ]);
  const p = projectPerson(raw, fieldDataById);
  assert.deepStrictEqual(p.fieldValues, { f1: 'Connected', f2: 'Yes' });
});

test('projectPerson skips FieldDatum ids missing from the lookup or with no field_definition', () => {
  const raw = {
    id: '123',
    attributes: {},
    relationships: { field_data: { data: [{ type: 'FieldDatum', id: 'gone' }, { type: 'FieldDatum', id: 'fd1' }] } },
  };
  const fieldDataById = new Map([
    ['fd1', { id: 'fd1', attributes: { value: 'X' }, relationships: {} }], // no field_definition relationship
  ]);
  const p = projectPerson(raw, fieldDataById);
  assert.deepStrictEqual(p.fieldValues, {});
});

test('projectPerson with no fieldDataById argument still returns an empty fieldValues map', () => {
  const raw = { id: '9', attributes: {}, relationships: { field_data: { data: [{ id: 'fd1' }] } } };
  const p = projectPerson(raw);
  assert.deepStrictEqual(p.fieldValues, {});
});
