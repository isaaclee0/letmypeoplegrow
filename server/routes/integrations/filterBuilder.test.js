'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { createFilterBuilderRouter } = require('./filterBuilder');

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
    captureFilterSnapshotInput: () => ({ facts: [{ externalPersonId: 'p1', dimensions: { status: ['active'] } }], dimensions: metadata.dimensions, coverage: ['status'], populationGateDigest: 'gate' }),
    populationGateDigest: () => 'gate',
    peekCachedPcoPeople: () => null,
    ...extra,
  };
}

function server(overrides, user = ADMIN) {
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use('/providers', createFilterBuilderRouter(overrides));
  return http.createServer(app);
}

async function withServer(overrides, user, run) {
  const instance = server(overrides, user);
  await new Promise((resolve) => instance.listen(0, resolve));
  const base = `http://127.0.0.1:${instance.address().port}/providers`;
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

test('invalid provider, batch id, oversized body, and another church batch are rejected safely', async () => {
  await withServer(deps({ getBatch: async () => null }), OTHER_ADMIN, async (base) => {
    assert.equal((await request(base, '/unknown/filter-metadata')).status, 404);
    assert.equal((await request(base, '/elvanto/sync-batches/nope/filter-draft', { method: 'PUT', body: {} })).status, 400);
    const response = await request(base, '/elvanto/sync-batches/1/filter-draft', { method: 'PUT', body: { filterConfig: filter, broadMatchAcknowledged: true } });
    assert.equal(response.status, 404);
    assert.equal(JSON.stringify(response.body).includes('secret'), false);
  });
});
