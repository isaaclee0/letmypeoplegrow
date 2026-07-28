'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { createPlanningCenterPeopleSyncRouter } = require('./planningCenterPeopleSync');

const ADMIN = { id: 9, church_id: 'pcoch1', role: 'admin' };

async function requestJson(url, { method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

async function withServer(deps, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = ADMIN; next(); });
  app.use(createPlanningCenterPeopleSyncRouter(deps));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET batch plan returns an orchestrator review token without applying', async () => {
  const calls = [];
  let applyCalls = 0;
  await withServer({
    buildReview: async (args) => { calls.push(args); return { runId: 4, reviewToken: 'pco-review', summary: {}, plan: {}, snapshot: {} }; },
    applyReviewed: async () => { applyCalls++; },
  }, async (base) => {
    const response = await requestJson(`${base}/sync-batches/12/plan`);
    assert.equal(response.status, 200);
    assert.equal(response.body.reviewToken, 'pco-review');
  });
  assert.deepEqual(calls, [{ churchId: 'pcoch1', provider: 'planning_center', batchId: 12, trigger: 'manual' }]);
  assert.equal(applyCalls, 0);
});

test('POST batch apply rejects a direct blind apply and forwards the reviewed token on approval', async () => {
  const calls = [];
  await withServer({
    buildReview: async () => ({}),
    applyReviewed: async (args) => { calls.push(args); return { runId: 4, status: 'applied', applied: {}, summary: {} }; },
  }, async (base) => {
    const blind = await requestJson(`${base}/sync-batches/12/apply`, { method: 'POST', body: { selections: {} } });
    assert.equal(blind.status, 400);
    assert.equal(blind.body.code, 'SYNC_REVIEW_TOKEN_REQUIRED');
    assert.equal(calls.length, 0);

    const reviewed = await requestJson(`${base}/sync-batches/12/apply`, {
      method: 'POST', body: { reviewToken: 'pco-review', selections: { skipExternalPersonIds: ['pco-1'] } },
    });
    assert.equal(reviewed.status, 200);
  });
  assert.deepEqual(calls, [{
    churchId: 'pcoch1', provider: 'planning_center', batchId: 12,
    reviewToken: 'pco-review', selections: { skipExternalPersonIds: ['pco-1'] }, userId: 9,
  }]);
});

test('plan and apply reject unsafe batch identifiers before invoking orchestration', async () => {
  let calls = 0;
  await withServer({
    buildReview: async () => { calls += 1; return {}; },
    applyReviewed: async () => { calls += 1; return {}; },
  }, async (base) => {
    for (const id of ['0', '-1', '1.5', '9007199254740992', '1e309']) {
      assert.equal((await requestJson(`${base}/sync-batches/${id}/plan`)).status, 400, id);
      assert.equal((await requestJson(`${base}/sync-batches/${id}/apply`, { method: 'POST', body: { reviewToken: 'token' } })).status, 400, id);
    }
  });
  assert.equal(calls, 0);
});
