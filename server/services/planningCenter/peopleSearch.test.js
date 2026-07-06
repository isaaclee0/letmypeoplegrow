const { test } = require('node:test');
const assert = require('node:assert');
const { searchPcoPeople } = require('./peopleSearch');

function pco(id, first, last, extra = {}) {
  return { id, firstName: first, lastName: last, status: 'active', householdId: null, ...extra };
}

test('matches on substring of the normalized full name', () => {
  const people = [pco('p1', 'Sarah', 'Wierenga'), pco('p2', 'John', 'Smith')];
  const results = searchPcoPeople(people, 'wiere', new Set());
  assert.deepStrictEqual(results, [{ pcoId: 'p1', firstName: 'Sarah', lastName: 'Wierenga', householdId: null, status: 'active' }]);
});

test('excludes PCO people already linked to an individual', () => {
  const people = [pco('p1', 'Sarah', 'Wierenga'), pco('p2', 'Sarah', 'Wierenga-Jones')];
  const results = searchPcoPeople(people, 'wierenga', new Set(['p1']));
  assert.deepStrictEqual(results.map((r) => r.pcoId), ['p2']);
});

test('empty query returns no results', () => {
  const people = [pco('p1', 'Sarah', 'Wierenga')];
  assert.deepStrictEqual(searchPcoPeople(people, '', new Set()), []);
  assert.deepStrictEqual(searchPcoPeople(people, '   ', new Set()), []);
});

test('respects the limit', () => {
  const people = [pco('p1', 'Sam', 'A'), pco('p2', 'Sam', 'B'), pco('p3', 'Sam', 'C')];
  const results = searchPcoPeople(people, 'sam', new Set(), 2);
  assert.strictEqual(results.length, 2);
});

test('matches across first/last name boundary (accent/punctuation insensitive, via normalizeName)', () => {
  const people = [pco('p1', 'José', "O'Brien")];
  const results = searchPcoPeople(people, 'jose obrien', new Set());
  assert.strictEqual(results.length, 1);
});
