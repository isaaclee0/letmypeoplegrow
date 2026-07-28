'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { previewFilter, eligibleIdsForBatch } = require('./filterPreview');

const metadata = {
  dimensions: [
    { id: 'status', cardinality: 'single', values: [{ id: 'active' }, { id: 'inactive' }] },
    { id: 'group', cardinality: 'multi', values: [{ id: 'music' }, { id: 'youth' }] },
  ],
};

const active = (dimensionId, values) => ({
  branches: [{ groups: [{ dimensionId, mode: 'any', values }] }],
  exclusions: [],
});

const cacheEntry = {
  churchId: 'churcha1',
  provider: 'elvanto',
  snapshotId: 'snapshot-1',
  capturedAt: '2026-07-28T00:00:00.000Z',
  expiresAt: '2099-07-29T00:00:00.000Z',
  fresh: false,
  coveredDimensionIds: ['group', 'status'],
  populationGateDigest: 'gate-1',
  facts: [
    { externalPersonId: 'p1', dimensions: { status: ['active'], group: ['music'] } },
    { externalPersonId: 'p2', dimensions: { status: ['active'], group: ['youth'] } },
    { externalPersonId: 'p3', dimensions: { status: ['inactive'], group: ['music'] } },
    { externalPersonId: 'p4', dimensions: { status: ['active'] } },
    { externalPersonId: 'p5', dimensions: { status: ['inactive'] } },
  ],
};

const batches = [
  { id: 3, name: 'Active people', enabled: true, filterSchemaVersion: 2, filterConfig: active('status', ['active']), gatheringTypeId: 10, defaultPeopleType: 'regular' },
  { id: 7, name: 'Legacy music', enabled: true, filterSchemaVersion: 1, filterConfig: { legacy: 'music' }, gatheringTypeId: 20, defaultPeopleType: 'local_visitor' },
  { id: 8, name: 'Disabled youth', enabled: false, filterSchemaVersion: 2, filterConfig: active('group', ['youth']), gatheringTypeId: 10, defaultPeopleType: 'regular' },
];

function evaluateLegacy(provider, facts, config) {
  assert.equal(provider, 'elvanto');
  return config.legacy === 'music' && facts.dimensions.group?.includes('music');
}

test('preview uses cached facts for proposed counts, mixed-schema overlaps, and enabled-union replacement', () => {
  const existingEdit = previewFilter({
    churchId: 'churcha1', provider: 'elvanto', batchId: 3,
    proposed: {
      filterSchemaVersion: 2, filterConfig: active('status', ['active']), enabled: true,
      gatheringTypeId: 20, defaultPeopleType: 'local_visitor',
    },
    cacheEntry, batches, metadata, populationGateDigest: 'gate-1', evaluateLegacy,
  });

  assert.equal(existingEdit.matchCount, 3);
  assert.deepEqual(existingEdit.overlaps, [{ batchId: 7, batchName: 'Legacy music', count: 1 }]);
  assert.equal(existingEdit.uniqueEnabledPopulationCount, 4);
  assert.deepEqual(existingEdit.warnings, []);
  assert.deepEqual(existingEdit.snapshot, {
    id: 'snapshot-1', capturedAt: cacheEntry.capturedAt, fresh: false,
    expiresAt: cacheEntry.expiresAt, coveredDimensionIds: ['group', 'status'],
  });

  const newEnabledProposal = previewFilter({
    churchId: 'churcha1', provider: 'elvanto', batchId: null,
    proposed: { id: 9, name: 'Inactive people', filterSchemaVersion: 2, filterConfig: active('status', ['inactive']), enabled: true },
    cacheEntry, batches, metadata, populationGateDigest: 'gate-1', evaluateLegacy,
  });
  assert.equal(newEnabledProposal.uniqueEnabledPopulationCount, 5);

  const newDisabledProposal = previewFilter({
    churchId: 'churcha1', provider: 'elvanto', batchId: null,
    proposed: { id: 9, name: 'Inactive people', filterSchemaVersion: 2, filterConfig: active('status', ['inactive']), enabled: false },
    cacheEntry, batches, metadata, populationGateDigest: 'gate-1', evaluateLegacy,
  });
  assert.equal(newDisabledProposal.uniqueEnabledPopulationCount, 4);
});

test('preview reports positive overlaps deterministically and warns about conflicting batch outcomes', () => {
  const preview = previewFilter({
    churchId: 'churcha1', provider: 'elvanto', batchId: null,
    proposed: {
      id: 9, name: 'New active people', enabled: true, filterSchemaVersion: 2,
      filterConfig: active('status', ['active']), gatheringTypeId: 99, defaultPeopleType: 'traveller_visitor',
    },
    cacheEntry, batches, metadata, populationGateDigest: 'gate-1', evaluateLegacy,
  });

  assert.deepEqual(preview.overlaps, [
    { batchId: 3, batchName: 'Active people', count: 3 },
    { batchId: 7, batchName: 'Legacy music', count: 1 },
  ]);
  assert.deepEqual(preview.warnings, ['OVERLAP_DEFAULT_PEOPLE_TYPE', 'OVERLAP_GATHERING_TYPE']);
});

test('legacy eligibility requires an injected evaluator while schema 2 uses the common Boolean engine', () => {
  const legacy = batches[1];
  assert.throws(() => eligibleIdsForBatch(legacy, cacheEntry, null, {}), /evaluateLegacy/);
  assert.deepEqual([...eligibleIdsForBatch(legacy, cacheEntry, null, { evaluateLegacy })], ['p1', 'p3']);
  assert.deepEqual([...eligibleIdsForBatch(batches[0], cacheEntry, null, {})], ['p1', 'p2', 'p4']);
});

test('preview never fabricates counts for absent, expired, gate-mismatched, or insufficient cache coverage', () => {
  const input = {
    churchId: 'churcha1', provider: 'elvanto', batchId: null,
    proposed: { id: 9, enabled: true, filterSchemaVersion: 2, filterConfig: active('group', ['music']) },
    batches, metadata, populationGateDigest: 'gate-1', evaluateLegacy,
  };
  for (const [entry, expectedMissing] of [
    [null, ['group', 'status']],
    [{ ...cacheEntry, expiresAt: '2000-01-01T00:00:00.000Z' }, []],
    [{ ...cacheEntry, populationGateDigest: 'different-gate' }, []],
    [{ ...cacheEntry, coveredDimensionIds: ['status'] }, ['group']],
  ]) {
    const preview = previewFilter({ ...input, cacheEntry: entry });
    assert.equal(preview.matchCount, null);
    assert.equal(preview.uniqueEnabledPopulationCount, null);
    assert.deepEqual(preview.missingDimensionIds, expectedMissing);
  }
});

test('preview marks NOT-only and whole-population filters as broad', () => {
  const notOnly = previewFilter({
    churchId: 'churcha1', provider: 'elvanto', batchId: null,
    proposed: { enabled: true, filterSchemaVersion: 2, filterConfig: { branches: [], exclusions: [{ dimensionId: 'group', values: ['music'] }] } },
    cacheEntry, batches: [], metadata, populationGateDigest: 'gate-1', evaluateLegacy,
  });
  assert.deepEqual(notOnly.warnings, ['BROAD_FILTER']);

  const wholePopulation = previewFilter({
    churchId: 'churcha1', provider: 'elvanto', batchId: null,
    proposed: { enabled: true, filterSchemaVersion: 2, filterConfig: active('status', ['active', 'inactive']) },
    cacheEntry, batches: [], metadata, populationGateDigest: 'gate-1', evaluateLegacy,
  });
  assert.deepEqual(wholePopulation.warnings, ['BROAD_FILTER']);
});
