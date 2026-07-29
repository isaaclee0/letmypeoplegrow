'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { createSourceBuilderRouter, createSourceBuilderJsonParser } = require('./sourceBuilder');

const ADMIN = { id: 1, church_id: 'churcha1', role: 'admin' };
const NON_ADMIN = { id: 2, church_id: 'churcha1', role: 'attendance_taker' };
const source = { kind: 'planning_center_list', externalId: 'list-1', name: 'Sunday people', memberCount: 17, providerRefreshedAt: '2026-07-29T00:00:00.000Z' };

function buildServer(overrides = {}, user = ADMIN) {
  const app = express();
  app.use((req, res, next) => { if (user) req.user = user; next(); });
  app.use('/providers', createSourceBuilderRouter(overrides));
  return http.createServer(app);
}

async function withServer(overrides, user, run) {
  const server = buildServer(overrides, user);
  await new Promise((resolve) => server.listen(0, resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}/providers`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() };
}

function deps(extra = {}) {
  return {
    listSources: async () => [source, { ...source, credentials: 'must not leak', rawRecords: [{ id: 'secret' }] }],
    resolveVisibleSource: async () => source,
    getBatch: async () => ({ id: 8, provider: 'planning_center', source: null, draftSource: null, sourceRevision: 1, needsSourceReview: false, initialSourceReviewPending: false, credential: 'secret' }),
    saveSourceDraft: async () => ({ id: 8, provider: 'planning_center', source: null, draftSource: { kind: source.kind, externalId: source.externalId, name: source.name }, sourceRevision: 1, needsSourceReview: true, initialSourceReviewPending: false }),
    discardSourceDraft: async () => ({ id: 8, provider: 'planning_center', source: source, draftSource: null, sourceRevision: 2, needsSourceReview: false, initialSourceReviewPending: false }),
    ...extra,
  };
}

test('source routes require an admin and preserve church isolation', async () => {
  let called = false;
  await withServer(deps({ listSources: async () => { called = true; return []; } }), NON_ADMIN, async (base) => {
    const response = await request(`${base}/planning_center/sources`);
    assert.equal(response.status, 403);
  });
  assert.equal(called, false);

  await withServer(deps(), { ...ADMIN, church_id: 'not valid!' }, async (base) => {
    const response = await request(`${base}/planning_center/sources`);
    assert.equal(response.status, 401);
    assert.equal(response.body.code, 'INVALID_CHURCH_CONTEXT');
  });
});

test('GET sources forwards only the church/provider and returns safe source DTOs', async () => {
  const calls = [];
  await withServer(deps({ listSources: async (input) => { calls.push(input); return [{ ...source, credentials: 'secret', people: [{ name: 'Private' }] }]; } }), ADMIN, async (base) => {
    const response = await request(`${base}/planning_center/sources`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { success: true, sources: [source] });
    assert.equal(JSON.stringify(response.body).includes('secret'), false);
    assert.equal(JSON.stringify(response.body).includes('Private'), false);
  });
  assert.deepEqual(calls, [{ churchId: ADMIN.church_id, provider: 'planning_center' }]);
});

test('PUT source draft accepts only source identity, resolves its name server-side, and scopes the batch to the church/provider', async () => {
  const resolveCalls = [];
  const saveCalls = [];
  await withServer(deps({
    resolveVisibleSource: async (input) => { resolveCalls.push(input); return source; },
    saveSourceDraft: async (input) => { saveCalls.push(input); return { id: 8, provider: 'planning_center', source: null, draftSource: { kind: source.kind, externalId: source.externalId, name: source.name }, sourceRevision: 1, needsSourceReview: true, initialSourceReviewPending: true }; },
  }), ADMIN, async (base) => {
    const response = await request(`${base}/planning_center/sync-batches/8/source-draft`, {
      method: 'PUT', body: { sourceKind: source.kind, sourceExternalId: source.externalId },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.batch.draftSource.name, 'Sunday people');
    assert.equal(JSON.stringify(response.body).includes('credential'), false);
  });
  assert.deepEqual(resolveCalls, [{ churchId: ADMIN.church_id, provider: 'planning_center', sourceKind: source.kind, sourceExternalId: source.externalId }]);
  assert.deepEqual(saveCalls, [{ churchId: ADMIN.church_id, provider: 'planning_center', batchId: 8, source: { kind: source.kind, externalId: source.externalId, name: source.name } }]);
});

test('source draft routes reject invalid provider/id/body, source-kind mismatches, and cross-church batches', async () => {
  await withServer(deps({ getBatch: async () => null }), ADMIN, async (base) => {
    const cases = [
      [`${base}/unknown/sources`, 'GET', undefined, 404],
      [`${base}/planning_center/sync-batches/nope/source-draft`, 'PUT', { sourceKind: source.kind, sourceExternalId: source.externalId }, 400],
      [`${base}/planning_center/sync-batches/8/source-draft`, 'PUT', { sourceKind: source.kind, sourceExternalId: source.externalId, name: 'client name' }, 400],
      [`${base}/planning_center/sync-batches/8/source-draft`, 'PUT', { sourceKind: 'elvanto_group', sourceExternalId: source.externalId }, 400],
      [`${base}/planning_center/sync-batches/8/source-draft`, 'DELETE', undefined, 404],
    ];
    for (const [url, method, body, wanted] of cases) {
      const response = await request(url, { method, body });
      assert.equal(response.status, wanted, url);
      assert.equal(/secret|rawRecords|people/.test(JSON.stringify(response.body)), false);
    }
  });
});

test('DELETE source draft refuses an initial review and discards a normal draft', async () => {
  const initial = Object.assign(new Error('provider details secret'), { code: 'SYNC_SOURCE_INITIAL_REVIEW_REQUIRED' });
  await withServer(deps({ discardSourceDraft: async () => { throw initial; } }), ADMIN, async (base) => {
    const response = await request(`${base}/planning_center/sync-batches/8/source-draft`, { method: 'DELETE' });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'SYNC_SOURCE_INITIAL_REVIEW_REQUIRED');
    assert.equal(JSON.stringify(response.body).includes('secret'), false);
  });
});

test('the source parser wins over a broader app parser and returns the source-specific body-limit response', async () => {
  const app = express();
  app.use('/providers', createSourceBuilderJsonParser());
  app.use(express.json({ limit: '10mb' }));
  app.use((req, res, next) => { req.user = ADMIN; next(); });
  app.use('/providers', createSourceBuilderRouter(deps()));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/providers/planning_center/sync-batches/8/source-draft`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceKind: 'planning_center_list', sourceExternalId: 'x'.repeat(20 * 1024) }),
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: 'Invalid sync source request.', code: 'SYNC_SOURCE_INVALID' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
