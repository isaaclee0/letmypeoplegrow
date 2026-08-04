'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const cookieParser = require('cookie-parser');
const {
  createPeopleImportsRouter,
  createPeopleImportsJsonParser,
  createPeopleImportsRequestBoundary,
  MAX_BODY_BYTES,
} = require('./people-imports');

const ADMIN = { id: 7, church_id: 'churcha1', role: 'admin' };
const NON_ADMIN = { id: 8, church_id: 'churcha1', role: 'attendance_taker' };

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function verifyAs(user) {
  return (req, res, next) => {
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    req.user = user;
    return next();
  };
}

function dependencies(extra = {}) {
  return {
    verifyToken: verifyAs(ADMIN),
    listSources: async () => [],
    previewImport: async () => ({
      runId: 1,
      operationKind: 'people_import',
      selection: { kind: 'all' },
      reviewToken: 'review-token',
      decisionContractVersion: 2,
      summary: {},
      coverage: {},
      plan: {},
      snapshot: { fetchedAt: '2026-08-04T00:00:00.000Z', mode: 'full' },
    }),
    applyImport: async () => ({ runId: 2, status: 'applied', applied: {}, summary: {} }),
    ...extra,
  };
}

function buildServer(overrides = {}, { preparse = false } = {}) {
  const app = express();
  if (preparse) {
    app.use('/people-imports', createPeopleImportsJsonParser());
    app.use(express.json({ limit: '10mb' }));
  }
  app.use('/people-imports', createPeopleImportsRouter(overrides));
  return http.createServer(app);
}

function buildProductionOrderServer(overrides = {}) {
  const app = express();
  app.use(cookieParser());
  app.use('/people-imports', createPeopleImportsRequestBoundary(overrides));
  app.use(express.json({ limit: '10mb' }));
  app.use('/people-imports', createPeopleImportsRouter(overrides));
  return http.createServer(app);
}

async function withServer(overrides, options, run) {
  const server = buildServer(overrides, options);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}/people-imports`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withProductionOrderServer(overrides, run) {
  const server = buildProductionOrderServer(overrides);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}/people-imports`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() };
}

test('all routes require authentication, church isolation, and the admin role before provider work', async () => {
  let providerCalls = 0;
  const counted = async () => { providerCalls += 1; return []; };

  await withServer(dependencies({ verifyToken: verifyAs(null), listSources: counted }), {}, async (base) => {
    assert.equal((await requestJson(`${base}/planning_center/sources`)).status, 401);
  });
  await withServer(dependencies({ verifyToken: verifyAs(NON_ADMIN), listSources: counted }), {}, async (base) => {
    assert.equal((await requestJson(`${base}/planning_center/sources`)).status, 403);
  });
  await withServer(dependencies({
    verifyToken: verifyAs({ ...ADMIN, church_id: 'not valid!' }),
    listSources: counted,
  }), {}, async (base) => {
    const response = await requestJson(`${base}/planning_center/sources`);
    assert.equal(response.status, 401);
    assert.equal(response.body.code, 'INVALID_CHURCH_CONTEXT');
  });

  assert.equal(providerCalls, 0);
});

test('production mount authenticates from cookies before narrow parsing without running auth twice', async () => {
  let authenticationChecks = 0;
  let isolationChecks = 0;
  let adminChecks = 0;
  let providerCalls = 0;
  const overrides = dependencies({
    verifyToken(req, res, next) {
      authenticationChecks += 1;
      if (req.cookies.authToken !== 'admin-cookie') {
        return res.status(401).json({ error: 'Authentication required.' });
      }
      req.user = ADMIN;
      return next();
    },
    ensureChurchIsolation(req, _res, next) {
      isolationChecks += 1;
      req.churchId = req.user.church_id;
      next();
    },
    requireAdmin(req, res, next) {
      adminChecks += 1;
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Insufficient permissions.' });
      return next();
    },
    previewImport: async () => { providerCalls += 1; return {}; },
  });

  await withProductionOrderServer(overrides, async (base) => {
    for (const body of ['{"selection":', JSON.stringify({
      selection: { kind: 'elvanto_group', externalId: 'x'.repeat(MAX_BODY_BYTES) },
    })]) {
      const response = await fetch(`${base}/elvanto/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'Authentication required.' });
    }

    const malformed = await fetch(`${base}/elvanto/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'authToken=admin-cookie' },
      body: '{"selection":',
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), {
      error: 'Invalid people import request.', code: 'PEOPLE_IMPORT_REQUEST_INVALID',
    });

    const oversized = await fetch(`${base}/elvanto/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'authToken=admin-cookie' },
      body: JSON.stringify({
        selection: { kind: 'elvanto_group', externalId: 'x'.repeat(MAX_BODY_BYTES) },
      }),
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), {
      error: 'Invalid people import request.', code: 'PEOPLE_IMPORT_REQUEST_INVALID',
    });

    const valid = await fetch(`${base}/elvanto/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'authToken=admin-cookie' },
      body: JSON.stringify({ selection: { kind: 'all' } }),
    });
    assert.equal(valid.status, 200);
  });

  assert.equal(authenticationChecks, 5);
  assert.equal(isolationChecks, 3);
  assert.equal(adminChecks, 3);
  assert.equal(providerCalls, 1);
});

test('GET sources forwards verified church/provider context and exposes only safe source fields', async () => {
  const sourceCalls = [];
  const user = { ...ADMIN, church_id: 'church-a' };
  await withServer(dependencies({
    verifyToken: verifyAs(user),
    ensureChurchIsolation(req, _res, next) { req.churchId = req.user.church_id; next(); },
    async listSources(input) {
      sourceCalls.push(input);
      return [{
        kind: 'planning_center_list', externalId: '42', name: 'Members', memberCount: 19,
        providerRefreshedAt: '2026-08-01T00:00:00.000Z',
        credentials: { accessToken: 'credential-secret' }, people: [{ name: 'Private Person' }],
      }];
    },
  }), {}, async (base) => {
    const response = await requestJson(`${base}/planning_center/sources`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      success: true,
      sources: [{
        kind: 'planning_center_list', externalId: '42', name: 'Members', memberCount: 19,
        providerRefreshedAt: '2026-08-01T00:00:00.000Z',
      }],
      allOption: { kind: 'all', name: 'Everyone' },
    });
    assert.equal(/credential-secret|Private Person/.test(JSON.stringify(response.body)), false);
  });

  assert.equal(sourceCalls.length, 1);
  assert.equal(sourceCalls[0].churchId, 'church-a');
  assert.equal(sourceCalls[0].provider, 'planning_center');
  assert.ok(sourceCalls[0].signal instanceof AbortSignal);
});

test('POST preview validates then forwards the exact provider selection with an abort signal', async () => {
  const previewCalls = [];
  const review = {
    runId: 4,
    operationKind: 'people_import',
    selection: { kind: 'planning_center_list', externalId: '42' },
    reviewToken: 'review-token',
    decisionContractVersion: 2,
    summary: {}, coverage: {}, plan: {}, snapshot: { fetchedAt: '2026-08-04T00:00:00.000Z', mode: 'full' },
  };
  await withServer(dependencies({
    verifyToken: verifyAs({ ...ADMIN, church_id: 'church-a' }),
    ensureChurchIsolation(req, _res, next) { req.churchId = req.user.church_id; next(); },
    async previewImport(input) { previewCalls.push(input); return review; },
  }), {}, async (base) => {
    const response = await requestJson(`${base}/planning_center/preview`, {
      method: 'POST', body: { selection: { kind: 'planning_center_list', externalId: '42' } },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, review);
  });

  assert.equal(previewCalls[0].churchId, 'church-a');
  assert.equal(previewCalls[0].provider, 'planning_center');
  assert.deepEqual(previewCalls[0].selection, {
    kind: 'planning_center_list', externalId: '42',
  });
  assert.ok(previewCalls[0].signal instanceof AbortSignal);
});

test('POST apply forwards only reviewed import inputs and the verified user identity', async () => {
  const applyCalls = [];
  const applied = { runId: 5, status: 'applied', applied: { created: 3 }, summary: { created: 3 } };
  await withServer(dependencies({
    async applyImport(input) { applyCalls.push(input); return applied; },
  }), {}, async (base) => {
    const response = await requestJson(`${base}/elvanto/apply`, {
      method: 'POST',
      body: {
        selection: { kind: 'elvanto_group', externalId: ' group-9 ' },
        reviewToken: 'signed-review',
        selections: { skipExternalPersonIds: ['person-2'] },
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, applied);
  });

  assert.ok(applyCalls[0].signal instanceof AbortSignal);
  const [{ signal: _signal, ...forwarded }] = applyCalls;
  assert.deepEqual(forwarded, {
    churchId: ADMIN.church_id,
    provider: 'elvanto',
    selection: { kind: 'elvanto_group', externalId: 'group-9' },
    reviewToken: 'signed-review',
    selections: { skipExternalPersonIds: ['person-2'] },
    userId: ADMIN.id,
  });
});

test('preview accepts exactly the four provider-compatible selection shapes', async () => {
  const accepted = [];
  await withServer(dependencies({
    async previewImport({ provider, selection }) {
      accepted.push({ provider, selection });
      return { provider, selection };
    },
  }), {}, async (base) => {
    const cases = [
      ['planning_center', { kind: 'all' }],
      ['planning_center', { kind: 'planning_center_list', externalId: '42' }],
      ['elvanto', { kind: 'elvanto_category', externalId: 'category-1' }],
      ['elvanto', { kind: 'elvanto_group', externalId: 'group-1' }],
    ];
    for (const [provider, selection] of cases) {
      const response = await requestJson(`${base}/${provider}/preview`, {
        method: 'POST', body: { selection },
      });
      assert.equal(response.status, 200);
    }
  });
  assert.deepEqual(accepted, [
    { provider: 'planning_center', selection: { kind: 'all' } },
    { provider: 'planning_center', selection: { kind: 'planning_center_list', externalId: '42' } },
    { provider: 'elvanto', selection: { kind: 'elvanto_category', externalId: 'category-1' } },
    { provider: 'elvanto', selection: { kind: 'elvanto_group', externalId: 'group-1' } },
  ]);
});

test('provider and selection allowlists reject malformed input before provider work', async () => {
  let calls = 0;
  const overrides = dependencies({
    listSources: async () => { calls += 1; return []; },
    previewImport: async () => { calls += 1; return {}; },
    applyImport: async () => { calls += 1; return {}; },
  });
  await withServer(overrides, {}, async (base) => {
    const cases = [
      ['GET', `${base}/unknown/sources`, undefined, 404],
      ['POST', `${base}/planning_center/preview`, { selection: { kind: 'elvanto_group', externalId: '1' } }, 400],
      ['POST', `${base}/elvanto/preview`, { selection: { kind: 'planning_center_list', externalId: '1' } }, 400],
      ['POST', `${base}/elvanto/preview`, { selection: { kind: 'all', externalId: 'all' } }, 400],
      ['POST', `${base}/elvanto/preview`, { selection: { kind: 'elvanto_category', externalId: ' ' } }, 400],
      ['POST', `${base}/elvanto/preview`, { selection: { kind: 'all' }, unexpected: true }, 400],
      ['POST', `${base}/elvanto/apply`, { selection: { kind: 'all' }, reviewToken: '', selections: {} }, 400],
      ['POST', `${base}/elvanto/apply`, { selection: { kind: 'all' }, reviewToken: 'token', selections: [] }, 400],
      ['POST', `${base}/elvanto/apply`, { selection: { kind: 'all' }, reviewToken: 'token', selections: {}, extra: true }, 400],
    ];
    for (const [method, url, body, wanted] of cases) {
      const response = await requestJson(url, { method, body });
      assert.equal(response.status, wanted, `${method} ${url}`);
      assert.equal(/credential|token=.*secret|stack/.test(JSON.stringify(response.body)), false);
    }
  });
  assert.equal(calls, 0);
});

test('the import parser rejects malformed and oversized bodies before the broader app parser', async () => {
  assert.equal(MAX_BODY_BYTES, 16 * 1024);
  await withServer(dependencies(), { preparse: true }, async (base) => {
    const oversized = await fetch(`${base}/elvanto/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selection: { kind: 'elvanto_group', externalId: 'x'.repeat(MAX_BODY_BYTES) } }),
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), {
      error: 'Invalid people import request.', code: 'PEOPLE_IMPORT_REQUEST_INVALID',
    });

    const malformed = await fetch(`${base}/elvanto/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"selection":',
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), {
      error: 'Invalid people import request.', code: 'PEOPLE_IMPORT_REQUEST_INVALID',
    });
  });
});

test('the route owns a 120-second abortable deadline and aborts provider work when it expires', async () => {
  let capturedSignal;
  await withServer(dependencies({
    routeTimeoutMs: 15,
    previewImport({ signal }) {
      capturedSignal = signal;
      return new Promise(() => {});
    },
  }), {}, async (base) => {
    const response = await requestJson(`${base}/planning_center/preview`, {
      method: 'POST', body: { selection: { kind: 'all' } },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, {
      error: 'The people import took too long to complete. Please try again.',
      code: 'SYNC_ROUTE_TIMEOUT',
    });
  });
  assert.ok(capturedSignal instanceof AbortSignal);
  assert.equal(capturedSignal.aborted, true);
});

test('a timed-out apply aborts late provider work before it can continue', async () => {
  const providerRead = deferred();
  const observedAfterProviderRead = deferred();
  await withServer(dependencies({
    routeTimeoutMs: 15,
    async applyImport({ signal }) {
      await providerRead.promise;
      observedAfterProviderRead.resolve({
        isAbortSignal: signal instanceof AbortSignal,
        aborted: signal?.aborted,
      });
      return { runId: 2, status: 'applied', applied: {}, summary: {} };
    },
  }), {}, async (base) => {
    const response = await requestJson(`${base}/elvanto/apply`, {
      method: 'POST',
      body: { selection: { kind: 'all' }, reviewToken: 'review-token', selections: {} },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, {
      error: 'The people import took too long to complete. Please try again.',
      code: 'SYNC_ROUTE_TIMEOUT',
    });
    providerRead.resolve();
    assert.deepEqual(await observedAfterProviderRead.promise, {
      isAbortSignal: true,
      aborted: true,
    });
  });
});

test('a disconnected apply aborts provider work that resolves after the client leaves', async () => {
  const providerRead = deferred();
  const applyStarted = deferred();
  const observedAfterProviderRead = deferred();
  await withServer(dependencies({
    routeTimeoutMs: 1000,
    async applyImport({ signal }) {
      applyStarted.resolve();
      await providerRead.promise;
      if (signal instanceof AbortSignal && !signal.aborted) {
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      }
      observedAfterProviderRead.resolve({
        isAbortSignal: signal instanceof AbortSignal,
        aborted: signal?.aborted,
      });
      return { runId: 2, status: 'applied', applied: {}, summary: {} };
    },
  }), {}, async (base) => {
    const client = new AbortController();
    const request = fetch(`${base}/elvanto/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selection: { kind: 'all' }, reviewToken: 'review-token', selections: {},
      }),
      signal: client.signal,
    }).catch((error) => error);
    await applyStarted.promise;
    client.abort();
    await request;
    providerRead.resolve();
    assert.deepEqual(await observedAfterProviderRead.promise, {
      isAbortSignal: true,
      aborted: true,
    });
  });
});

test('provider work receives the production 120,000 ms aggregate deadline', async () => {
  let capturedTimeoutMs;
  await withServer(dependencies({
    async withTimeout(promise, timeoutMs) {
      capturedTimeoutMs = timeoutMs;
      return promise;
    },
  }), {}, async (base) => {
    const response = await requestJson(`${base}/planning_center/preview`, {
      method: 'POST', body: { selection: { kind: 'all' } },
    });
    assert.equal(response.status, 200);
  });
  assert.equal(capturedTimeoutMs, 120000);
});

test('provider, review freshness, and unexpected failures return curated errors without raw detail', async () => {
  const cases = [
    ['SYNC_SOURCE_AUTH', 401, 'The provider rejected the stored connection credentials. Reconnect it to continue.'],
    ['SYNC_SOURCE_RATE_LIMIT', 429, 'The provider rate-limited this request. Please try again later.'],
    ['SYNC_SOURCE_UNAVAILABLE', 409, 'The selected provider source is no longer available.'],
    ['SYNC_SOURCE_INCOMPLETE', 502, 'The provider did not return a complete people list.'],
    ['ELVANTO_UNAVAILABLE', 503, 'Elvanto is currently unavailable. Please try again shortly.'],
    ['ELVANTO_RESPONSE', 502, 'Elvanto returned an unexpected response. Please try again shortly.'],
  ];

  for (const [code, status, error] of cases) {
    const raw = Object.assign(new Error('Bearer credential-secret at internal.db.local\nstack detail'), { code, status: 599 });
    await withServer(dependencies({ previewImport: async () => { throw raw; } }), {}, async (base) => {
      const response = await requestJson(`${base}/planning_center/preview`, {
        method: 'POST', body: { selection: { kind: 'all' } },
      });
      assert.equal(response.status, status, code);
      assert.deepEqual(response.body, { error, code });
      assert.equal(/credential-secret|internal\.db\.local|stack detail/.test(JSON.stringify(response.body)), false);
    });
  }

  for (const [code, error] of [
    ['SYNC_REVIEW_EXPIRED', 'This review has expired; fetch a fresh review before applying.'],
    ['SYNC_PLAN_STALE', 'The reviewed plan is out of date; fetch a fresh review before applying.'],
  ]) {
    const raw = Object.assign(new Error('review token credential-secret with internal stack detail'), { code });
    await withServer(dependencies({ applyImport: async () => { throw raw; } }), {}, async (base) => {
      const response = await requestJson(`${base}/planning_center/apply`, {
        method: 'POST',
        body: { selection: { kind: 'all' }, reviewToken: 'review-token', selections: {} },
      });
      assert.equal(response.status, 409, code);
      assert.deepEqual(response.body, { error, code });
      assert.equal(/credential-secret|stack detail/.test(JSON.stringify(response.body)), false);
    });
  }

  await withServer(dependencies({
    previewImport: async () => { throw new Error('api_key=credential-secret on internal.db.local'); },
  }), {}, async (base) => {
    const response = await requestJson(`${base}/planning_center/preview`, {
      method: 'POST', body: { selection: { kind: 'all' } },
    });
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { error: 'Unable to complete the people import.' });
    assert.equal(/credential-secret|internal\.db\.local/.test(JSON.stringify(response.body)), false);
  });
});
