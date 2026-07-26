'use strict';

// Route-level tests for /elvanto/* — a small Express harness with every
// service dependency injected (no real database, no real Elvanto adapter,
// no real network call: see createElvantoRouter's `overrides` parameter).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { createElvantoRouter } = require('./elvanto');
const { OrchestratorError } = require('../../services/peopleSync/orchestrator');
const { ElvantoError } = require('../../services/elvanto/httpClient');
const { ElvantoReconnectRequiredError } = require('../../services/elvanto/legacyCredential');

const ADMIN_USER = { id: 1, church_id: 'churcha1', role: 'admin' };
const OTHER_CHURCH_ADMIN = { id: 2, church_id: 'churchb2', role: 'admin' };
const NON_ADMIN_USER = { id: 3, church_id: 'churcha1', role: 'attendance_taker' };

function buildServer(overrides, { user = ADMIN_USER } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/elvanto', createElvantoRouter(overrides));
  return http.createServer(app);
}

async function withServer(overrides, options, callback) {
  const server = buildServer(overrides, options);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    return await callback(`http://127.0.0.1:${port}/elvanto`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  let body = null;
  try { body = await res.json(); } catch (_) { body = null; }
  return { status: res.status, body };
}

function noopDeps(extra = {}) {
  return {
    getOrMigrateCredentials: async () => null,
    getCredentials: async () => null,
    getConnection: async () => null,
    upsertConnection: async () => null,
    disconnectConnection: async () => true,
    markValidated: async () => null,
    deleteLegacyPreferences: async () => {},
    getAuthority: async () => ({ active: 'none', pending: null }),
    disableAuthority: async () => ({ active: 'none', pending: null }),
    listBatches: async () => [],
    getBatch: async () => null,
    createBatch: async (input) => ({ id: 1, ...input }),
    updateBatch: async (input) => ({ id: input.batchId, ...input }),
    deleteBatch: async () => true,
    recordBatchResult: async () => {},
    buildReview: async () => ({ runId: 1, reviewToken: 'tok', summary: {}, plan: {} }),
    applyReviewed: async () => ({ runId: 1, status: 'applied', applied: {}, summary: {} }),
    runUnattended: async () => ({ runId: 1, status: 'applied', counts: {}, fetchMode: 'full', complete: true, externalWatermark: 'wm-1' }),
    adapter: {
      validateConnection: async () => ({ ok: true, metadata: {} }),
      fetchSnapshot: async () => ({ people: [], families: [], skipped: [] }),
      fetchMetadata: async () => ({ fetchedAt: 'now', categories: [], groups: [], demographics: [], departments: [], serviceTypes: [], locations: [], customFields: [] }),
      validateFilter: () => ({ ok: true, value: { statuses: ['active'], categoryIds: [], groups: { ids: [], operator: 'any' }, demographics: { values: [], operator: 'any' }, departments: { values: [], operator: 'any' }, serviceTypes: { ids: [], operator: 'any' }, locations: { ids: [], operator: 'any' }, customFields: [] }, errors: [] }),
      isEligible: () => true,
    },
    ...extra,
  };
}

// ─── Admin-only access ───────────────────────────────────────────────────────

test('GET /status rejects a non-admin user with 403 and never calls the dependency', async () => {
  let called = false;
  await withServer(noopDeps({ getOrMigrateCredentials: async () => { called = true; return null; } }),
    { user: NON_ADMIN_USER }, async (base) => {
      const { status, body } = await requestJson(`${base}/status`);
      assert.equal(status, 403);
      assert.equal(body.error, 'Insufficient permissions.');
    });
  assert.equal(called, false);
});

test('GET /status rejects a missing identity with 401', async () => {
  await withServer(noopDeps(), { user: null }, async (base) => {
    const { status } = await requestJson(`${base}/status`);
    assert.equal(status, 401);
  });
});

for (const [method, path] of [['get', '/sync-batches'], ['post', '/sync-batches'], ['post', '/connect'], ['post', '/disconnect']]) {
  test(`${method.toUpperCase()} ${path} rejects a non-admin user with 403`, async () => {
    await withServer(noopDeps(), { user: NON_ADMIN_USER }, async (base) => {
      const { status } = await requestJson(`${base}${path}`, { method: method.toUpperCase(), body: method === 'post' ? {} : undefined });
      assert.equal(status, 403);
    });
  });
}

// ─── Church ID forwarding ────────────────────────────────────────────────────

test('GET /status forwards the requesting admin\'s own church_id', async () => {
  const seen = [];
  await withServer(noopDeps({ getOrMigrateCredentials: async (churchId) => { seen.push(churchId); return null; } }),
    { user: OTHER_CHURCH_ADMIN }, async (base) => {
      const { status, body } = await requestJson(`${base}/status`);
      assert.equal(status, 200);
      assert.equal(body.configured, false);
    });
  assert.deepEqual(seen, [OTHER_CHURCH_ADMIN.church_id]);
});

test('POST /connect forwards church_id and connectedBy=user id, never a hardcoded value', async () => {
  const calls = [];
  await withServer(noopDeps({
    upsertConnection: async (args) => { calls.push(args); return null; },
    getConnection: async () => ({ provider: 'elvanto', connectionStatus: 'connected', metadata: {} }),
  }), { user: OTHER_CHURCH_ADMIN }, async (base) => {
    const { status } = await requestJson(`${base}/connect`, { method: 'POST', body: { apiKey: 'k-1' } });
    assert.equal(status, 200);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].churchId, OTHER_CHURCH_ADMIN.church_id);
  assert.equal(calls[0].connectedBy, OTHER_CHURCH_ADMIN.id);
});

test('GET /sync-batches forwards church_id and the elvanto provider', async () => {
  const calls = [];
  await withServer(noopDeps({ listBatches: async (churchId, provider) => { calls.push({ churchId, provider }); return []; } }),
    { user: OTHER_CHURCH_ADMIN }, async (base) => {
      const { status } = await requestJson(`${base}/sync-batches`);
      assert.equal(status, 200);
    });
  assert.deepEqual(calls, [{ churchId: OTHER_CHURCH_ADMIN.church_id, provider: 'elvanto' }]);
});

test('GET /sync-batches/:id/plan forwards churchId, provider, batchId, and a manual trigger', async () => {
  const calls = [];
  await withServer(noopDeps({ buildReview: async (args) => { calls.push(args); return { runId: 1, reviewToken: 't', summary: {}, plan: {} }; } }),
    { user: OTHER_CHURCH_ADMIN }, async (base) => {
      const { status } = await requestJson(`${base}/sync-batches/42/plan`);
      assert.equal(status, 200);
    });
  assert.deepEqual(calls, [{ churchId: OTHER_CHURCH_ADMIN.church_id, provider: 'elvanto', batchId: 42, trigger: 'manual' }]);
});

test('POST /sync-batches/:id/apply forwards reviewToken, selections, and userId', async () => {
  const calls = [];
  await withServer(noopDeps({ applyReviewed: async (args) => { calls.push(args); return { runId: 1, status: 'applied', applied: {}, summary: {} }; } }),
    { user: ADMIN_USER }, async (base) => {
      const { status } = await requestJson(`${base}/sync-batches/7/apply`, {
        method: 'POST', body: { reviewToken: 'tok-x', selections: { skipExternalPersonIds: ['a'] } },
      });
      assert.equal(status, 200);
    });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].churchId, ADMIN_USER.church_id);
  assert.equal(calls[0].provider, 'elvanto');
  assert.equal(calls[0].batchId, 7);
  assert.equal(calls[0].reviewToken, 'tok-x');
  assert.deepEqual(calls[0].selections, { skipExternalPersonIds: ['a'] });
  assert.equal(calls[0].userId, ADMIN_USER.id);
});

test('POST /sync-batches/:id/run-now forwards churchId/provider/batchId and records the batch result', async () => {
  const runCalls = [];
  const recordCalls = [];
  await withServer(noopDeps({
    runUnattended: async (args) => { runCalls.push(args); return { runId: 5, status: 'applied', counts: {}, fetchMode: 'incremental', complete: true, externalWatermark: 'wm-9' }; },
    recordBatchResult: async (args) => { recordCalls.push(args); },
  }), { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/sync-batches/3/run-now`, { method: 'POST' });
    assert.equal(status, 200);
    assert.equal(body.status, 'applied');
  });
  assert.deepEqual(runCalls, [{ churchId: ADMIN_USER.church_id, provider: 'elvanto', batchId: 3, trigger: 'run_now' }]);
  assert.deepEqual(recordCalls, [{
    churchId: ADMIN_USER.church_id, provider: 'elvanto', batchId: 3, trigger: 'run_now',
    fetchMode: 'incremental', complete: true, status: 'applied', externalWatermark: 'wm-9',
  }]);
});

test('POST /sync-batches/:id/run-now still returns success if recording the batch result fails', async () => {
  await withServer(noopDeps({
    runUnattended: async () => ({ runId: 5, status: 'applied', counts: {}, fetchMode: 'full', complete: true, externalWatermark: 'wm' }),
    recordBatchResult: async () => { throw new Error('db is briefly unavailable'); },
  }), { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/sync-batches/3/run-now`, { method: 'POST' });
    assert.equal(status, 200);
    assert.equal(body.status, 'applied');
  });
});

// ─── run-now never bypasses review ──────────────────────────────────────────

test('run-now faithfully forwards a review_required outcome with pending counts rather than forcing applied', async () => {
  await withServer(noopDeps({
    runUnattended: async () => ({
      runId: 8, status: 'review_required',
      counts: { ambiguousPeople: 2, familyConflicts: 1, unmatchedLocalRegulars: 0, renameFamily: 0 },
      fetchMode: 'full', complete: true, externalWatermark: 'wm',
    }),
  }), { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/sync-batches/1/run-now`, { method: 'POST' });
    assert.equal(status, 200);
    assert.equal(body.status, 'review_required');
    assert.equal(body.counts.ambiguousPeople, 2);
  });
});

// ─── Request validation ──────────────────────────────────────────────────────

test('POST /connect rejects an empty API key with 400 and never calls validateConnection', async () => {
  let called = false;
  await withServer(noopDeps({ adapter: { validateConnection: async () => { called = true; return { ok: true, metadata: {} }; } } }),
    { user: ADMIN_USER }, async (base) => {
      const { status, body } = await requestJson(`${base}/connect`, { method: 'POST', body: { apiKey: '   ' } });
      assert.equal(status, 400);
      assert.match(body.error, /API key is required/i);
    });
  assert.equal(called, false);
});

test('POST /sync-batches rejects a missing name', async () => {
  await withServer(noopDeps(), { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/sync-batches`, { method: 'POST', body: {} });
    assert.equal(status, 400);
    assert.match(body.error, /batch name is required/i);
  });
});

test('POST /sync-batches rejects an unknown field', async () => {
  await withServer(noopDeps(), { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/sync-batches`, { method: 'POST', body: { name: 'X', legacyProviderBatchId: 5 } });
    assert.equal(status, 400);
    assert.match(body.error, /unknown batch field/i);
  });
});

test('POST /sync-batches rejects a filter the adapter considers invalid, before any repository write', async () => {
  let createCalled = false;
  await withServer(noopDeps({
    createBatch: async () => { createCalled = true; return {}; },
    adapter: { validateFilter: () => ({ ok: false, value: null, errors: ['statuses must be a non-empty array of strings.'] }) },
  }), { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/sync-batches`, { method: 'POST', body: { name: 'X', filterConfig: {} } });
    assert.equal(status, 400);
    assert.match(body.error, /invalid elvanto filter/i);
    assert.deepEqual(body.errors, ['statuses must be a non-empty array of strings.']);
  });
  assert.equal(createCalled, false);
});

test('PUT /sync-batches/:id accepts a partial patch without requiring name', async () => {
  const calls = [];
  await withServer(noopDeps({
    getBatch: async () => ({ id: 9, filterSchemaVersion: 1, filterConfig: {} }),
    updateBatch: async (args) => { calls.push(args); return { id: 9, enabled: false }; },
  }), { user: ADMIN_USER }, async (base) => {
    const { status } = await requestJson(`${base}/sync-batches/9`, { method: 'PUT', body: { enabled: false } });
    assert.equal(status, 200);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].enabled, false);
  assert.equal('name' in calls[0], false);
});

test('PUT /sync-batches/:id only re-validates the filter when filterConfig is actually supplied', async () => {
  let validateFilterCalled = false;
  await withServer(noopDeps({
    getBatch: async () => ({ id: 9, filterSchemaVersion: 1, filterConfig: { statuses: ['active'] } }),
    updateBatch: async (args) => ({ id: 9, ...args }),
    adapter: { validateFilter: () => { validateFilterCalled = true; return { ok: true, value: {}, errors: [] }; } },
  }), { user: ADMIN_USER }, async (base) => {
    const { status } = await requestJson(`${base}/sync-batches/9`, { method: 'PUT', body: { scheduleDay: 2 } });
    assert.equal(status, 200);
  });
  assert.equal(validateFilterCalled, false);
});

test('PUT /sync-batches/:id returns 404 for a batch that does not exist for this church', async () => {
  await withServer(noopDeps({ getBatch: async () => null }), { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/sync-batches/999`, { method: 'PUT', body: { enabled: true } });
    assert.equal(status, 404);
    assert.match(body.error, /not found/i);
  });
});

test('DELETE /sync-batches/:id returns 404 for a batch that does not exist for this church', async () => {
  await withServer(noopDeps({ getBatch: async () => null }), { user: ADMIN_USER }, async (base) => {
    const { status } = await requestJson(`${base}/sync-batches/999`, { method: 'DELETE' });
    assert.equal(status, 404);
  });
});

for (const path of ['/sync-batches/abc/plan', '/sync-batches/-1/apply', '/sync-batches/0/run-now']) {
  test(`an invalid batch id in ${path} is rejected with 400 before touching any dependency`, async () => {
    const isGet = path.endsWith('plan');
    await withServer(noopDeps(), { user: ADMIN_USER }, async (base) => {
      const { status, body } = await requestJson(`${base}${path}`, isGet ? { method: 'GET' } : { method: 'POST', body: {} });
      assert.equal(status, 400);
      assert.match(body.error, /invalid batch id/i);
    });
  });
}

// ─── Validate-before-replace ─────────────────────────────────────────────────

test('POST /connect never touches the existing connection when validateConnection fails', async () => {
  let upsertCalled = false;
  await withServer(noopDeps({
    adapter: { validateConnection: async () => { const err = new ElvantoError('bad key', 'ELVANTO_AUTH', {}); throw err; } },
    upsertConnection: async () => { upsertCalled = true; },
  }), { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/connect`, { method: 'POST', body: { apiKey: 'bad-key' } });
    assert.equal(status, 400);
    assert.equal(body.code, 'ELVANTO_AUTH');
  });
  assert.equal(upsertCalled, false);
});

// ─── Disconnect: authority release before credential deletion ──────────────

test('disconnecting an authoritative Elvanto connection calls disableAuthority before deleting credentials', async () => {
  const order = [];
  await withServer(noopDeps({
    getAuthority: async () => ({ active: 'elvanto', pending: null }),
    disableAuthority: async () => { order.push('disableAuthority'); return { active: 'none', pending: null }; },
    disconnectConnection: async () => { order.push('disconnectConnection'); return true; },
  }), { user: ADMIN_USER }, async (base) => {
    const { status } = await requestJson(`${base}/disconnect`, { method: 'POST' });
    assert.equal(status, 200);
  });
  assert.deepEqual(order, ['disableAuthority', 'disconnectConnection']);
});

test('disconnecting a non-authoritative Elvanto connection does not call disableAuthority', async () => {
  let called = false;
  await withServer(noopDeps({
    getAuthority: async () => ({ active: 'planning_center', pending: null }),
    disableAuthority: async () => { called = true; },
  }), { user: ADMIN_USER }, async (base) => {
    const { status } = await requestJson(`${base}/disconnect`, { method: 'POST' });
    assert.equal(status, 200);
  });
  assert.equal(called, false);
});

test('disconnect also clears any legacy per-admin API key rows (belt-and-suspenders)', async () => {
  let called = false;
  await withServer(noopDeps({ deleteLegacyPreferences: async () => { called = true; } }), { user: ADMIN_USER }, async (base) => {
    await requestJson(`${base}/disconnect`, { method: 'POST' });
  });
  assert.equal(called, true);
});

// ─── Metadata caching ────────────────────────────────────────────────────────

test('GET /metadata serves the persisted cache without a live fetch when one exists', async () => {
  let fetchSnapshotCalled = false;
  await withServer(noopDeps({
    getCredentials: async () => ({ apiKey: 'k' }),
    getConnection: async () => ({ metadata: { syncMetadata: { fetchedAt: 'cached', categories: [] } }, metadataCachedAt: 'cached-at' }),
    adapter: { fetchSnapshot: async () => { fetchSnapshotCalled = true; return { people: [] }; }, fetchMetadata: async () => ({}) },
  }), { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/metadata`);
    assert.equal(status, 200);
    assert.equal(body.cached, true);
    assert.deepEqual(body.metadata, { fetchedAt: 'cached', categories: [] });
  });
  assert.equal(fetchSnapshotCalled, false);
});

test('GET /metadata falls back to a live fetch when nothing has been cached yet', async () => {
  let fetchSnapshotCalled = false;
  await withServer(noopDeps({
    getCredentials: async () => ({ apiKey: 'k' }),
    getConnection: async () => ({ metadata: {} }),
    adapter: {
      fetchSnapshot: async () => { fetchSnapshotCalled = true; return { people: [] }; },
      fetchMetadata: async () => ({ fetchedAt: 'live', categories: [] }),
    },
  }), { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/metadata`);
    assert.equal(status, 200);
    assert.equal(body.cached, false);
    assert.deepEqual(body.metadata, { fetchedAt: 'live', categories: [] });
  });
  assert.equal(fetchSnapshotCalled, true);
});

test('POST /metadata/refresh always performs a live fetch, even when a cache exists', async () => {
  let fetchSnapshotCalled = false;
  await withServer(noopDeps({
    getCredentials: async () => ({ apiKey: 'k' }),
    getConnection: async () => ({ metadata: { syncMetadata: { fetchedAt: 'cached' } } }),
    adapter: {
      fetchSnapshot: async () => { fetchSnapshotCalled = true; return { people: [] }; },
      fetchMetadata: async () => ({ fetchedAt: 'refreshed' }),
    },
  }), { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/metadata/refresh`, { method: 'POST' });
    assert.equal(status, 200);
    assert.deepEqual(body.metadata, { fetchedAt: 'refreshed' });
  });
  assert.equal(fetchSnapshotCalled, true);
});

test('GET /metadata returns 400 when Elvanto is not connected', async () => {
  await withServer(noopDeps({ getCredentials: async () => null }), { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/metadata`);
    assert.equal(status, 400);
    assert.match(body.error, /not connected/i);
  });
});

// ─── Safe error mapping ──────────────────────────────────────────────────────

test('a stored-key ELVANTO_AUTH failure on /status is reported as invalid, not a raw 401 crash', async () => {
  await withServer(noopDeps({
    getOrMigrateCredentials: async () => ({ apiKey: 'stale' }),
    adapter: { validateConnection: async () => { throw new ElvantoError('rejected', 'ELVANTO_AUTH', {}); } },
  }), { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/status`);
    assert.equal(status, 200);
    assert.equal(body.connected, false);
    assert.match(body.error, /invalid or expired/i);
  });
});

test('a stored-key ELVANTO_AUTH failure on a batch plan fetch maps to 401 (reconnect required)', async () => {
  await withServer(noopDeps({
    buildReview: async () => { throw new ElvantoError('rejected', 'ELVANTO_AUTH', {}); },
  }), { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/sync-batches/1/plan`);
    assert.equal(status, 401);
    assert.equal(body.code, 'ELVANTO_AUTH');
  });
});

test('a submitted replacement key failing on /connect maps to 400, not 401', async () => {
  await withServer(noopDeps({
    adapter: { validateConnection: async () => { throw new ElvantoError('rejected', 'ELVANTO_AUTH', {}); } },
  }), { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/connect`, { method: 'POST', body: { apiKey: 'bad' } });
    assert.equal(status, 400);
    assert.equal(body.code, 'ELVANTO_AUTH');
  });
});

test('ELVANTO_UNAVAILABLE (including a request timeout) maps to 503', async () => {
  await withServer(noopDeps({
    buildReview: async () => { throw new ElvantoError('Elvanto request timed out', 'ELVANTO_UNAVAILABLE', {}); },
  }), { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/sync-batches/1/plan`);
    assert.equal(status, 503);
    assert.equal(body.code, 'ELVANTO_UNAVAILABLE');
    assert.match(body.error, /unavailable/i);
  });
});

test('ELVANTO_RESPONSE and ELVANTO_PAGINATION map to 502', async () => {
  for (const code of ['ELVANTO_RESPONSE', 'ELVANTO_PAGINATION']) {
    await withServer(noopDeps({
      buildReview: async () => { throw new ElvantoError('malformed', code, {}); },
    }), { user: ADMIN_USER }, async (base) => {
      const { status, body } = await requestJson(`${base}/sync-batches/1/plan`);
      assert.equal(status, 502);
      assert.equal(body.code, code);
    });
  }
});

const ORCHESTRATOR_CODE_STATUS = [
  ['SYNC_NOT_CONNECTED', 400],
  ['SYNC_BATCH_NOT_FOUND', 404],
  ['SYNC_BATCH_DISABLED', 400],
  ['SYNC_BATCH_FILTER_INVALID', 400],
  ['SYNC_REVIEW_EXPIRED', 409],
  ['SYNC_PLAN_STALE', 409],
  ['SYNC_SELECTIONS_INVALID', 400],
  ['SYNC_AUTHORITY_MISMATCH', 409],
];

for (const [code, status] of ORCHESTRATOR_CODE_STATUS) {
  test(`OrchestratorError ${code} from applyReviewed maps to ${status} with a safe body`, async () => {
    await withServer(noopDeps({
      applyReviewed: async () => { throw new OrchestratorError(code, `safe message for ${code}`, status); },
    }), { user: ADMIN_USER }, async (base) => {
      const { status: httpStatus, body } = await requestJson(`${base}/sync-batches/1/apply`, { method: 'POST', body: { reviewToken: 't' } });
      assert.equal(httpStatus, status);
      assert.equal(body.code, code);
      assert.equal(body.error, `safe message for ${code}`);
    });
  });
}

test('ElvantoReconnectRequiredError on /status maps to a distinct, non-guessing 409-shaped response', async () => {
  await withServer(noopDeps({
    getOrMigrateCredentials: async () => { throw new ElvantoReconnectRequiredError('churcha1'); },
  }), { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/status`);
    // /status itself always responds 200 with a descriptive body (matching
    // the existing status-endpoint contract of never hard-failing the page
    // load) — but flags the ambiguity distinctly rather than reporting a
    // plain "disconnected".
    assert.equal(status, 200);
    assert.equal(body.connected, false);
    assert.equal(body.reconnectRequired, true);
  });
});

test('an unexpected (non-typed) failure never leaks its raw message to the client', async () => {
  await withServer(noopDeps({
    buildReview: async () => { throw new Error('internal detail: table people_sync_batches has no column named foo'); },
  }), { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/sync-batches/1/plan`);
    assert.equal(status, 500);
    assert.equal(body.error, 'An unexpected error occurred.');
    assert.equal(/people_sync_batches/.test(JSON.stringify(body)), false);
  });
});

// ─── No secrets in any response ─────────────────────────────────────────────

test('POST /connect never echoes the API key back, even partially', async () => {
  await withServer(noopDeps({
    upsertConnection: async () => null,
    getConnection: async () => ({ provider: 'elvanto', connectionStatus: 'connected', metadata: { connectionLabel: 'Connected via API key' } }),
  }), { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/connect`, { method: 'POST', body: { apiKey: 'super-secret-key-value' } });
    assert.equal(status, 200);
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('super-secret-key-value'), false);
    assert.equal(serialized.includes('super-secret'), false);
  });
});

test('GET /status never echoes the API key back, even partially', async () => {
  await withServer(noopDeps({
    getOrMigrateCredentials: async () => ({ apiKey: 'another-secret-value-123' }),
    getConnection: async () => ({ metadata: {} }),
  }), { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/status`);
    assert.equal(status, 200);
    assert.equal(JSON.stringify(body).includes('another-secret-value-123'), false);
  });
});
