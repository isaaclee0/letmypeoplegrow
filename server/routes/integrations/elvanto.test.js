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

async function request(url, body, method = 'POST') {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test('batch creation requires one Elvanto Category or Group source', async () => {
  let createInput;
  await withServer({
    createBatch: async (input) => {
      createInput = input;
      return { id: 1, ...input };
    },
  }, async (base) => {
    const invalid = await request(`${base}/sync-batches`, {});
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, 'An Elvanto source is required.');
    const valid = await request(`${base}/sync-batches`, {
      sourceKind: 'elvanto_category', sourceExternalId: 'cat-1',
      defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
      scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1,
    });
    assert.equal(valid.status, 200);
    assert.equal(createInput.name, 'Members');
    assert.deepEqual(createInput.initialDraftSource, { kind: 'elvanto_category', externalId: 'cat-1', name: 'Members' });
    assert.deepEqual(valid.body.batch.initialDraftSource, { kind: 'elvanto_category', externalId: 'cat-1', name: 'Members' });
  });
});

test('batch creation stores the trusted Elvanto Group name', async () => {
  let createInput;
  await withServer({
    resolveVisibleSource: async () => ({ kind: 'elvanto_group', externalId: 'group-2', name: 'Youth' }),
    createBatch: async (input) => {
      createInput = input;
      return { id: 1, ...input };
    },
  }, async (base) => {
    const response = await request(`${base}/sync-batches`, {
      sourceKind: 'elvanto_group', sourceExternalId: 'group-2',
    });

    assert.equal(response.status, 200);
    assert.equal(createInput.name, 'Youth');
    assert.deepEqual(createInput.initialDraftSource, {
      kind: 'elvanto_group', externalId: 'group-2', name: 'Youth',
    });
  });
});

test('batch creation rejects a client supplied name', async () => {
  await withServer({}, async (base) => {
    const response = await request(`${base}/sync-batches`, {
      name: 'Client name', sourceKind: 'elvanto_category', sourceExternalId: 'cat-1',
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'Unknown batch field: name');
  });
});

test('batch update rejects a client supplied name', async () => {
  await withServer({
    getBatch: async () => ({ id: 1, scheduleFrequency: 'weekly', scheduleDay: 1 }),
  }, async (base) => {
    const response = await request(`${base}/sync-batches/1`, { name: 'Client name' }, 'PUT');

    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'Unknown batch field: name');
  });
});

test('batch creation rejects unknown local-rule fields', async () => {
  await withServer({}, async (base) => {
    const response = await request(`${base}/sync-batches`, { localRule: {} });
    assert.equal(response.status, 400);
  });
});

test('batch plan passes the v2 decision contract and apply forwards legacy and v2 selections verbatim', async () => {
  const applyCalls = [];
  await withServer({
    buildReview: async () => ({ runId: 4, reviewToken: 'elvanto-review', decisionContractVersion: 2, summary: {}, plan: {} }),
    applyReviewed: async (input) => { applyCalls.push(input); return { runId: 4, status: 'applied', applied: {}, summary: {} }; },
  }, async (base) => {
    const plan = await request(`${base}/sync-batches/4/plan`, undefined, 'GET');
    assert.equal(plan.status, 200);
    assert.equal(plan.body.decisionContractVersion, 2);

    const legacy = await request(`${base}/sync-batches/4/apply`, {
      reviewToken: 'elvanto-review', selections: { skipExternalPersonIds: ['old-person'] },
    });
    assert.equal(legacy.status, 200);

    const v2 = await request(`${base}/sync-batches/4/apply`, {
      reviewToken: 'elvanto-review',
      selections: {
        decisionContractVersion: 2,
        identityDecisions: { 'external-person': { outcome: 'defer' } },
      },
    });
    assert.equal(v2.status, 200);
  });
  assert.deepEqual(applyCalls, [
    {
      churchId: 'churcha1', provider: 'elvanto', batchId: 4, reviewToken: 'elvanto-review',
      selections: { skipExternalPersonIds: ['old-person'] }, userId: 1,
    },
    {
      churchId: 'churcha1', provider: 'elvanto', batchId: 4, reviewToken: 'elvanto-review',
      selections: {
        decisionContractVersion: 2,
        identityDecisions: { 'external-person': { outcome: 'defer' } },
      },
      userId: 1,
    },
  ]);
});
