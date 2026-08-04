'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { createElvantoRouter } = require('./elvanto');
const {
  ElvantoAuthorityConnectionRequiredError,
  ElvantoConnectionStaleError,
} = require('../../services/elvanto/legacyCredential');
const { ElvantoError, ELVANTO_AUTH } = require('../../services/elvanto/httpClient');
const { OrchestratorError } = require('../../services/peopleSync/orchestrator');

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
    replaceConnection: async ({ churchId, credentials, validateConnection }) => {
      const validation = await validateConnection({ churchId, credentials });
      return { validation, status: { provider: 'elvanto', connectionStatus: 'connected' } };
    },
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

async function withServer(overrides, callback, user = ADMIN) {
  const server = buildServer(overrides, user);
  await new Promise((resolve) => server.listen(0, resolve));
  try { return await callback(`http://127.0.0.1:${server.address().port}/elvanto`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function request(url, body, method = 'POST') {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const responseBody = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, body: responseBody };
}

test('correction preview delegates the signed correction request in church scope', async () => {
  const calls = [];
  await withServer({
    previewLinkCorrections: async (input) => {
      calls.push(input);
      return { reviewToken: 'corrected-review', decisionContractVersion: 2, summary: {}, plan: {}, snapshot: {} };
    },
  }, async (base) => {
    const response = await request(`${base}/sync-batches/12/preview-link-corrections`, {
      baseReviewToken: 'base-review',
      linkCorrections: { 'ext-a': { outcome: 'unlink', fromIndividualId: 10 } },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.reviewToken, 'corrected-review');
  });
  assert.deepEqual(calls, [{
    churchId: ADMIN.church_id,
    provider: 'elvanto',
    batchId: 12,
    baseReviewToken: 'base-review',
    linkCorrections: { 'ext-a': { outcome: 'unlink', fromIndividualId: 10 } },
  }]);
});

test('correction preview rejects missing base tokens before orchestration', async () => {
  let calls = 0;
  await withServer({ previewLinkCorrections: async () => { calls += 1; return {}; } }, async (base) => {
    const response = await request(`${base}/sync-batches/12/preview-link-corrections`, { linkCorrections: {} });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'SYNC_REVIEW_TOKEN_REQUIRED');
  });
  assert.equal(calls, 0);
});

test('correction preview rejects non-object corrections before orchestration', async () => {
  let calls = 0;
  await withServer({ previewLinkCorrections: async () => { calls += 1; return {}; } }, async (base) => {
    for (const linkCorrections of [null, [], 'unlink']) {
      const response = await request(`${base}/sync-batches/12/preview-link-corrections`, {
        baseReviewToken: 'base-review', linkCorrections,
      });
      assert.equal(response.status, 400);
      assert.equal(response.body.code, 'SYNC_SELECTIONS_INVALID');
    }
  });
  assert.equal(calls, 0);
});

test('correction preview rejects unsafe batch identifiers before orchestration', async () => {
  let calls = 0;
  await withServer({ previewLinkCorrections: async () => { calls += 1; return {}; } }, async (base) => {
    for (const id of ['0', '-1', '1.5', '9007199254740992', '1e309']) {
      const response = await request(`${base}/sync-batches/${id}/preview-link-corrections`, {
        baseReviewToken: 'base-review', linkCorrections: {},
      });
      assert.equal(response.status, 400, id);
    }
  });
  assert.equal(calls, 0);
});

test('correction preview maps route timeouts like plan and apply', async () => {
  await withServer({
    previewLinkCorrections: async () => new Promise(() => {}),
    routeTimeoutMs: 5,
  }, async (base) => {
    const response = await request(`${base}/sync-batches/12/preview-link-corrections`, {
      baseReviewToken: 'base-review', linkCorrections: {},
    });
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'SYNC_ROUTE_TIMEOUT');
  });
});

test('correction preview passes through orchestrator error status and code', async () => {
  await withServer({
    previewLinkCorrections: async () => {
      throw new OrchestratorError('SYNC_REVIEW_STALE', 'Review changed.', 409);
    },
  }, async (base) => {
    const response = await request(`${base}/sync-batches/12/preview-link-corrections`, {
      baseReviewToken: 'base-review', linkCorrections: {},
    });
    assert.deepEqual(response, {
      status: 409,
      body: { error: 'Review changed.', code: 'SYNC_REVIEW_STALE' },
    });
  });
});

test('correction preview and apply expose typed selection errors while stale plans remain conflicts', async () => {
  await withServer({
    previewLinkCorrections: async () => {
      throw new OrchestratorError('SYNC_SELECTIONS_INVALID', 'Relink target is invalid.', 400);
    },
    applyReviewed: async () => {
      throw new OrchestratorError('SYNC_PLAN_STALE', 'The correction base changed.', 409);
    },
  }, async (base) => {
    const preview = await request(`${base}/sync-batches/12/preview-link-corrections`, {
      baseReviewToken: 'base-review',
      linkCorrections: { 'ext-a': { outcome: 'unlink', fromIndividualId: 1 } },
    });
    assert.deepEqual(preview, {
      status: 400,
      body: { error: 'Relink target is invalid.', code: 'SYNC_SELECTIONS_INVALID' },
    });

    const apply = await request(`${base}/sync-batches/12/apply`, {
      reviewToken: 'corrected-review', selections: {},
    });
    assert.deepEqual(apply, {
      status: 409,
      body: { error: 'The correction base changed.', code: 'SYNC_PLAN_STALE' },
    });
  });
});

test('correction preview remains protected by admin and church middleware', async () => {
  let calls = 0;
  const overrides = { previewLinkCorrections: async () => { calls += 1; return {}; } };
  const sendPreview = (base) => request(`${base}/sync-batches/12/preview-link-corrections`, {
    baseReviewToken: 'base-review', linkCorrections: {},
  });
  await withServer(overrides, async (base) => {
    assert.equal((await sendPreview(base)).status, 403);
  }, { ...ADMIN, role: 'coordinator' });
  await withServer(overrides, async (base) => {
    const response = await sendPreview(base);
    assert.equal(response.status, 401);
    assert.equal(response.body.code, 'MISSING_CHURCH_CONTEXT');
  }, { id: ADMIN.id, role: 'admin' });
  assert.equal(calls, 0);
});

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

test('batch list, creation, and update expose a prepared operational state', async () => {
  const preparedBatch = {
    id: 4,
    provider: 'elvanto',
    enabled: true,
    source: { kind: 'elvanto_category', externalId: 'cat-1', name: 'Members' },
    needsSourceReview: false,
    scheduleFrequency: 'weekly',
    scheduleDay: 1,
  };
  await withServer({
    getAuthority: async () => ({ active: 'planning_center', pending: null }),
    listBatches: async () => [preparedBatch],
    getBatch: async () => preparedBatch,
    createBatch: async () => preparedBatch,
    updateBatch: async () => preparedBatch,
  }, async (base) => {
    const list = await request(`${base}/sync-batches`, undefined, 'GET');
    const created = await request(`${base}/sync-batches`, {
      sourceKind: 'elvanto_category', sourceExternalId: 'cat-1',
    });
    const updated = await request(`${base}/sync-batches/4`, { enabled: true }, 'PUT');

    for (const response of [list.body.batches[0], created.body.batch, updated.body.batch]) {
      assert.deepEqual({
        operationalState: response.operationalState,
        reviewable: response.reviewable,
        runnable: response.runnable,
      }, {
        operationalState: 'prepared',
        reviewable: false,
        runnable: false,
      });
    }
  });
});

test('run-now rejects a prepared batch before creating its review', async () => {
  let reviews = 0;
  await withServer({
    getAuthority: async () => ({ active: 'planning_center', pending: null }),
    getBatch: async () => ({
      id: 4, provider: 'elvanto', enabled: true,
      source: { kind: 'elvanto_category', externalId: 'cat-1', name: 'Members' },
      needsSourceReview: false,
    }),
    buildReview: async () => { reviews += 1; return {}; },
  }, async (base) => {
    const response = await request(`${base}/sync-batches/4/run-now`, {});
    assert.deepEqual(response, {
      status: 409,
      body: {
        error: 'This batch is prepared for a different people source. Switch source of truth before reviewing or running it.',
        code: 'SYNC_BATCH_PREPARED',
      },
    });
  });
  assert.equal(reviews, 0);
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

test('disconnect delegates one guarded church mutation without disabling authority separately', async () => {
  const calls = [];
  await withServer({
    getAuthority: async () => { throw new Error('route must not inspect authority outside the guarded service'); },
    disableAuthority: async () => { throw new Error('disconnect must not auto-disable authority'); },
    deleteLegacyPreferences: async () => { throw new Error('legacy deletion belongs in the guarded service transaction'); },
    disconnectConnection: async (...args) => { calls.push(args); return true; },
  }, async (base) => {
    const response = await request(`${base}/disconnect`, {});
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { success: true, disconnected: true });
  });
  assert.deepEqual(calls, [['churcha1']]);
});

test('disconnect returns the typed authority conflict as a safe 409', async () => {
  await withServer({
    disconnectConnection: async () => { throw new ElvantoAuthorityConnectionRequiredError(); },
  }, async (base) => {
    const response = await request(`${base}/disconnect`, {});
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'ELVANTO_AUTHORITY_CONNECTION_REQUIRED');
    assert.equal(response.body.error.includes('authoritative people source'), true);
  });
});

test('connect validates and replaces through the serialized credential service', async () => {
  let replacementInput;
  await withServer({
    upsertConnection: async () => { throw new Error('route must not write credentials directly'); },
    replaceConnection: async (input) => {
      replacementInput = input;
      const validation = await input.validateConnection({
        churchId: input.churchId,
        credentials: input.credentials,
      });
      return {
        validation,
        status: { provider: 'elvanto', connectionStatus: 'connected' },
      };
    },
  }, async (base) => {
    const response = await request(`${base}/connect`, { apiKey: 'replacement-key' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.status, { provider: 'elvanto', connectionStatus: 'connected' });
  });

  assert.equal(replacementInput.churchId, 'churcha1');
  assert.deepEqual(replacementInput.credentials, { apiKey: 'replacement-key' });
  assert.equal(replacementInput.connectedBy, 1);
  assert.equal(typeof replacementInput.validateConnection, 'function');
});

test('connect returns a stale replacement race as a safe 409', async () => {
  await withServer({
    replaceConnection: async () => { throw new ElvantoConnectionStaleError(); },
  }, async (base) => {
    const response = await request(`${base}/connect`, { apiKey: 'replacement-key' });
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, {
      error: 'The Elvanto connection changed while it was being verified. Refresh and try again.',
      code: 'ELVANTO_CONNECTION_STALE',
    });
  });
});

test('connect maps the real exported Elvanto auth code to invalid caller input', async () => {
  await withServer({
    replaceConnection: async () => {
      throw new ElvantoError('provider rejected credential', ELVANTO_AUTH, {});
    },
  }, async (base) => {
    const response = await request(`${base}/connect`, { apiKey: 'rejected-key' });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, ELVANTO_AUTH);
    assert.equal(response.body.error.includes('Invalid API key'), true);
    assert.equal(JSON.stringify(response.body).includes('rejected-key'), false);
  });
});

test('status classifies the real exported Elvanto auth code as an invalid stored key', async () => {
  let validationState;
  await withServer({
    getOrMigrateCredentials: async () => ({ apiKey: 'stored-key' }),
    adapter: {
      validateConnection: async () => {
        throw new ElvantoError('provider rejected credential', ELVANTO_AUTH, {});
      },
    },
    markValidated: async (_churchId, _provider, state) => { validationState = state; },
  }, async (base) => {
    const response = await request(`${base}/status`, undefined, 'GET');
    assert.equal(response.status, 200);
    assert.equal(response.body.connected, false);
    assert.equal(response.body.error.includes('invalid'), true);
  });
  assert.deepEqual(validationState, {
    connectionStatus: 'invalid',
    lastErrorCode: ELVANTO_AUTH,
  });
});
