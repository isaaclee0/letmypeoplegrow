'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { captureFilterSnapshotInput } = require('./filterSnapshot');

test('captures only gated PII-free facts and marks dimensions outside coverage as unavailable', () => {
  const seen = [];
  const result = captureFilterSnapshotInput({
    provider: 'elvanto',
    snapshot: { people: [
      { id: 'active-1', state: 'active', firstName: 'Ada', attributes: { value: 'member' } },
      { id: 'archived-1', state: 'archived', firstName: 'Grace', attributes: { value: 'former' } },
    ] },
    providerMetadata: { version: 1 },
    settings: { includeContacts: false },
    coveredDimensionIds: new Set(['status', 'custom_field:known']),
    adapter: {
      isInFilterPopulation(person, settings) { return person.state === 'active' && settings.includeContacts === false; },
      toFilterFacts(person, covered) {
        seen.push({ id: person.id, covered: [...covered].sort() });
        return { externalPersonId: person.id, dimensions: { status: ['active'] } };
      },
      buildFilterDimensions({ facts }) { return [{ id: 'status', cardinality: 'single', values: [{ id: 'active', count: facts.length }] }]; },
    },
  });

  assert.deepEqual(seen, [{ id: 'active-1', covered: ['custom_field:known', 'status'] }]);
  assert.deepEqual(result.facts, [{ externalPersonId: 'active-1', dimensions: { status: ['active'] } }]);
  assert.deepEqual(result.coverage, ['custom_field:known', 'status']);
  assert.equal(result.coverage.includes('custom_field:unknown'), false);
  assert.equal(typeof result.populationGateDigest, 'string');
  assert.equal(result.populationGateDigest.length, 64);
  assert.doesNotMatch(JSON.stringify(result), /Ada|Grace|firstName|archived-1|former/i);
});

test('population-gate digest changes only when a gate-relevant setting changes', () => {
  const adapter = {
    isInFilterPopulation() { return true; },
    toFilterFacts(person) { return { externalPersonId: person.id, dimensions: {} }; },
    buildFilterDimensions() { return []; },
  };
  const base = { provider: 'elvanto', snapshot: { people: [{ id: 'p1' }] }, providerMetadata: {}, coveredDimensionIds: [], adapter };
  const contactsOn = captureFilterSnapshotInput({ ...base, settings: { includeContacts: true, unrelated: 'a' } });
  const contactsOnDifferentUnrelatedValue = captureFilterSnapshotInput({ ...base, settings: { includeContacts: true, unrelated: 'b' } });
  const contactsOff = captureFilterSnapshotInput({ ...base, settings: { includeContacts: false } });
  assert.equal(contactsOn.populationGateDigest, contactsOnDifferentUnrelatedValue.populationGateDigest);
  assert.notEqual(contactsOn.populationGateDigest, contactsOff.populationGateDigest);
});

test('keeps an absent covered dimension distinct from an uncovered dimension', () => {
  const result = captureFilterSnapshotInput({
    provider: 'planning_center',
    snapshot: { people: [{ id: 'p1' }] },
    providerMetadata: {}, settings: {}, coveredDimensionIds: ['membership'],
    adapter: {
      isInFilterPopulation() { return true; },
      toFilterFacts() { return { externalPersonId: 'p1', dimensions: { membership: [], 'custom_field:12': ['must-not-leak'] } }; },
      buildFilterDimensions() { return []; },
    },
  });
  assert.deepEqual(result.facts, [{ externalPersonId: 'p1', dimensions: {} }]);
  assert.deepEqual(result.coverage, ['membership']);
  assert.equal(result.coverage.includes('custom_field:12'), false);
});

test('passes explicit coverage to dimension builders', () => {
  let seenCoverage;
  captureFilterSnapshotInput({
    provider: 'planning_center', snapshot: { people: [] }, providerMetadata: {}, settings: {},
    coveredDimensionIds: ['membership'],
    adapter: {
      isInFilterPopulation() { return true; },
      toFilterFacts() { throw new Error('no people should be projected'); },
      buildFilterDimensions({ coveredDimensionIds }) { seenCoverage = coveredDimensionIds; return []; },
    },
  });
  assert.deepEqual(seenCoverage, ['membership']);
});
