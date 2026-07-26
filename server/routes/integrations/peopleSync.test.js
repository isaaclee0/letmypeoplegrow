'use strict';

// Route-level tests for the generic /people-sync/* router — a small Express
// harness with every service dependency injected (no real database, no real
// provider adapter, no real network call: see createPeopleSyncRouter's
// `overrides` parameter). Mirrors the "admin-only, church-scoped, safe
// errors" concerns every integration route in this app must satisfy.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { createPeopleSyncRouter } = require('./peopleSync');
const { OrchestratorError } = require('../../services/peopleSync/orchestrator');

const ADMIN_USER = { id: 1, church_id: 'churcha1', role: 'admin' };
const OTHER_CHURCH_ADMIN = { id: 2, church_id: 'churchb2', role: 'admin' };
const NON_ADMIN_USER = { id: 3, church_id: 'churcha1', role: 'attendance_taker' };
// Fails every branch of isValidChurchId's format check (utils/churchIdGenerator.js)
// — used to pin ensureChurchIsolation actually rejecting a malformed church_id
// on every route in this router, including the /people-authority/* ones.
const INVALID_CHURCH_ADMIN = { id: 4, church_id: '!! not a real church id !!', role: 'admin' };

// Builds a real (but ephemeral, port-0) HTTP server around the router under
// test, with a fake identity-injecting middleware standing in for the real
// verifyToken (which needs a JWT + a database) — everything downstream of
// identity (admin-only, church isolation) uses the REAL production
// middleware, not a reimplementation, so these tests exercise the actual
// enforcement code.
function buildServer(overrides, { user = ADMIN_USER } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/people-sync', createPeopleSyncRouter(overrides));
  return http.createServer(app);
}

async function withServer(overrides, options, callback) {
  const server = buildServer(overrides, options);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    return await callback(`http://127.0.0.1:${port}/people-sync`);
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

// ─── Admin-only access ───────────────────────────────────────────────────────

test('GET /settings rejects a non-admin user with 403 and never calls the dependency', async () => {
  let called = false;
  await withServer({ getSettings: async () => { called = true; return {}; } }, { user: NON_ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/settings`);
    assert.equal(status, 403);
    assert.equal(body.error, 'Insufficient permissions.');
  });
  assert.equal(called, false);
});

test('GET /settings rejects a missing identity with 401', async () => {
  await withServer({}, { user: null }, async (base) => {
    const { status } = await requestJson(`${base}/settings`);
    assert.equal(status, 401);
  });
});

// ─── Church isolation (regression: mount-relative req.path vs. the "/auth"
// skip in churchIsolation.js) ────────────────────────────────────────────────
//
// Inside a mounted sub-router, req.path is relative to the mount point —
// so `POST /people-sync/authority/preview` used to arrive HERE as
// `/authority/preview`, which itself starts with "/auth" and would have
// silently skipped ensureChurchIsolation's own validation (meant only to
// exempt the real /api/auth/* login routes). Renamed to /people-authority/*
// specifically to kill this; these tests pin the fix directly against this
// sub-router (in isolation, the same way a future accidental remount could
// reintroduce the bug) rather than relying on the parent integrations.js
// router's own (still-correct) outer ensureChurchIsolation to save it.
for (const path of ['/people-authority/preview', '/people-authority/disable', '/settings', '/runs']) {
  test(`an invalid church_id is rejected on ${path} (mounted directly, no parent router involved)`, async () => {
    await withServer({}, { user: INVALID_CHURCH_ADMIN }, async (base) => {
      const isPost = path.startsWith('/people-authority');
      const { status, body } = await requestJson(`${base}${path}`, isPost ? { method: 'POST', body: {} } : { method: 'GET' });
      assert.equal(status, 401);
      assert.equal(body.code, 'INVALID_CHURCH_CONTEXT');
    });
  });
}

// ─── Church ID forwarding ────────────────────────────────────────────────────

test('GET /settings forwards the requesting admin\'s own church_id, not a hardcoded or default value', async () => {
  const seen = [];
  await withServer({ getSettings: async (churchId) => { seen.push(churchId); return { authorityProvider: 'none' }; } },
    { user: OTHER_CHURCH_ADMIN }, async (base) => {
      const { status, body } = await requestJson(`${base}/settings`);
      assert.equal(status, 200);
      assert.deepEqual(seen, [OTHER_CHURCH_ADMIN.church_id]);
      assert.equal(body.settings.authorityProvider, 'none');
    });
});

test('POST /people-authority/preview forwards church_id and the requested provider', async () => {
  const calls = [];
  await withServer({
    previewAuthoritySwitch: async (args) => { calls.push(args); return { runId: 1, reviewToken: 'tok', summary: {}, plan: {} }; },
  }, { user: ADMIN_USER }, async (base) => {
    const { status } = await requestJson(`${base}/people-authority/preview`, { method: 'POST', body: { provider: 'elvanto' } });
    assert.equal(status, 200);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].churchId, ADMIN_USER.church_id);
  assert.equal(calls[0].provider, 'elvanto');
});

test('POST /people-authority/apply forwards churchId, provider, reviewToken, selections, and the acting user id', async () => {
  const calls = [];
  await withServer({
    applyReviewed: async (args) => { calls.push(args); return { runId: 1, status: 'applied', applied: {}, summary: {} }; },
  }, { user: ADMIN_USER }, async (base) => {
    const { status } = await requestJson(`${base}/people-authority/apply`, {
      method: 'POST',
      body: { provider: 'elvanto', reviewToken: 'tok-1', selections: { skipExternalPersonIds: ['p1'] } },
    });
    assert.equal(status, 200);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].churchId, ADMIN_USER.church_id);
  assert.equal(calls[0].provider, 'elvanto');
  assert.equal(calls[0].reviewToken, 'tok-1');
  assert.deepEqual(calls[0].selections, { skipExternalPersonIds: ['p1'] });
  assert.equal(calls[0].userId, ADMIN_USER.id);
});

test('POST /people-authority/disable forwards church_id', async () => {
  const calls = [];
  await withServer({ disableAuthority: async (churchId) => { calls.push(churchId); return { active: 'none', pending: null }; } },
    { user: ADMIN_USER }, async (base) => {
      const { status, body } = await requestJson(`${base}/people-authority/disable`, { method: 'POST' });
      assert.equal(status, 200);
      assert.deepEqual(body.authority, { active: 'none', pending: null });
    });
  assert.deepEqual(calls, [ADMIN_USER.church_id]);
});

test('GET /runs forwards church_id and an effective limit', async () => {
  const calls = [];
  await withServer({ listAllRecentRuns: async (churchId, limit) => { calls.push({ churchId, limit }); return []; } },
    { user: ADMIN_USER }, async (base) => {
      const { status } = await requestJson(`${base}/runs`);
      assert.equal(status, 200);
    });
  assert.deepEqual(calls, [{ churchId: ADMIN_USER.church_id, limit: 20 }]);
});

test('GET /runs merges and caps recent runs across providers, most recent first', async () => {
  await withServer({
    listAllRecentRuns: async () => ([
      { id: 3, provider: 'elvanto', status: 'applied' },
      { id: 5, provider: 'planning_center', status: 'applied' },
      { id: 1, provider: 'elvanto', status: 'failed' },
    ]),
  }, { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/runs`);
    assert.equal(status, 200);
    assert.deepEqual(body.runs.map((r) => r.id), [3, 5, 1]);
  });
});

test('GET /runs never echoes a run\'s raw stored errorMessage — only a fixed message keyed by errorCode', async () => {
  // runRepository's own stored errorMessage passes a credential-focused
  // sanitizer at WRITE time, but that is a narrower bar than the rest of
  // this API — every other route here only ever returns a small, fixed,
  // curated message per error code (see respondWithError), never a raw
  // stored/thrown message, which could still carry other internal detail
  // (e.g. a raw SQLite error, an internal hostname) a credential sanitizer
  // was never trying to catch.
  await withServer({
    listAllRecentRuns: async () => ([
      {
        id: 9, provider: 'elvanto', status: 'failed', errorCode: 'SYNC_FETCH_INCOMPLETE',
        errorMessage: 'raw internal detail: connect ECONNREFUSED 10.0.0.9:5432 at internal-db-host',
      },
      { id: 10, provider: 'elvanto', status: 'failed', errorCode: 'SOME_UNMAPPED_FUTURE_CODE', errorMessage: 'whatever the future stores' },
      { id: 11, provider: 'elvanto', status: 'applied', errorCode: null, errorMessage: null },
    ]),
  }, { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/runs`);
    assert.equal(status, 200);
    const [mapped, unmapped, clean] = body.runs;
    assert.equal(mapped.errorMessage, 'The provider fetch did not return a complete result.');
    assert.equal(unmapped.errorMessage, 'This sync run failed. See server logs for details.');
    assert.equal(clean.errorMessage, null);
    const serialized = JSON.stringify(body);
    assert.equal(/ECONNREFUSED|10\.0\.0\.9|internal-db-host|whatever the future stores/.test(serialized), false);
  });
});

// ─── Request validation ──────────────────────────────────────────────────────

test('PUT /settings rejects an empty body', async () => {
  await withServer({ getSettings: async () => ({ fullReconciliationFrequency: 'weekly' }) }, { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/settings`, { method: 'PUT', body: {} });
    assert.equal(status, 400);
    assert.match(body.error, /at least one setting/i);
  });
});

test('PUT /settings rejects an unknown key', async () => {
  await withServer({ getSettings: async () => ({ fullReconciliationFrequency: 'weekly' }) }, { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/settings`, { method: 'PUT', body: { authorityProvider: 'elvanto' } });
    assert.equal(status, 400);
    assert.match(body.error, /unknown setting/i);
  });
});

test('PUT /settings rejects a non-boolean elvantoIncludeContacts', async () => {
  await withServer({ getSettings: async () => ({ fullReconciliationFrequency: 'weekly' }) }, { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/settings`, { method: 'PUT', body: { elvantoIncludeContacts: 'yes' } });
    assert.equal(status, 400);
    assert.match(body.error, /elvantoIncludeContacts must be a boolean/i);
  });
});

test('PUT /settings rejects an out-of-range day for the resulting frequency', async () => {
  await withServer({ getSettings: async () => ({ fullReconciliationFrequency: 'weekly' }) }, { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/settings`, { method: 'PUT', body: { fullReconciliationDay: 15 } });
    assert.equal(status, 400);
    assert.match(body.error, /between 0 and 6/i);
  });
});

test('PUT /settings rejects a frequency-only patch that would leave a stale, now-invalid stored day in place', async () => {
  // Regression: stored {frequency:'monthly', day:20}; patching to
  // {frequency:'weekly'} ALONE used to be silently accepted, because the
  // validator only checked whatever day happened to be IN THIS REQUEST
  // (undefined here) rather than the RESULTING day (20, still stored) —
  // permanently and silently breaking scheduler.isDueToday('weekly', 20),
  // which the two-consecutive-full-reconciliations archive rule depends on.
  await withServer({
    getSettings: async () => ({ fullReconciliationFrequency: 'monthly', fullReconciliationDay: 20 }),
  }, { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/settings`, {
      method: 'PUT', body: { fullReconciliationFrequency: 'weekly' },
    });
    assert.equal(status, 400);
    assert.match(body.error, /between 0 and 6/i);
  });
});

test('PUT /settings accepts a frequency-only patch when the already-stored day is valid for the new frequency', async () => {
  let patchSeen = null;
  await withServer({
    getSettings: async () => ({ fullReconciliationFrequency: 'monthly', fullReconciliationDay: 3 }),
    updateSettings: async (churchId, patch) => { patchSeen = patch; return { authorityProvider: 'none', ...patch }; },
  }, { user: ADMIN_USER }, async (base) => {
    const { status } = await requestJson(`${base}/settings`, { method: 'PUT', body: { fullReconciliationFrequency: 'weekly' } });
    assert.equal(status, 200);
  });
  assert.deepEqual(patchSeen, { fullReconciliationFrequency: 'weekly' });
});

test('PUT /settings rejects an out-of-range day even for a daily frequency', async () => {
  await withServer({ getSettings: async () => ({ fullReconciliationFrequency: 'daily', fullReconciliationDay: 1 }) },
    { user: ADMIN_USER }, async (base) => {
      const { status, body } = await requestJson(`${base}/settings`, { method: 'PUT', body: { fullReconciliationDay: 999 } });
      assert.equal(status, 400);
      assert.match(body.error, /between 0 and 31/i);
    });
});

test('PUT /settings accepts a valid partial patch and never switches authority', async () => {
  let patchSeen = null;
  await withServer({
    getSettings: async () => ({ fullReconciliationFrequency: 'weekly' }),
    updateSettings: async (churchId, patch) => { patchSeen = patch; return { authorityProvider: 'none', ...patch }; },
  }, { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/settings`, {
      method: 'PUT', body: { elvantoIncludeContacts: false, fullReconciliationDay: 3 },
    });
    assert.equal(status, 200);
    assert.equal(body.settings.authorityProvider, 'none');
  });
  assert.deepEqual(patchSeen, { elvantoIncludeContacts: false, fullReconciliationDay: 3 });
});

test('POST /people-authority/apply rejects a non-object selections payload by treating it as empty rather than crashing', async () => {
  const calls = [];
  await withServer({
    applyReviewed: async (args) => { calls.push(args); return { runId: 1, status: 'applied', applied: {}, summary: {} }; },
  }, { user: ADMIN_USER }, async (base) => {
    const { status } = await requestJson(`${base}/people-authority/apply`, {
      method: 'POST', body: { provider: 'elvanto', reviewToken: 'tok', selections: 'not-an-object' },
    });
    assert.equal(status, 200);
  });
  assert.deepEqual(calls[0].selections, {});
});

// ─── Surfacing authorityCommitError distinctly ──────────────────────────────

test('POST /people-authority/apply surfaces authorityCommitError with a 200 rather than dropping it', async () => {
  await withServer({
    applyReviewed: async () => ({
      runId: 9, status: 'applied', applied: {}, summary: {},
      authorityCommitError: 'Authority switch commit failed after a successful apply; see server logs.',
    }),
  }, { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/people-authority/apply`, {
      method: 'POST', body: { provider: 'elvanto', reviewToken: 'tok' },
    });
    assert.equal(status, 200);
    assert.equal(body.authorityCommitError, 'Authority switch commit failed after a successful apply; see server logs.');
  });
});

// ─── Safe error mapping (exhaustive OrchestratorError codes) ────────────────

const ORCHESTRATOR_CODE_STATUS = [
  ['SYNC_PROVIDER_INVALID', 400],
  ['SYNC_CHURCH_REQUIRED', 400],
  ['SYNC_NOT_CONNECTED', 400],
  ['SYNC_CONNECTION_INVALID', 400],
  ['SYNC_BATCH_NOT_FOUND', 404],
  ['SYNC_BATCH_DISABLED', 400],
  ['SYNC_NO_BATCHES', 400],
  ['SYNC_BATCH_FILTER_INVALID', 400],
  ['SYNC_FETCH_INCOMPLETE', 502],
  ['SYNC_TRIGGER_INVALID', 400],
  ['SYNC_REVIEW_INVALID', 400],
  ['SYNC_REVIEW_EXPIRED', 409],
  ['SYNC_PLAN_STALE', 409],
  ['SYNC_SELECTIONS_INVALID', 400],
  ['SYNC_BATCH_REQUIRED', 400],
  ['SYNC_AUTHORITY_MISMATCH', 409],
];

for (const [code, status] of ORCHESTRATOR_CODE_STATUS) {
  test(`POST /people-authority/preview maps OrchestratorError ${code} to ${status} with a safe body`, async () => {
    await withServer({
      previewAuthoritySwitch: async () => { throw new OrchestratorError(code, `safe message for ${code}`, status); },
    }, { user: ADMIN_USER }, async (base) => {
      const { status: httpStatus, body } = await requestJson(`${base}/people-authority/preview`, { method: 'POST', body: { provider: 'elvanto' } });
      assert.equal(httpStatus, status);
      assert.equal(body.code, code);
      assert.equal(body.error, `safe message for ${code}`);
    });
  });
}

test('an unexpected (non-OrchestratorError) failure never leaks its raw message to the client', async () => {
  await withServer({
    previewAuthoritySwitch: async () => { throw new Error('ECONNRESET talking to some internal service at 10.0.0.5:5432'); },
  }, { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/people-authority/preview`, { method: 'POST', body: { provider: 'elvanto' } });
    assert.equal(status, 500);
    assert.equal(body.error, 'An unexpected error occurred.');
    assert.equal(/10\.0\.0\.5/.test(JSON.stringify(body)), false);
  });
});

// ─── Timeouts (a provider timeout propagating through the orchestrator) ────

test('a provider timeout propagating through previewAuthoritySwitch is mapped to a safe 503, not left hanging or leaking detail', async () => {
  const { ElvantoError } = require('../../services/elvanto/httpClient');
  await withServer({
    previewAuthoritySwitch: async () => {
      throw new ElvantoError('Elvanto request to /people/getAll.json failed: request timed out', 'ELVANTO_UNAVAILABLE', {});
    },
  }, { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/people-authority/preview`, { method: 'POST', body: { provider: 'elvanto' } });
    assert.equal(status, 503);
    assert.equal(body.code, 'ELVANTO_UNAVAILABLE');
    assert.equal(/request timed out/.test(JSON.stringify(body)), false, 'the raw provider error text must not reach the client');
  });
});

test('a stale/invalid Elvanto key surfacing through applyReviewed (authority switch) maps to 401', async () => {
  const { ElvantoError } = require('../../services/elvanto/httpClient');
  await withServer({
    applyReviewed: async () => { throw new ElvantoError('rejected', 'ELVANTO_AUTH', {}); },
  }, { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/people-authority/apply`, { method: 'POST', body: { provider: 'elvanto', reviewToken: 't' } });
    assert.equal(status, 401);
    assert.equal(body.code, 'ELVANTO_AUTH');
  });
});
