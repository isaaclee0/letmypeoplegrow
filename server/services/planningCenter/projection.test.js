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
    status: 'active', membership: 'Church Members', child: false, passedBackgroundCheck: false, householdId: 'h1', fieldValues: {},
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

test('projectPerson extracts fieldValues from included FieldDatum entries as arrays', () => {
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
  assert.deepStrictEqual(p.fieldValues, { f1: ['Connected'], f2: ['Yes'] });
});

test('projectPerson accumulates multiple FieldDatum rows for the same field_definition into one array (multi-select checkboxes)', () => {
  const raw = {
    id: '123',
    attributes: {},
    relationships: {
      field_data: { data: [{ type: 'FieldDatum', id: 'fd1' }, { type: 'FieldDatum', id: 'fd2' }, { type: 'FieldDatum', id: 'fd3' }] },
    },
  };
  const fieldDataById = new Map([
    ['fd1', { id: 'fd1', attributes: { value: 'Red' }, relationships: { field_definition: { data: { id: 'f1' } } } }],
    ['fd2', { id: 'fd2', attributes: { value: 'Blue' }, relationships: { field_definition: { data: { id: 'f1' } } } }],
    ['fd3', { id: 'fd3', attributes: { value: 'Yes' }, relationships: { field_definition: { data: { id: 'f2' } } } }],
  ]);
  const p = projectPerson(raw, fieldDataById);
  assert.deepStrictEqual(p.fieldValues, { f1: ['Red', 'Blue'], f2: ['Yes'] });
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

test('projectPerson drops FieldDatum rows with a blank/null value instead of pushing null', () => {
  const raw = {
    id: '123',
    attributes: {},
    relationships: {
      field_data: { data: [{ type: 'FieldDatum', id: 'fd1' }, { type: 'FieldDatum', id: 'fd2' }, { type: 'FieldDatum', id: 'fd3' }] },
    },
  };
  const fieldDataById = new Map([
    ['fd1', { id: 'fd1', attributes: { value: null }, relationships: { field_definition: { data: { id: 'f1' } } } }],
    ['fd2', { id: 'fd2', attributes: { value: '' }, relationships: { field_definition: { data: { id: 'f1' } } } }],
    ['fd3', { id: 'fd3', attributes: {}, relationships: { field_definition: { data: { id: 'f2' } } } }], // missing value attr entirely
  ]);
  const p = projectPerson(raw, fieldDataById);
  // f1/f2 should never even appear as keys — a blank answer is indistinguishable from no row at all.
  assert.deepStrictEqual(p.fieldValues, {});
});

test('projectPerson keeps real values alongside a blank row for the same field', () => {
  const raw = {
    id: '123',
    attributes: {},
    relationships: {
      field_data: { data: [{ type: 'FieldDatum', id: 'fd1' }, { type: 'FieldDatum', id: 'fd2' }] },
    },
  };
  const fieldDataById = new Map([
    ['fd1', { id: 'fd1', attributes: { value: null }, relationships: { field_definition: { data: { id: 'f1' } } } }],
    ['fd2', { id: 'fd2', attributes: { value: 'Connected' }, relationships: { field_definition: { data: { id: 'f1' } } } }],
  ]);
  const p = projectPerson(raw, fieldDataById);
  assert.deepStrictEqual(p.fieldValues, { f1: ['Connected'] });
});

test('projectPerson with no fieldDataById argument still returns an empty fieldValues map', () => {
  const raw = { id: '9', attributes: {}, relationships: { field_data: { data: [{ id: 'fd1' }] } } };
  const p = projectPerson(raw);
  assert.deepStrictEqual(p.fieldValues, {});
});

test('projectPerson: maps passed_background_check attribute to passedBackgroundCheck', () => {
  const raw = {
    id: '1',
    attributes: { first_name: 'A', last_name: 'B', passed_background_check: true },
    relationships: {},
  };
  const projected = projectPerson(raw, new Map());
  assert.strictEqual(projected.passedBackgroundCheck, true);
});

test('projectPerson: passedBackgroundCheck is false when PCO returns false', () => {
  const raw = {
    id: '2',
    attributes: { first_name: 'A', last_name: 'B', passed_background_check: false },
    relationships: {},
  };
  const projected = projectPerson(raw, new Map());
  assert.strictEqual(projected.passedBackgroundCheck, false);
});
