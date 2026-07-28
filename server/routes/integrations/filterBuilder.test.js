'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { createFilterBuilderRouter, createFilterBuilderJsonParser } = require('./filterBuilder');

const ADMIN = { id: 1, church_id: 'churcha1', role: 'admin' };
const OTHER_ADMIN = { id: 2, church_id: 'churchb2', role: 'admin' };
const NON_ADMIN = { id: 3, church_id: 'churcha1', role: 'attendance_taker' };
const filter = { branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['active'] }] }], exclusions: [] };
const metadata = { dimensions: [{ id: 'status', cardinality: 'single', values: [{ id: 'active', label: 'Active', count: 1 }] }] };
const cachedEntry = {
  churchId: 'churcha1', provider: 'elvanto', snapshotId: 'snapshot-1', capturedAt: '2026-07-28T00:00:00.000Z',
  expiresAt: '2030-07-28T00:00:00.000Z', fresh: true, coveredDimensionIds: ['status'], dimensions: metadata.dimensions,
  facts: [{ externalPersonId: 'p1', dimensions: { status: ['active'] } }], populationGateDigest: 'gate',
};

function deps(extra = {}) {
  return {
    getProvider: () => ({
      provider: 'elvanto',
      fetchSnapshot: async () => ({ mode: 'full', complete: true, people: [{ id: 'p1', state: 'active' }] }),
      fetchMetadata: async () => ({ categories: [] }),
      toFilterFacts: (person, covered) => ({ externalPersonId: person.id, dimensions: covered.has('status') ? { status: [person.state] } : {} }),
      buildFilterDimensions: () => metadata.dimensions,
      isInFilterPopulation: () => true,
    }),
    getCredentials: async () => ({ apiKey: 'secret' }),
    listBatches: async () => [],
    getBatch: async (_churchId, _provider, id) => id === 1 ? { id: 1, provider: 'elvanto', filterSchemaVersion: 2, filterConfig: filter, filterRevision: 1 } : null,
    saveFilterDraft: async ({ filterConfig }) => ({ id: 1, provider: 'elvanto', filterSchemaVersion: 2, filterConfig: { branches: [], exclusions: [] }, draftFilterConfig: filterConfig }),
    discardFilterDraft: async () => ({ id: 1, provider: 'elvanto', filterSchemaVersion: 2, filterConfig: filter, draftFilterConfig: null }),
    cache: { get: () => cachedEntry, putComplete: () => cachedEntry },
    getSettings: async () => ({}),
    previewFilter: () => ({ matchCount: 1, snapshot: null, overlaps: [], uniqueEnabledPopulationCount: 1, missingDimensionIds: [], warnings: [] }),
    validateFilterV2: () => ({ ok: true, value: filter, unresolved: [] }),
    selectedDimensionIds: () => ['status'],
    selectedPairs: () => [],
    requiredDimensionIdsForBatch: (batch) => batch.filterSchemaVersion === 2 ? ['status'] : [],
    captureFilterSnapshotInput: () => ({ facts: [{ externalPersonId: 'p1', dimensions: { status: ['active'] } }], dimensions: metadata.dimensions, coverage: ['status'], populationGateDigest: 'gate' }),
    populationGateDigest: () => 'gate',
    peekCachedPcoPeople: () => null,
    ...extra,
  };
}

function server(overrides, user = ADMIN) {
  const app = express();
  // Mirrors the production order: the narrow parser runs before the
  // unrelated global JSON parser and therefore protects chunked bodies too.
  app.use('/api/integrations/people-sync/providers', createFilterBuilderJsonParser());
  app.use(express.json({ limit: '10mb' }));
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use('/api/integrations/people-sync/providers', createFilterBuilderRouter(overrides));
  return http.createServer(app);
}

async function withServer(overrides, user, run) {
  const instance = server(overrides, user);
  await new Promise((resolve) => instance.listen(0, resolve));
  const base = `http://127.0.0.1:${instance.address().port}/api/integrations/people-sync/providers`;
  try { return await run(base); } finally { await new Promise((resolve) => instance.close(resolve)); }
}

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() };
}

test('every filter endpoint requires an admin with a church context', async () => {
  for (const user of [null, NON_ADMIN]) {
    await withServer(deps(), user, async (base) => {
      const response = await request(base, '/elvanto/filter-metadata');
      assert.equal(response.status, user ? 403 : 401);
    });
  }
});

test('preview uses only cached collaborators and returns the exact safe contract', async () => {
  let providerCalls = 0;
  await withServer(deps({ getProvider: () => { providerCalls++; throw new Error('must not fetch'); } }), ADMIN, async (base) => {
    const response = await request(base, '/elvanto/filter-preview', {
      method: 'POST', body: { batchId: null, filterConfig: filter, enabled: true, defaultPeopleType: 'regular', gatheringTypeId: null },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body).sort(), ['matchCount', 'missingDimensionIds', 'overlaps', 'snapshot', 'success', 'uniqueEnabledPopulationCount', 'warnings']);
  });
  assert.equal(providerCalls, 0);
});

test('preview rejects an over-limit canonical filter before preview evaluation', async () => {
  let previewCalls = 0;
  const overLimit = { branches: Array.from({ length: 21 }, () => ({ groups: [{ dimensionId: 'status', mode: 'any', values: ['active'] }] })), exclusions: [] };
  await withServer(deps({
    validateFilterV2: () => ({ ok: false, value: null, errors: [{ code: 'TOO_MANY_BRANCHES' }] }),
    previewFilter: () => { previewCalls++; return {}; },
  }), ADMIN, async (base) => {
    const response = await request(base, '/elvanto/filter-preview', {
      method: 'POST', body: { batchId: null, filterConfig: overLimit, enabled: true, defaultPeopleType: 'regular', gatheringTypeId: null },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'SYNC_FILTER_INVALID');
  });
  assert.equal(previewCalls, 0);
});

test('preview permits only unresolved selections retained by the target active filter or draft', async () => {
  const activeConfig = { branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['retained-active'] }] }], exclusions: [] };
  const draftConfig = { branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['retained-draft'] }] }], exclusions: [] };
  let allowed = null;
  await withServer(deps({
    getBatch: async () => ({ id: 1, filterSchemaVersion: 2, filterConfig: activeConfig, draftFilterConfig: draftConfig }),
    selectedPairs: (config) => config === activeConfig
      ? [{ dimensionId: 'status', valueId: 'retained-active' }]
      : config === draftConfig ? [{ dimensionId: 'status', valueId: 'retained-draft' }] : [],
    validateFilterV2: (_config, _metadata, options) => { allowed = options.allowedUnresolvedPairs; return { ok: true, value: filter, unresolved: [] }; },
  }), ADMIN, async (base) => {
    const response = await request(base, '/elvanto/filter-preview', {
      method: 'POST', body: { batchId: 1, filterConfig: filter, enabled: true, defaultPeopleType: 'regular', gatheringTypeId: null },
    });
    assert.equal(response.status, 200);
  });
  assert.deepEqual([...allowed].sort(), [JSON.stringify(['status', 'retained-active']), JSON.stringify(['status', 'retained-draft'])].sort());
});

test('preview retains an unresolved selection from an active v2 filter without an existing draft', async () => {
  const activeConfig = { branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['retained-active'] }] }], exclusions: [] };
  let allowed = null;
  await withServer(deps({
    getBatch: async () => ({ id: 1, filterSchemaVersion: 2, filterConfig: activeConfig, draftFilterConfig: null }),
    selectedPairs: (config) => config === activeConfig ? [{ dimensionId: 'status', valueId: 'retained-active' }] : [],
    validateFilterV2: (_config, _metadata, options) => { allowed = options.allowedUnresolvedPairs; return { ok: true, value: filter, unresolved: [] }; },
  }), ADMIN, async (base) => {
    const response = await request(base, '/elvanto/filter-preview', {
      method: 'POST', body: { batchId: 1, filterConfig: filter, enabled: true, defaultPeopleType: 'regular', gatheringTypeId: null },
    });
    assert.equal(response.status, 200);
  });
  assert.deepEqual([...allowed], [JSON.stringify(['status', 'retained-active'])]);
});

test('refresh makes one full snapshot call, unions active and proposed dimensions, and does not replace a cache on incomplete data', async () => {
  const calls = [];
  const old = { snapshotId: 'old' };
  const cache = { get: () => old, putComplete: () => { throw new Error('incomplete snapshots must not be cached'); } };
  await withServer(deps({
    cache,
    listBatches: async () => [{ id: 1, filterSchemaVersion: 2, filterConfig: filter }],
    getProvider: () => ({
      provider: 'elvanto',
      fetchSnapshot: async (args) => { calls.push(args); return { mode: 'full', complete: false, people: [] }; },
      fetchMetadata: async () => { throw new Error('metadata must not run'); },
      toFilterFacts: () => ({}), buildFilterDimensions: () => [], isInFilterPopulation: () => true,
    }),
  }), ADMIN, async (base) => {
    const response = await request(base, '/elvanto/filter-snapshot/refresh', { method: 'POST', body: { filterConfig: filter } });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'SYNC_FILTER_CACHE_UNAVAILABLE');
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, 'full');
});

test('refresh unions exact v1 and v2 custom-field dimensions and passes one snapshot to metadata', async () => {
  const seen = { snapshots: 0, metadata: 0 };
  const v1 = { filterSchemaVersion: 1, provider: 'elvanto', filterConfig: { legacy: true } };
  const v2 = { filterSchemaVersion: 2, provider: 'elvanto', filterConfig: filter };
  await withServer(deps({
    listBatches: async () => [v1, v2],
    requiredDimensionIdsForBatch: (batch) => batch === v1 ? ['custom_field:old'] : ['status', 'custom_field:new'],
    selectedDimensionIds: () => ['status', 'custom_field:proposed'],
    getProvider: () => ({
      provider: 'elvanto',
      fetchSnapshot: async (args) => { seen.snapshots++; seen.args = args; return { mode: 'full', complete: true, people: [] }; },
      fetchMetadata: async ({ snapshot }) => { seen.metadata++; assert.equal(snapshot.mode, 'full'); return {}; },
      toFilterFacts: () => ({}), buildFilterDimensions: () => [], isInFilterPopulation: () => true,
    }),
    captureFilterSnapshotInput: () => ({ facts: [], dimensions: [], coverage: ['status'], populationGateDigest: 'gate' }),
  }), ADMIN, async (base) => {
    const response = await request(base, '/elvanto/filter-snapshot/refresh', { method: 'POST', body: { filterConfig: filter } });
    assert.equal(response.status, 200);
  });
  assert.equal(seen.snapshots, 1);
  assert.equal(seen.metadata, 1);
  assert.deepEqual(seen.args.customFieldIds.sort(), ['new', 'old', 'proposed']);
});

test('saving a draft is church scoped, validates canonical metadata, and requires acknowledgement for broad filters', async () => {
  let saved = false;
  await withServer(deps({
    getBatch: async (churchId) => churchId === 'churcha1' ? { id: 1, provider: 'elvanto', filterSchemaVersion: 2, filterConfig: filter, filterRevision: 1 } : null,
    validateFilterV2: () => ({ ok: true, value: { branches: [], exclusions: [{ dimensionId: 'status', values: ['active'] }] }, unresolved: [] }),
    saveFilterDraft: async () => { saved = true; return null; },
  }), ADMIN, async (base) => {
    const response = await request(base, '/elvanto/sync-batches/1/filter-draft', {
      method: 'PUT', body: { filterConfig: { branches: [], exclusions: [{ dimensionId: 'status', values: ['active'] }] }, broadMatchAcknowledged: false },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'SYNC_FILTER_BROAD_ACK_REQUIRED');
  });
  assert.equal(saved, false);
});

test('saving a whole-population draft requires acknowledgement', async () => {
  let saved = false;
  await withServer(deps({
    validateFilterV2: () => ({ ok: true, value: filter, unresolved: [] }),
    evaluateFilterV2: () => true,
    saveFilterDraft: async () => { saved = true; return null; },
  }), ADMIN, async (base) => {
    const response = await request(base, '/elvanto/sync-batches/1/filter-draft', {
      method: 'PUT', body: { filterConfig: filter, broadMatchAcknowledged: false },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'SYNC_FILTER_BROAD_ACK_REQUIRED');
  });
  assert.equal(saved, false);
});

test('saving an empty v2 filter does not require a broad acknowledgement', async () => {
  const empty = { branches: [], exclusions: [] };
  let saved = false;
  await withServer(deps({
    validateFilterV2: () => ({ ok: true, value: empty, unresolved: [] }),
    saveFilterDraft: async () => { saved = true; return { id: 1, filterSchemaVersion: 2, filterConfig: empty }; },
  }), ADMIN, async (base) => {
    const response = await request(base, '/elvanto/sync-batches/1/filter-draft', {
      method: 'PUT', body: { filterConfig: empty, broadMatchAcknowledged: false },
    });
    assert.equal(response.status, 200);
  });
  assert.equal(saved, true);
});

test('raw chunked JSON larger than 64 KiB is rejected before the route evaluates it', async () => {
  let evaluated = false;
  await withServer(deps({ previewFilter: () => { evaluated = true; return {}; } }), ADMIN, async (base) => {
    const url = new URL(`${base}/elvanto/filter-preview`);
    const response = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
        let raw = ''; res.on('data', (chunk) => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      });
      req.on('error', reject);
      req.write('{"padding":"');
      req.write('x'.repeat(70 * 1024));
      req.end('"}');
    });
    assert.equal(response.status, 413);
    assert.equal(response.body.code, 'SYNC_FILTER_INVALID');
  });
  assert.equal(evaluated, false);
});

test('invalid provider, exact JSON batch IDs, and another church batch are rejected safely', async () => {
  await withServer(deps({ getBatch: async () => null }), OTHER_ADMIN, async (base) => {
    assert.equal((await request(base, '/unknown/filter-metadata')).status, 404);
    assert.equal((await request(base, '/elvanto/sync-batches/nope/filter-draft', { method: 'PUT', body: {} })).status, 400);
    assert.equal((await request(base, '/elvanto/filter-preview', { method: 'POST', body: { batchId: '1', filterConfig: filter, enabled: true, defaultPeopleType: 'regular', gatheringTypeId: null } })).status, 400);
    assert.equal((await request(base, '/elvanto/filter-preview', { method: 'POST', body: { batchId: null, filterConfig: filter, enabled: true, defaultPeopleType: 'regular', gatheringTypeId: 0 } })).status, 400);
    assert.equal((await request(base, '/elvanto/filter-upgrades/apply-compatible', { method: 'POST', body: { upgrades: [{ batchId: '1e0', upgradeToken: 'x' }] } })).status, 400);
    const response = await request(base, '/elvanto/sync-batches/1/filter-draft', { method: 'PUT', body: { filterConfig: filter, broadMatchAcknowledged: true } });
    assert.equal(response.status, 404);
    assert.equal(JSON.stringify(response.body).includes('secret'), false);
  });
});
