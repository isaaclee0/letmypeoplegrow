'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { previewFilter, eligibleIdsForBatch } = require('./filterPreview');

const metadata = {
  dimensions: [
    { id: 'status', cardinality: 'single', values: [{ id: 'active' }, { id: 'inactive' }] },
    { id: 'groups', cardinality: 'multi', values: [{ id: 'music' }, { id: 'youth' }] },
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
  coveredDimensionIds: ['groups', 'status'],
  populationGateDigest: 'gate-1',
  facts: [
    { externalPersonId: 'p1', dimensions: { status: ['active'], groups: ['music'] } },
    { externalPersonId: 'p2', dimensions: { status: ['active'], groups: ['youth'] } },
    { externalPersonId: 'p3', dimensions: { status: ['inactive'], groups: ['music'] } },
    { externalPersonId: 'p4', dimensions: { status: ['active'] } },
    { externalPersonId: 'p5', dimensions: { status: ['inactive'] } },
  ],
};

const batches = [
  { id: 3, name: 'Active people', enabled: true, filterSchemaVersion: 2, filterConfig: active('status', ['active']), gatheringTypeId: 10, defaultPeopleType: 'regular' },
  {
    id: 7, name: 'Legacy music', enabled: true, filterSchemaVersion: 1, gatheringTypeId: 20, defaultPeopleType: 'local_visitor',
    filterConfig: {
      statuses: ['active'], categoryIds: [], groups: { ids: ['music'], operator: 'any' },
      demographics: { values: [], operator: 'any' }, departments: { values: [], operator: 'any' },
      serviceTypes: { ids: [], operator: 'any' }, locations: { ids: [], operator: 'any' }, customFields: [],
    },
  },
  { id: 8, name: 'Disabled youth', enabled: false, filterSchemaVersion: 2, filterConfig: active('groups', ['youth']), gatheringTypeId: 10, defaultPeopleType: 'regular' },
];

function evaluateLegacy(provider, facts, config) {
  assert.equal(provider, 'elvanto');
  return config.groups.ids.includes('music') && facts.dimensions.groups?.includes('music');
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
    expiresAt: cacheEntry.expiresAt, coveredDimensionIds: ['groups', 'status'],
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

test('legacy eligibility uses its production evaluator by default while retaining injection', () => {
  const legacy = batches[1];
  assert.deepEqual([...eligibleIdsForBatch(legacy, cacheEntry, null, {})], ['p1']);
  assert.deepEqual([...eligibleIdsForBatch(legacy, cacheEntry, null, { evaluateLegacy })], ['p1', 'p3']);
  assert.deepEqual([...eligibleIdsForBatch(batches[0], cacheEntry, null, {})], ['p1', 'p2', 'p4']);
});

test('an edit uses the authoritative numeric-or-string batchId instead of proposed.id', () => {
  const preview = previewFilter({
    churchId: 'churcha1', provider: 'elvanto', batchId: '3',
    proposed: { id: 7, enabled: true, filterSchemaVersion: 2, filterConfig: active('status', ['inactive']) },
    cacheEntry, batches, metadata, populationGateDigest: 'gate-1', evaluateLegacy,
  });

  assert.deepEqual(preview.overlaps, [{ batchId: 7, batchName: 'Legacy music', count: 1 }]);
  assert.equal(preview.uniqueEnabledPopulationCount, 3);
});

test('a creation ignores proposed.id and never replaces an existing batch', () => {
  const preview = previewFilter({
    churchId: 'churcha1', provider: 'elvanto', batchId: null,
    proposed: { id: 3, enabled: true, filterSchemaVersion: 2, filterConfig: active('status', ['inactive']) },
    cacheEntry, batches, metadata, populationGateDigest: 'gate-1', evaluateLegacy,
  });

  assert.equal(preview.uniqueEnabledPopulationCount, 5);
  assert.deepEqual(preview.overlaps, [
    { batchId: 3, batchName: 'Active people', count: 0 },
    { batchId: 7, batchName: 'Legacy music', count: 1 },
  ]);
});

test('an uncovered legacy v1 dimension makes the enabled union unavailable without fabricating a count', () => {
  const preview = previewFilter({
    churchId: 'churcha1', provider: 'elvanto', batchId: null,
    proposed: { enabled: true, filterSchemaVersion: 2, filterConfig: active('status', ['active']) },
    cacheEntry: { ...cacheEntry, coveredDimensionIds: ['status'] }, batches, metadata,
    populationGateDigest: 'gate-1', evaluateLegacy,
  });

  assert.equal(preview.matchCount, 3);
  assert.equal(preview.uniqueEnabledPopulationCount, null);
  assert.deepEqual(preview.missingDimensionIds, ['groups']);
});

test('a malformed Elvanto v1 filter is unavailable and is never sent to the legacy evaluator', () => {
  let evaluated = 0;
  const preview = previewFilter({
    churchId: 'churcha1', provider: 'elvanto', batchId: null,
    proposed: {
      enabled: true, filterSchemaVersion: 1,
      filterConfig: { ...batches[1].filterConfig, statuses: [null] },
    },
    cacheEntry, batches: [], metadata, populationGateDigest: 'gate-1',
    evaluateLegacy: () => { evaluated += 1; return true; },
  });

  assert.equal(preview.matchCount, null);
  assert.equal(preview.uniqueEnabledPopulationCount, null);
  assert.equal(evaluated, 0);
});

test('PCO v1 validation rejects malformed values and preserves valid membership coverage', () => {
  const pcoCache = {
    ...cacheEntry,
    provider: 'planning_center',
    coveredDimensionIds: ['membership'],
    facts: [
      { externalPersonId: 'p1', dimensions: { membership: ['member'] } },
      { externalPersonId: 'p2', dimensions: {} },
    ],
  };
  const valid = {
    membershipFilterEnabled: true, membershipAllowlist: ['member'],
    fieldFilterEnabled: false, fieldFilters: [],
  };
  const validPreview = previewFilter({
    churchId: 'churcha1', provider: 'planning_center', batchId: null,
    proposed: { enabled: true, filterSchemaVersion: 1, filterConfig: valid },
    cacheEntry: pcoCache, batches: [], metadata, populationGateDigest: 'gate-1',
    evaluateLegacy: (_provider, facts) => facts.dimensions.membership?.includes('member'),
  });
  assert.equal(validPreview.matchCount, 1);

  let evaluated = 0;
  const malformedPreview = previewFilter({
    churchId: 'churcha1', provider: 'planning_center', batchId: null,
    proposed: {
      enabled: true, filterSchemaVersion: 1,
      filterConfig: { ...valid, membershipAllowlist: [1] },
    },
    cacheEntry: pcoCache, batches: [], metadata, populationGateDigest: 'gate-1',
    evaluateLegacy: () => { evaluated += 1; return true; },
  });
  assert.equal(malformedPreview.matchCount, null);
  assert.equal(malformedPreview.uniqueEnabledPopulationCount, null);
  assert.equal(evaluated, 0);
});

test('PCO v1 preview rejects unexpected root and field-rule keys before legacy evaluation', () => {
  const pcoCache = {
    ...cacheEntry, provider: 'planning_center', coveredDimensionIds: ['membership', 'custom_field:field-1'],
    facts: [{ externalPersonId: 'p1', dimensions: { membership: ['member'], 'custom_field:field-1': ['yes'] } }],
  };
  const valid = {
    membershipFilterEnabled: true, membershipAllowlist: ['member'],
    fieldFilterEnabled: true, fieldFilters: [{ fieldDefinitionId: 'field-1', values: ['yes'] }],
  };
  for (const filterConfig of [
    { ...valid, unexpected: true },
    { ...valid, fieldFilters: [{ ...valid.fieldFilters[0], unexpected: true }] },
  ]) {
    let evaluated = 0;
    const preview = previewFilter({
      churchId: 'churcha1', provider: 'planning_center', batchId: null,
      proposed: { enabled: true, filterSchemaVersion: 1, filterConfig },
      cacheEntry: pcoCache, batches: [], metadata, populationGateDigest: 'gate-1',
      evaluateLegacy: () => { evaluated += 1; return true; },
    });
    assert.equal(preview.matchCount, null);
    assert.equal(evaluated, 0);
  }
});

test('Elvanto v1 preview rejects surplus selection and custom-field keys before legacy evaluation', () => {
  const valid = batches[1].filterConfig;
  for (const filterConfig of [
    { ...valid, groups: { ...valid.groups, unexpected: true } },
    { ...valid, customFields: [{ fieldId: 'field-1', values: ['yes'], operator: 'any', unexpected: true }] },
  ]) {
    let evaluated = 0;
    const preview = previewFilter({
      churchId: 'churcha1', provider: 'elvanto', batchId: null,
      proposed: { enabled: true, filterSchemaVersion: 1, filterConfig },
      cacheEntry, batches: [], metadata, populationGateDigest: 'gate-1',
      evaluateLegacy: () => { evaluated += 1; return true; },
    });
    assert.equal(preview.matchCount, null);
    assert.equal(evaluated, 0);
  }
});

test('preview never fabricates counts for absent, expired, gate-mismatched, or insufficient cache coverage', () => {
  const input = {
    churchId: 'churcha1', provider: 'elvanto', batchId: null,
    proposed: { id: 9, enabled: true, filterSchemaVersion: 2, filterConfig: active('groups', ['music']) },
    batches, metadata, populationGateDigest: 'gate-1', evaluateLegacy,
  };
  for (const [entry, expectedMissing] of [
    [null, ['groups', 'status']],
    [{ ...cacheEntry, expiresAt: '2000-01-01T00:00:00.000Z' }, []],
    [{ ...cacheEntry, populationGateDigest: 'different-gate' }, []],
    [{ ...cacheEntry, coveredDimensionIds: ['status'] }, ['groups']],
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
    proposed: { enabled: true, filterSchemaVersion: 2, filterConfig: { branches: [], exclusions: [{ dimensionId: 'groups', values: ['music'] }] } },
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
