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
const { EventEmitter } = require('node:events');
const { createPeopleSyncRouter } = require('./peopleSync');
const { OrchestratorError } = require('../../services/peopleSync/orchestrator');
const { ElvantoError, ELVANTO_AUTH } = require('../../services/elvanto/httpClient');

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

// ─── Church isolation ────────────────────────────────────────────────────────
//
// These per-route 401 checks prove ensureChurchIsolation is actually wired
// into this sub-router at all (router.use() middleware runs for ANY path
// under the mount, before Express tries to match a specific route further
// down — so, on their own, these do NOT depend on which route names exist,
// and would pass identically against the OLD pre-rename `/authority/*`
// paths, or even a nonexistent path). The structural test below is the
// actual guard against the specific bug this rename fixed: inside a
// mounted sub-router, req.path is relative to the mount point, so
// `POST /people-sync/authority/preview` used to arrive HERE as
// `/authority/preview` — which itself starts with "/auth" and would have
// silently skipped ensureChurchIsolation's own check (meant only to exempt
// the real /api/auth/* login routes). Renamed to /people-authority/* to
// kill this collision.
for (const path of ['/people-authority/preview', '/people-authority/cancel', '/people-authority/disable', '/settings', '/runs']) {
  test(`an invalid church_id is rejected on ${path} (mounted directly, no parent router involved)`, async () => {
    await withServer({}, { user: INVALID_CHURCH_ADMIN }, async (base) => {
      const isPost = path.startsWith('/people-authority');
      const { status, body } = await requestJson(`${base}${path}`, isPost ? { method: 'POST', body: {} } : { method: 'GET' });
      assert.equal(status, 401);
      assert.equal(body.code, 'INVALID_CHURCH_CONTEXT');
    });
  });
}

// Mirrors middleware/churchIsolation.js's own skip-list exactly (those are
// local consts in that file, not exported, so this is a deliberate,
// commented copy — if churchIsolation.js's own skip-list ever changes,
// this copy must be updated to match, or this test could pass while
// missing a real collision).
const CHURCH_ISOLATION_SKIP_PREFIXES = ['/auth', '/auth/request-code', '/auth/verify-code', '/importrange'];

function collectRoutePaths(router) {
  const paths = [];
  for (const layer of router.stack) {
    if (layer.route && layer.route.path) paths.push(layer.route.path);
  }
  return paths;
}

function routeHandler(router, path) {
  const layer = router.stack.find((candidate) => candidate.route?.path === path);
  return layer?.route?.stack.at(-1)?.handle;
}

// THE actual regression guard: walks every route this router really
// registers (not a hand-picked sample) and asserts none of them would be
// silently exempted from ensureChurchIsolation by churchIsolation.js's own
// `/auth`/`/importrange` prefix skip-list — the exact collision
// `/authority/preview` had before this router's routes were renamed to
// `/people-authority/*`. A future route added to this router that
// reintroduces a colliding name (e.g. a hypothetical `/auth-status`) would
// fail this test, unlike the per-route 401 checks above.
test('no route registered on this router would be silently exempted by ensureChurchIsolation\'s own /auth or /importrange skip-list', () => {
  const paths = collectRoutePaths(createPeopleSyncRouter());
  assert.ok(paths.length > 0, 'sanity check: the router must have at least one registered route for this test to mean anything');
  for (const path of paths) {
    for (const prefix of CHURCH_ISOLATION_SKIP_PREFIXES) {
      assert.equal(
        path.startsWith(prefix), false,
        `route "${path}" starts with "${prefix}" — ensureChurchIsolation would silently skip its own church_id ` +
        'check for this route when this router is mounted directly (req.path is mount-relative inside a sub-router)'
      );
    }
  }
});

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
    createAuthorityPreviewId: () => 'preview-route-1',
    previewAuthoritySwitch: async (args) => {
      calls.push(args);
      return { runId: 1, reviewToken: 'tok', decisionContractVersion: 2, summary: {}, plan: {} };
    },
  }, { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/people-authority/preview`, { method: 'POST', body: { provider: 'elvanto' } });
    assert.equal(status, 200);
    assert.equal(body.decisionContractVersion, 2);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].churchId, ADMIN_USER.church_id);
  assert.equal(calls[0].provider, 'elvanto');
  assert.equal(calls[0].authorityPreviewId, 'preview-route-1');
  assert.equal(calls[0].signal.aborted, false);
});

test('POST /people-authority/cancel conditionally clears the exact provider preview intent', async () => {
  const calls = [];
  await withServer({
    cancelAuthoritySwitch: async (...args) => {
      calls.push(args);
      return { active: 'none', pending: null };
    },
  }, { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/people-authority/cancel`, {
      method: 'POST',
      body: { provider: 'elvanto', authorityPreviewId: 'preview-cancel-1' },
    });
    assert.equal(status, 200);
    assert.deepEqual(body.authority, { active: 'none', pending: null });
  });
  assert.deepEqual(calls, [[ADMIN_USER.church_id, 'elvanto', 'preview-cancel-1']]);
});

test('POST /people-authority/apply forwards legacy and v2 selections verbatim with the acting user id', async () => {
  const calls = [];
  await withServer({
    applyReviewed: async (args) => { calls.push(args); return { runId: 1, status: 'applied', applied: {}, summary: {} }; },
  }, { user: ADMIN_USER }, async (base) => {
    const legacy = await requestJson(`${base}/people-authority/apply`, {
      method: 'POST',
      body: { provider: 'elvanto', reviewToken: 'tok-1', selections: { skipExternalPersonIds: ['p1'] } },
    });
    assert.equal(legacy.status, 200);
    const v2 = await requestJson(`${base}/people-authority/apply`, {
      method: 'POST',
      body: {
        provider: 'elvanto', reviewToken: 'tok-2',
        selections: { decisionContractVersion: 2, identityDecisions: { p1: { outcome: 'create' } } },
      },
    });
    assert.equal(v2.status, 200);
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].churchId, ADMIN_USER.church_id);
  assert.equal(calls[0].provider, 'elvanto');
  assert.equal(calls[0].reviewToken, 'tok-1');
  assert.deepEqual(calls[0].selections, { skipExternalPersonIds: ['p1'] });
  assert.equal(calls[0].userId, ADMIN_USER.id);
  assert.equal(calls[1].reviewToken, 'tok-2');
  assert.deepEqual(calls[1].selections, {
    decisionContractVersion: 2,
    identityDecisions: { p1: { outcome: 'create' } },
  });
  assert.equal(calls[1].userId, ADMIN_USER.id);
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
    assert.equal(unmapped.errorMessage, 'This sync run failed for an unrecognized reason. See server logs for details.');
    assert.equal(clean.errorMessage, null);
    const serialized = JSON.stringify(body);
    assert.equal(/ECONNREFUSED|10\.0\.0\.9|internal-db-host|whatever the future stores/.test(serialized), false);
  });
});

// SYNC_RUN_FAILED is orchestrator.js's safeErrorCode() catch-all for ANY
// thrown value without a recognized `.code` — i.e. the entire "genuinely
// unexpected bug" bucket, and therefore the single most likely stored code
// in practice. It (and ELVANTO_RECONNECT_REQUIRED and SYNC_REVIEW_SECRET —
// two other real, reachable codes) must each get a DISTINCT message from
// the generic "unrecognized code" fallback, or an admin loses exactly the
// diagnostic signal they need most for the failures they're least able to
// self-diagnose.
test('GET /runs gives SYNC_RUN_FAILED, SYNC_REVIEW_SECRET, and ELVANTO_RECONNECT_REQUIRED each a distinct message, not the generic unmapped fallback', async () => {
  await withServer({
    listAllRecentRuns: async () => ([
      { id: 1, provider: 'elvanto', status: 'failed', errorCode: 'SYNC_RUN_FAILED', errorMessage: 'raw' },
      { id: 2, provider: 'elvanto', status: 'failed', errorCode: 'SYNC_REVIEW_SECRET', errorMessage: 'raw' },
      { id: 3, provider: 'elvanto', status: 'failed', errorCode: 'ELVANTO_RECONNECT_REQUIRED', errorMessage: 'raw' },
      { id: 4, provider: 'elvanto', status: 'failed', errorCode: 'SOME_UNMAPPED_FUTURE_CODE', errorMessage: 'raw' },
    ]),
  }, { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/runs`);
    assert.equal(status, 200);
    const [runFailed, reviewSecret, reconnectRequired, unmapped] = body.runs;
    const genericFallback = 'This sync run failed for an unrecognized reason. See server logs for details.';
    assert.notEqual(runFailed.errorMessage, genericFallback);
    assert.notEqual(reviewSecret.errorMessage, genericFallback);
    assert.notEqual(reconnectRequired.errorMessage, genericFallback);
    assert.equal(unmapped.errorMessage, genericFallback);
    // All four still distinct from one another (no accidental collapsing).
    const messages = new Set([runFailed.errorMessage, reviewSecret.errorMessage, reconnectRequired.errorMessage, unmapped.errorMessage]);
    assert.equal(messages.size, 4);
  });
});

test('GET /runs maps source-selection, review, availability, completeness, auth, and rate-limit failures to safe messages', async () => {
  const codes = [
    'SYNC_SOURCE_SELECTION_REQUIRED',
    'SYNC_SOURCE_REVIEW_REQUIRED',
    'SYNC_SOURCE_UNAVAILABLE',
    'SYNC_SOURCE_INCOMPLETE',
    'SYNC_SOURCE_AUTH',
    'SYNC_SOURCE_RATE_LIMIT',
    'SYNC_REVIEW_ALREADY_APPLIED',
  ];
  await withServer({
    listAllRecentRuns: async () => codes.map((errorCode, index) => ({
      id: index + 1,
      provider: 'elvanto',
      status: 'failed',
      errorCode,
      errorMessage: `raw provider detail ${index} apiKey=super-secret`,
    })),
  }, { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/runs`);
    assert.equal(status, 200);
    const fallback = 'This sync run failed for an unrecognized reason. See server logs for details.';
    assert.deepEqual(body.runs.map((run) => run.errorCode), codes);
    assert.equal(body.runs.every((run) => run.errorMessage && run.errorMessage !== fallback), true);
    assert.equal(/raw provider detail|super-secret|apiKey/.test(JSON.stringify(body)), false);
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

test('PUT /settings does not retain a retired local-facts cache after changing the contact population gate', async () => {
  const cleared = [];
  await withServer({
    getSettings: async () => ({ elvantoIncludeContacts: true, fullReconciliationFrequency: 'weekly', fullReconciliationDay: 1 }),
    updateSettings: async (_churchId, patch) => ({ elvantoIncludeContacts: patch.elvantoIncludeContacts, fullReconciliationFrequency: 'weekly', fullReconciliationDay: 1 }),
    clearFilterFactsCache: (churchId, provider) => { cleared.push({ churchId, provider }); },
  }, { user: ADMIN_USER }, async (base) => {
    const { status } = await requestJson(`${base}/settings`, { method: 'PUT', body: { elvantoIncludeContacts: false } });
    assert.equal(status, 200);
  });
  assert.deepEqual(cleared, []);
});

test('PUT /settings leaves cache entries alone when the contact gate is unchanged or saving fails', async () => {
  const cleared = [];
  await withServer({
    getSettings: async () => ({ elvantoIncludeContacts: true, fullReconciliationFrequency: 'weekly', fullReconciliationDay: 1 }),
    updateSettings: async () => { throw new Error('database unavailable'); },
    clearFilterFactsCache: (churchId, provider) => { cleared.push({ churchId, provider }); },
  }, { user: ADMIN_USER }, async (base) => {
    const { status } = await requestJson(`${base}/settings`, { method: 'PUT', body: { elvantoIncludeContacts: false } });
    assert.equal(status, 500);
  });
  assert.deepEqual(cleared, []);
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

test('the emitted Elvanto source-auth code surfacing through authority apply maps to 401 reconnect-required', async () => {
  await withServer({
    applyReviewed: async () => { throw new ElvantoError('rejected', ELVANTO_AUTH, {}); },
  }, { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/people-authority/apply`, { method: 'POST', body: { provider: 'elvanto', reviewToken: 't' } });
    assert.equal(status, 401);
    assert.equal(body.code, ELVANTO_AUTH);
    assert.match(body.error, /reconnect elvanto/i);
  });
});

// ─── Aggregate route timeout (a real deadline, not just mapping an
// already-thrown provider error) ─────────────────────────────────────────────
//
// Both previewAuthoritySwitch and applyReviewed force a full paginated
// roster snapshot — exactly the "many sequential network calls in one
// request" scenario routeTimeout.js's withTimeout exists for, and exactly
// what elvanto.js's own plan/apply routes are already wrapped for. Uses a
// tiny `routeTimeoutMs` override (a real injected dependency) so these run
// in milliseconds rather than the real ~110s production default.
function neverResolvesForTimeoutTest() {
  return new Promise(() => {}); // deliberately never settles
}

test('POST /people-authority/preview times out safely and conditionally clears its background intent', async () => {
  const cancellations = [];
  let previewSignal;
  await withServer({
    routeTimeoutMs: 20,
    createAuthorityPreviewId: () => 'preview-timeout-1',
    previewAuthoritySwitch: ({ signal }) => {
      previewSignal = signal;
      return neverResolvesForTimeoutTest();
    },
    cancelAuthoritySwitch: async (...args) => { cancellations.push(args); return { active: 'none', pending: null }; },
  }, { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/people-authority/preview`, { method: 'POST', body: { provider: 'elvanto' } });
    assert.equal(status, 503);
    assert.equal(body.code, 'SYNC_ROUTE_TIMEOUT');
  });
  assert.equal(previewSignal.aborted, true);
  assert.deepEqual(cancellations, [[ADMIN_USER.church_id, 'elvanto', 'preview-timeout-1']]);
});

test('disconnecting the preview request aborts its pipeline and conditionally clears its exact intent', async () => {
  const cancellations = [];
  let markPreviewEntered;
  const previewEntered = new Promise((resolve) => { markPreviewEntered = resolve; });
  let markAborted;
  const aborted = new Promise((resolve) => { markAborted = resolve; });

  await withServer({
    routeTimeoutMs: 1000,
    createAuthorityPreviewId: () => 'preview-disconnect-1',
    previewAuthoritySwitch: ({ signal }) => new Promise((_resolve, reject) => {
      markPreviewEntered();
      signal.addEventListener('abort', () => {
        markAborted();
        reject(new OrchestratorError('SYNC_ROUTE_TIMEOUT', 'cancelled', 503));
      }, { once: true });
    }),
    cancelAuthoritySwitch: async (...args) => { cancellations.push(args); return { active: 'none', pending: null }; },
  }, { user: ADMIN_USER }, async (base) => {
    const target = new URL(`${base}/people-authority/preview`);
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    request.on('error', () => {});
    request.end(JSON.stringify({ provider: 'elvanto' }));
    await previewEntered;
    request.destroy();
    await aborted;
    await new Promise((resolve) => setImmediate(resolve));
  });

  assert.deepEqual(cancellations, [[ADMIN_USER.church_id, 'elvanto', 'preview-disconnect-1']]);
});

test('a response socket close after res.json but before finish still cancels the exact preview intent', async () => {
  const cancellations = [];
  let previewSignal;
  const router = createPeopleSyncRouter({
    createAuthorityPreviewId: () => 'preview-response-loss-1',
    previewAuthoritySwitch: async ({ signal }) => {
      previewSignal = signal;
      return { runId: 1, reviewToken: 'token', decisionContractVersion: 2, summary: {}, plan: {} };
    },
    cancelAuthoritySwitch: async (...args) => {
      cancellations.push(args);
      return { active: 'none', pending: null };
    },
  });
  const handler = routeHandler(router, '/people-authority/preview');
  assert.equal(typeof handler, 'function');

  const req = Object.assign(new EventEmitter(), {
    body: { provider: 'elvanto' },
    user: ADMIN_USER,
    aborted: false,
  });
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    status() { return this; },
    json(payload) {
      this.payload = payload;
      this.writableEnded = true;
      return this;
    },
  });

  await handler(req, res);
  assert.equal(res.payload.success, true);
  assert.equal(previewSignal.aborted, false);
  res.emit('close');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(previewSignal.aborted, true);
  assert.deepEqual(cancellations, [[ADMIN_USER.church_id, 'elvanto', 'preview-response-loss-1']]);
});

test('POST /people-authority/apply times out with a safe 503 rather than hanging forever on a stuck applyReviewed call', async () => {
  await withServer({ routeTimeoutMs: 20, applyReviewed: neverResolvesForTimeoutTest }, { user: ADMIN_USER }, async (base) => {
    const { status, body } = await requestJson(`${base}/people-authority/apply`, { method: 'POST', body: { provider: 'elvanto', reviewToken: 't' } });
    assert.equal(status, 503);
    assert.equal(body.code, 'SYNC_ROUTE_TIMEOUT');
  });
});
