const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePerson, normalizeSnapshot, deriveElvantoState, deriveChildState, buildElvantoFamilies,
} = require('./normalizer');

const fixtures = require('./fixtures/people');

// ─── deriveElvantoState: precedence deceased > archived > contact > active ─

test('deriveElvantoState: deceased wins over archived and contact', () => {
  assert.equal(deriveElvantoState({ deceased: '1', archived: '0', contact: '1' }), 'deceased');
});

test('deriveElvantoState: archived wins over contact when not deceased', () => {
  assert.equal(deriveElvantoState({ archived: '1', contact: '1' }), 'archived');
});

test('deriveElvantoState: contact when neither deceased nor archived', () => {
  assert.equal(deriveElvantoState({ contact: '1' }), 'contact');
});

test('deriveElvantoState: active when no flags are set', () => {
  assert.equal(deriveElvantoState({ deceased: '0', archived: '0', contact: '0' }), 'active');
});

test('deriveElvantoState: active when flags are entirely absent', () => {
  assert.equal(deriveElvantoState({}), 'active');
});

test('deriveElvantoState: overlapping-flags fixture resolves to deceased', () => {
  assert.equal(deriveElvantoState(fixtures.overlappingFlagsPerson), 'deceased');
});

test('deriveElvantoState: accepts numeric 1 and boolean true defensively, not just the string "1"', () => {
  assert.equal(deriveElvantoState({ archived: 1 }), 'archived');
  assert.equal(deriveElvantoState({ archived: true }), 'archived');
  assert.equal(deriveElvantoState({ archived: 0 }), 'active');
  assert.equal(deriveElvantoState({ archived: false }), 'active');
});

test('deriveElvantoState: each fixture matches its intended status', () => {
  assert.equal(deriveElvantoState(fixtures.activePerson), 'active');
  assert.equal(deriveElvantoState(fixtures.contactPerson), 'contact');
  assert.equal(deriveElvantoState(fixtures.archivedPerson), 'archived');
  assert.equal(deriveElvantoState(fixtures.deceasedPerson), 'deceased');
});

// ─── deriveChildState ───────────────────────────────────────────────────────

test('deriveChildState: "Child" family_relationship is true', () => {
  assert.equal(deriveChildState({ family_relationship: 'Child' }), true);
});

test('deriveChildState: blank family_relationship and blank birthday is null, never a guess', () => {
  assert.equal(deriveChildState({ family_relationship: '', birthday: '' }), null);
});

test('deriveChildState: "Primary Contact" and "Spouse" are false (adult relationships)', () => {
  assert.equal(deriveChildState({ family_relationship: 'Primary Contact' }), false);
  assert.equal(deriveChildState({ family_relationship: 'Spouse' }), false);
});

test('deriveChildState: missing family_relationship entirely is null', () => {
  assert.equal(deriveChildState({}), null);
});

test('deriveChildState: an unrecognized relationship label is null, not a guess', () => {
  assert.equal(deriveChildState({ family_relationship: 'Other' }), null);
});

test('deriveChildState: is case-insensitive and trims whitespace', () => {
  assert.equal(deriveChildState({ family_relationship: '  child  ' }), true);
  assert.equal(deriveChildState({ family_relationship: 'SPOUSE' }), false);
});

// ─── normalizePerson: shape, trimming, exact IDs ───────────────────────────

test('normalizePerson produces the Task 5 normalized shape with exact IDs and trimmed names', () => {
  const result = normalizePerson(fixtures.activePerson);
  assert.equal(result.provider, 'elvanto');
  assert.equal(result.id, '2001');
  assert.equal(result.firstName, 'Alice');
  assert.equal(result.lastName, 'Anderson');
  assert.equal(result.preferredName, null);
  assert.equal(result.state, 'active');
  assert.equal(result.child, false); // Primary Contact -> adult
  assert.equal(result.familyId, 'fam-100');
  assert.equal(result.familyRelationship, 'Primary Contact');
  assert.equal(result.categoryId, 'cat-1');
  assert.equal(result.modifiedAt, '2024-03-01 09:30:00');
  assert.deepEqual(Object.keys(result).sort(), [
    'attributes', 'categoryId', 'child', 'familyId', 'familyRelationship',
    'firstName', 'id', 'lastName', 'modifiedAt', 'preferredName', 'provider', 'state',
  ]);
});

test('normalizePerson trims whitespace from names and preserves a preferred name', () => {
  const result = normalizePerson({ ...fixtures.person(), id: '9', firstname: '  Pat  ', lastname: '  Lee  ' });
  assert.equal(result.firstName, 'Pat');
  assert.equal(result.lastName, 'Lee');

  const preferred = normalizePerson(fixtures.preferredNamePerson);
  assert.equal(preferred.firstName, 'Robert');
  assert.equal(preferred.preferredName, 'Rob');
});

test('normalizePerson never invents a name for a record with only one usable name', () => {
  const onlyFirst = normalizePerson({ ...fixtures.person(), id: '77', firstname: 'Solo', lastname: '' });
  assert.equal(onlyFirst.firstName, 'Solo');
  assert.equal(onlyFirst.lastName, '');

  const onlyLast = normalizePerson({ ...fixtures.person(), id: '78', firstname: '', lastname: 'OnlyLast' });
  assert.equal(onlyLast.firstName, '');
  assert.equal(onlyLast.lastName, 'OnlyLast');
});

test('normalizePerson returns null for a record with no usable stable ID', () => {
  assert.equal(normalizePerson(fixtures.missingIdPerson), null);
});

test('normalizePerson returns null for a record missing both usable names', () => {
  assert.equal(normalizePerson(fixtures.missingNamesPerson), null);
});

test('normalizePerson normalizes an absent family_id to null, not an empty string', () => {
  const result = normalizePerson(fixtures.soloPerson);
  assert.equal(result.familyId, null);
  assert.equal(result.familyRelationship, null);
});

test('normalizePerson stringifies a numeric family_id instead of dropping it as blank', () => {
  const result = normalizePerson({ ...fixtures.person(), id: '99', family_id: 42 });
  assert.equal(result.familyId, '42');
});

test('normalizePerson tolerates a record with every optional field entirely absent', () => {
  const result = normalizePerson(fixtures.noOptionalFieldsPerson);
  assert.equal(result.id, '2013');
  assert.equal(result.preferredName, null);
  assert.equal(result.familyId, null);
  assert.equal(result.familyRelationship, null);
  assert.equal(result.categoryId, null);
  assert.equal(result.modifiedAt, null);
  assert.deepEqual(result.attributes, {
    groups: [], demographics: [], departments: [], serviceTypes: [], locations: [], customFields: {},
  });
});

test('normalizePerson carries a single-value custom field through as a plain string', () => {
  const result = normalizePerson(fixtures.singleValueCustomFieldPerson);
  assert.deepEqual(result.attributes.customFields, { 'T-Shirt Size': 'M' });
});

test('normalizePerson carries a list-value custom field through as an array', () => {
  const result = normalizePerson(fixtures.listValueCustomFieldPerson);
  assert.deepEqual(result.attributes.customFields, { Interests: ['Music', 'Sports'] });
});

test('normalizePerson projects raw demographics object entries into a sorted attributes.demographics array', () => {
  const result = normalizePerson(fixtures.activePerson);
  assert.deepEqual(result.attributes.demographics, [{ field: 'marital_status', value: 'Married' }]);
});

test('normalizePerson folds an injected per-person membership bundle into attributes', () => {
  const result = normalizePerson(fixtures.activePerson, {
    groups: ['Choir', 'Choir', 'Welcome Team'],
    departments: ['Music'],
    serviceTypes: ['Sunday AM'],
    locations: ['Main Campus'],
  });
  assert.deepEqual(result.attributes.groups, ['Choir', 'Welcome Team']); // de-duplicated + sorted
  assert.deepEqual(result.attributes.departments, ['Music']);
  assert.deepEqual(result.attributes.serviceTypes, ['Sunday AM']);
  assert.deepEqual(result.attributes.locations, ['Main Campus']);
});

test('normalizePerson defaults every membership attribute to an empty array when none is supplied', () => {
  const result = normalizePerson(fixtures.activePerson);
  assert.deepEqual(result.attributes.groups, []);
  assert.deepEqual(result.attributes.departments, []);
  assert.deepEqual(result.attributes.serviceTypes, []);
  assert.deepEqual(result.attributes.locations, []);
});

test('normalizePerson never carries email or mobile fields even if present on the raw record', () => {
  const raw = { ...fixtures.person(), id: '55', firstname: 'No', lastname: 'Contact', email: 'a@b.com', mobile: '+61400000000' };
  const result = normalizePerson(raw);
  assert.equal('email' in result, false);
  assert.equal('mobile' in result, false);
  assert.equal(JSON.stringify(result).includes('a@b.com'), false);
  assert.equal(JSON.stringify(result).includes('+61400000000'), false);
});

// ─── normalizeSnapshot: people / families / skipped ────────────────────────

test('normalizeSnapshot returns { people, families, skipped } and drops invalid records with reason codes', () => {
  const snapshot = normalizeSnapshot(fixtures.rawPeopleSnapshot);
  assert.deepEqual(Object.keys(snapshot).sort(), ['families', 'people', 'skipped']);

  const skippedById = new Map(snapshot.skipped.map((s) => [s.reason, s]));
  assert.ok(snapshot.skipped.some((s) => s.reason === 'MISSING_ID'));
  assert.ok(snapshot.skipped.some((s) => s.reason === 'MISSING_NAME'));
  assert.equal(skippedById.get('MISSING_NAME').id, '2010');
  assert.equal(skippedById.get('MISSING_ID').id, null);

  const validCount = fixtures.rawPeopleSnapshot.length - 2; // missingIdPerson + missingNamesPerson
  assert.equal(snapshot.people.length, validCount);
});

test('normalizeSnapshot sorts people by stable ID', () => {
  const shuffled = [...fixtures.rawPeopleSnapshot].reverse();
  const snapshot = normalizeSnapshot(shuffled);
  const ids = snapshot.people.map((p) => p.id);
  const sortedIds = [...ids].sort();
  assert.deepEqual(ids, sortedIds);
});

test('normalizeSnapshot is deterministic regardless of input array order', () => {
  const first = normalizeSnapshot(fixtures.rawPeopleSnapshot);
  const second = normalizeSnapshot([...fixtures.rawPeopleSnapshot].reverse());
  assert.deepEqual(first, second);
});

test('normalizeSnapshot looks up each person\'s membership bundle from groupMemberships by raw ID', () => {
  const groupMemberships = new Map([
    ['2001', { groups: ['Choir'] }],
  ]);
  const snapshot = normalizeSnapshot([fixtures.activePerson], groupMemberships);
  const alice = snapshot.people.find((p) => p.id === '2001');
  assert.deepEqual(alice.attributes.groups, ['Choir']);
});

test('normalizeSnapshot accepts a plain object for groupMemberships as well as a Map', () => {
  const snapshot = normalizeSnapshot([fixtures.activePerson], { 2001: { groups: ['Choir'] } });
  assert.deepEqual(snapshot.people[0].attributes.groups, ['Choir']);
});

// ─── buildElvantoFamilies ───────────────────────────────────────────────────

test('buildElvantoFamilies groups normalized people by familyId and derives a family name, primary contact first', () => {
  const people = [fixtures.activePerson, fixtures.spousePerson, fixtures.childPerson].map((p) => normalizePerson(p));
  const families = buildElvantoFamilies(people);

  assert.equal(families.length, 1);
  const family = families[0];
  assert.equal(family.id, 'fam-100');
  assert.equal(family.primaryContactExternalId, '2001');
  assert.deepEqual(family.memberExternalIds, ['2001', '2006', '2007']); // sorted by id
  assert.equal(family.name, 'Anderson, Alice and Beth'); // primary contact first, adults only (child excluded)
});

test('buildElvantoFamilies excludes solo people (no familyId) from the families output entirely', () => {
  const people = [fixtures.soloPerson, fixtures.activePerson, fixtures.spousePerson, fixtures.childPerson]
    .map((p) => normalizePerson(p));
  const families = buildElvantoFamilies(people);
  assert.equal(families.length, 1);
  assert.equal(families[0].id, 'fam-100');
});

test('buildElvantoFamilies falls back to the first member when no Primary Contact is present', () => {
  const noPrimary = { ...fixtures.spousePerson, id: '3001', family_relationship: '' };
  const child = { ...fixtures.childPerson, id: '3002' };
  const people = [noPrimary, child].map((p) => normalizePerson(p));
  const families = buildElvantoFamilies(people);
  assert.equal(families.length, 1);
  assert.equal(families[0].primaryContactExternalId, null);
  assert.equal(families[0].name, 'Anderson, Beth'); // only adult member, since child is excluded from naming
});

test('buildElvantoFamilies produces a deterministic result regardless of input order', () => {
  const people = [fixtures.activePerson, fixtures.spousePerson, fixtures.childPerson].map((p) => normalizePerson(p));
  const first = buildElvantoFamilies(people);
  const second = buildElvantoFamilies([...people].reverse());
  assert.deepEqual(first, second);
});

test('buildElvantoFamilies sorts multiple families by ID', () => {
  const famB = normalizePerson({ ...fixtures.person(), id: '10', family_id: 'fam-b', family_relationship: 'Primary Contact' });
  const famA = normalizePerson({ ...fixtures.person(), id: '11', family_id: 'fam-a', family_relationship: 'Primary Contact' });
  const families = buildElvantoFamilies([famB, famA]);
  assert.deepEqual(families.map((f) => f.id), ['fam-a', 'fam-b']);
});

test('normalizeSnapshot wires buildElvantoFamilies output into snapshot.families', () => {
  const snapshot = normalizeSnapshot([fixtures.activePerson, fixtures.spousePerson, fixtures.childPerson]);
  assert.equal(snapshot.families.length, 1);
  assert.equal(snapshot.families[0].id, 'fam-100');
});
