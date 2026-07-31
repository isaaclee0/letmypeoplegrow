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
