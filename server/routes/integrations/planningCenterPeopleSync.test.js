'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { createPlanningCenterPeopleSyncRouter } = require('./planningCenterPeopleSync');
const { OrchestratorError } = require('../../services/peopleSync/orchestrator');

const ADMIN = { id: 9, church_id: 'pcoch1', role: 'admin' };

async function requestJson(url, { method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const responseBody = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, body: responseBody };
}

async function withServer(deps, fn, user = ADMIN) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(createPlanningCenterPeopleSyncRouter(deps));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('POST correction preview delegates the signed correction request in church scope', async () => {
  const calls = [];
  await withServer({
    previewLinkCorrections: async (args) => {
      calls.push(args);
      return { reviewToken: 'corrected-review', decisionContractVersion: 2, summary: {}, plan: {}, snapshot: {} };
    },
  }, async (base) => {
    const response = await requestJson(`${base}/sync-batches/12/preview-link-corrections`, {
      method: 'POST',
      body: {
        baseReviewToken: 'base-review',
        linkCorrections: { 'ext-a': { outcome: 'unlink', fromIndividualId: 10 } },
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.reviewToken, 'corrected-review');
  });
  assert.deepEqual(calls, [{
    churchId: ADMIN.church_id,
    provider: 'planning_center',
    batchId: 12,
    baseReviewToken: 'base-review',
    linkCorrections: { 'ext-a': { outcome: 'unlink', fromIndividualId: 10 } },
  }]);
});

test('POST correction preview rejects missing base tokens before orchestration', async () => {
  let calls = 0;
  await withServer({ previewLinkCorrections: async () => { calls += 1; return {}; } }, async (base) => {
    const response = await requestJson(`${base}/sync-batches/12/preview-link-corrections`, {
      method: 'POST', body: { linkCorrections: {} },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'SYNC_REVIEW_TOKEN_REQUIRED');
  });
  assert.equal(calls, 0);
});

test('POST correction preview rejects non-object corrections before orchestration', async () => {
  let calls = 0;
  await withServer({ previewLinkCorrections: async () => { calls += 1; return {}; } }, async (base) => {
    for (const linkCorrections of [null, [], 'unlink']) {
      const response = await requestJson(`${base}/sync-batches/12/preview-link-corrections`, {
        method: 'POST', body: { baseReviewToken: 'base-review', linkCorrections },
      });
      assert.equal(response.status, 400);
      assert.equal(response.body.code, 'SYNC_SELECTIONS_INVALID');
    }
  });
  assert.equal(calls, 0);
});

test('POST correction preview rejects unsafe batch identifiers before orchestration', async () => {
  let calls = 0;
  await withServer({ previewLinkCorrections: async () => { calls += 1; return {}; } }, async (base) => {
    for (const id of ['0', '-1', '1.5', '9007199254740992', '1e309']) {
      const response = await requestJson(`${base}/sync-batches/${id}/preview-link-corrections`, {
        method: 'POST', body: { baseReviewToken: 'base-review', linkCorrections: {} },
      });
      assert.equal(response.status, 400, id);
    }
  });
  assert.equal(calls, 0);
});

test('POST correction preview maps route timeouts like plan and apply', async () => {
  await withServer({
    previewLinkCorrections: async () => new Promise(() => {}),
    routeTimeoutMs: 5,
  }, async (base) => {
    const response = await requestJson(`${base}/sync-batches/12/preview-link-corrections`, {
      method: 'POST', body: { baseReviewToken: 'base-review', linkCorrections: {} },
    });
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'SYNC_ROUTE_TIMEOUT');
  });
});

test('POST correction preview passes through orchestrator error status and code', async () => {
  await withServer({
    previewLinkCorrections: async () => {
      throw new OrchestratorError('SYNC_REVIEW_STALE', 'Review changed.', 409);
    },
  }, async (base) => {
    const response = await requestJson(`${base}/sync-batches/12/preview-link-corrections`, {
      method: 'POST', body: { baseReviewToken: 'base-review', linkCorrections: {} },
    });
    assert.deepEqual(response, {
      status: 409,
      body: { error: 'Review changed.', code: 'SYNC_REVIEW_STALE' },
    });
  });
});

test('POST correction preview remains protected by admin and church middleware', async () => {
  let calls = 0;
  const deps = { previewLinkCorrections: async () => { calls += 1; return {}; } };
  const sendPreview = async (base) => requestJson(`${base}/sync-batches/12/preview-link-corrections`, {
    method: 'POST', body: { baseReviewToken: 'base-review', linkCorrections: {} },
  });
  await withServer(deps, async (base) => {
    assert.equal((await sendPreview(base)).status, 403);
  }, { ...ADMIN, role: 'coordinator' });
  await withServer(deps, async (base) => {
    const response = await sendPreview(base);
    assert.equal(response.status, 401);
    assert.equal(response.body.code, 'MISSING_CHURCH_CONTEXT');
  }, { id: ADMIN.id, role: 'admin' });
  assert.equal(calls, 0);
});

test('GET batch plan passes the decision contract version through without applying', async () => {
  const calls = [];
  let applyCalls = 0;
  await withServer({
    buildReview: async (args) => {
      calls.push(args);
      return { runId: 4, reviewToken: 'pco-review', decisionContractVersion: 2, summary: {}, plan: {}, snapshot: {} };
    },
    applyReviewed: async () => { applyCalls++; },
  }, async (base) => {
    const response = await requestJson(`${base}/sync-batches/12/plan`);
    assert.equal(response.status, 200);
    assert.equal(response.body.reviewToken, 'pco-review');
    assert.equal(response.body.decisionContractVersion, 2);
  });
  assert.deepEqual(calls, [{ churchId: 'pcoch1', provider: 'planning_center', batchId: 12, trigger: 'manual' }]);
  assert.equal(applyCalls, 0);
});

test('POST batch apply rejects a direct blind apply and forwards legacy and v2 selections verbatim', async () => {
  const calls = [];
  await withServer({
    buildReview: async () => ({}),
    applyReviewed: async (args) => { calls.push(args); return { runId: 4, status: 'applied', applied: {}, summary: {} }; },
  }, async (base) => {
    const blind = await requestJson(`${base}/sync-batches/12/apply`, { method: 'POST', body: { selections: {} } });
    assert.equal(blind.status, 400);
    assert.equal(blind.body.code, 'SYNC_REVIEW_TOKEN_REQUIRED');
    assert.equal(calls.length, 0);

    const legacySelections = { skipExternalPersonIds: ['pco-1'] };
    const legacy = await requestJson(`${base}/sync-batches/12/apply`, {
      method: 'POST', body: { reviewToken: 'pco-review', selections: legacySelections },
    });
    assert.equal(legacy.status, 200);

    const v2Selections = {
      decisionContractVersion: 2,
      identityDecisions: { 'pco-1': { outcome: 'defer', excludeIndividualId: 12 } },
    };
    const reviewed = await requestJson(`${base}/sync-batches/12/apply`, {
      method: 'POST', body: { reviewToken: 'pco-review', selections: v2Selections },
    });
    assert.equal(reviewed.status, 200);
  });
  assert.deepEqual(calls, [
    {
      churchId: 'pcoch1', provider: 'planning_center', batchId: 12,
      reviewToken: 'pco-review', selections: { skipExternalPersonIds: ['pco-1'] }, userId: 9,
    },
    {
      churchId: 'pcoch1', provider: 'planning_center', batchId: 12,
      reviewToken: 'pco-review',
      selections: {
        decisionContractVersion: 2,
        identityDecisions: { 'pco-1': { outcome: 'defer', excludeIndividualId: 12 } },
      },
      userId: 9,
    },
  ]);
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
