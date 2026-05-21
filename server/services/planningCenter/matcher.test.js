const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeName, nameKey, matchIndividuals } = require('./matcher');

test('normalizeName lowercases, strips punctuation/accents, collapses spaces', () => {
  assert.strictEqual(normalizeName('  O’Brien-Smith '), 'obriensmith');
  assert.strictEqual(normalizeName('José'), 'jose');
});

function pco(id, first, last, extra = {}) {
  return { id, firstName: first, lastName: last, status: 'active', membership: 'Church Members', child: false, householdId: null, ...extra };
}
function ind(id, first, last, extra = {}) {
  return { id, firstName: first, lastName: last, isChild: false, familyId: null, ...extra };
}

test('tier 1: unique name match auto-links', () => {
  const r = matchIndividuals([ind(1, 'Sarah', 'Wierenga')], [pco('p1', 'Sarah', 'Wierenga')], new Map());
  assert.deepStrictEqual(r.links, [{ individualId: 1, pcoId: 'p1' }]);
  assert.deepStrictEqual(r.ambiguous, []);
  assert.deepStrictEqual(r.unmatched, []);
});

test('no candidate -> unmatched', () => {
  const r = matchIndividuals([ind(1, 'Nobody', 'Here')], [pco('p1', 'Sarah', 'Wierenga')], new Map());
  assert.deepStrictEqual(r.unmatched, [1]);
  assert.deepStrictEqual(r.links, []);
});

test('child flag disambiguates same-name adult/child', () => {
  const people = [pco('pa', 'Sam', 'Lee', { child: false }), pco('pc', 'Sam', 'Lee', { child: true })];
  const r = matchIndividuals([ind(1, 'Sam', 'Lee', { isChild: true })], people, new Map());
  assert.deepStrictEqual(r.links, [{ individualId: 1, pcoId: 'pc' }]);
});

test('family corroboration breaks a name tie', () => {
  const people = [
    pco('j1', 'John', 'Smith', { householdId: 'hA' }),
    pco('j2', 'John', 'Smith', { householdId: 'hB' }),
    pco('jane', 'Jane', 'Smith', { householdId: 'hA' }),
  ];
  const familyMembers = new Map([[10, [{ firstName: 'John', lastName: 'Smith' }, { firstName: 'Jane', lastName: 'Smith' }]]]);
  const r = matchIndividuals([ind(1, 'John', 'Smith', { familyId: 10 })], people, familyMembers);
  assert.deepStrictEqual(r.links, [{ individualId: 1, pcoId: 'j1' }]);
});

test('unresolved duplicate -> ambiguous with candidate ids', () => {
  const people = [pco('j1', 'John', 'Smith'), pco('j2', 'John', 'Smith')];
  const r = matchIndividuals([ind(1, 'John', 'Smith')], people, new Map());
  assert.strictEqual(r.links.length, 0);
  assert.strictEqual(r.ambiguous.length, 1);
  assert.deepStrictEqual(r.ambiguous[0].candidates.sort(), ['j1', 'j2']);
});

test('a pco person is not linked to two individuals', () => {
  const r = matchIndividuals([ind(1, 'Sarah', 'Wierenga'), ind(2, 'Sarah', 'Wierenga')], [pco('p1', 'Sarah', 'Wierenga')], new Map());
  assert.strictEqual(r.links.length, 1);
  assert.strictEqual(r.unmatched.length, 1);
});

test('nameKey is stable for first+last', () => {
  assert.strictEqual(nameKey('John', 'Smith'), 'john|smith');
});
