'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { createElvantoRouter } = require('./elvanto');

const ADMIN = { id: 1, church_id: 'churcha1', role: 'admin' };

function buildServer(overrides = {}, user = ADMIN) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/elvanto', createElvantoRouter({
    getOrMigrateCredentials: async () => null,
    getCredentials: async () => null,
    getConnection: async () => null,
    upsertConnection: async () => null,
    disconnectConnection: async () => true,
    markValidated: async () => null,
    deleteLegacyPreferences: async () => {},
    getAuthority: async () => ({ active: 'none', pending: null }),
    disableAuthority: async () => ({ active: 'none', pending: null }),
    listBatches: async () => [], getBatch: async () => null,
    createBatch: async (input) => ({ id: 1, ...input }),
    updateBatch: async (input) => ({ id: input.batchId, ...input }),
    deleteBatch: async () => true,
    resolveVisibleSource: async () => ({ kind: 'elvanto_category', externalId: 'cat-1', name: 'Members' }),
    buildReview: async () => ({ runId: 1, reviewToken: 'tok', summary: {}, plan: {} }),
    applyReviewed: async () => ({ runId: 1, status: 'applied', applied: {}, summary: {} }),
    adapter: { validateConnection: async () => ({ ok: true, metadata: {} }) },
    ...overrides,
  }));
  return http.createServer(app);
}

async function withServer(overrides, callback) {
  const server = buildServer(overrides);
  await new Promise((resolve) => server.listen(0, resolve));
  try { return await callback(`http://127.0.0.1:${server.address().port}/elvanto`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function request(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test('batch creation requires one Elvanto Category or Group source', async () => {
  await withServer({}, async (base) => {
    const invalid = await request(`${base}/sync-batches`, { name: 'Members' });
    assert.equal(invalid.status, 400);
    const valid = await request(`${base}/sync-batches`, {
      name: 'Members', sourceKind: 'elvanto_category', sourceExternalId: 'cat-1',
      defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
      scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1,
    });
    assert.equal(valid.status, 200);
    assert.deepEqual(valid.body.batch.initialDraftSource, { kind: 'elvanto_category', externalId: 'cat-1', name: 'Members' });
  });
});

test('batch creation rejects unknown local-rule fields', async () => {
  await withServer({}, async (base) => {
    const response = await request(`${base}/sync-batches`, { name: 'Members', localRule: {} });
    assert.equal(response.status, 400);
  });
});
