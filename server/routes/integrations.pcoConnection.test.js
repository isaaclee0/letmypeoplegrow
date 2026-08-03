'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const connectionStore = require('../services/peopleSync/connectionStore');
const pcoSync = require('../services/planningCenterSync');
const backgroundCheckSync = require('../services/planningCenter/backgroundCheckSync');
const integrationsRouter = require('./integrations');

async function withCredentialKey(run) {
  const previous = process.env.INTEGRATION_CREDENTIALS_KEY;
  process.env.INTEGRATION_CREDENTIALS_KEY = Buffer.alloc(32, 6).toString('base64');
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.INTEGRATION_CREDENTIALS_KEY;
    else process.env.INTEGRATION_CREDENTIALS_KEY = previous;
  }
}

async function withRouteChurchDb(run) {
  return withCredentialKey(() => withTestChurchDb(async () => {
    const churchId = `tst${Math.random().toString(36).slice(2, 12)}`;
    Database.getChurchDb(churchId);
    await Database.queryForChurch(
      churchId,
      `INSERT INTO church_settings (church_id, church_name) VALUES (?, 'Route Test Church')`,
      [churchId]
    );
    return Database.setChurchContext(churchId, async () => {
      const app = await startApp(churchId);
      try {
        return await run({ churchId, app });
      } finally {
        await app.close();
      }
    });
  }));
}

async function startApp(churchId) {
  const user = await Database.query(
    `INSERT INTO users (email, role, first_name, last_name, is_active, church_id)
     VALUES (?, 'admin', 'Admin', 'User', 1, ?)`,
    [`pco-connection-${Math.random().toString(36).slice(2)}@example.com`, churchId]
  );
  Database.getRegistryDb().prepare(
    `INSERT INTO churches (church_id, church_name, is_approved) VALUES (?, 'Route Test Church', 1)`
  ).run(churchId);
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'pco-connection-route-test-secret';
  const token = jwt.sign({ userId: user.insertId, churchId }, process.env.JWT_SECRET);
  const app = express();
  app.use(express.json());
  app.use('/api/integrations', integrationsRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    async request(path, options = {}) {
      const response = await fetch(`${base}${path}`, {
        ...options,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const contentType = response.headers.get('content-type') || '';
      const body = contentType.includes('application/json')
        ? await response.json()
        : await response.text();
      return {
        status: response.status,
        body,
        location: response.headers.get('location'),
      };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
    },
  };
}

function makeBackgroundRefreshHarness(churchId) {
  let providerReads = 0;
  const snapshot = {
    fetchedAt: '2026-08-03T05:00:00.000Z',
    complete: true,
    people: [],
  };
  return {
    async refresh() {
      return backgroundCheckSync.refreshBackgroundCheckStatuses(churchId, {
        isTrackingEnabled: async () => true,
        now: () => 1_000,
        withToken: async (_scopedChurchId, operation) => operation('cache-test-token'),
        fetchSnapshot: async () => {
          providerReads += 1;
          return snapshot;
        },
        applySnapshot: async () => ({
          fetchedAt: snapshot.fetchedAt,
          updated: 0,
          cleared: 0,
          notCleared: 0,
          unknown: 0,
        }),
      });
    },
    providerReads: () => providerReads,
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function makeCredentialBoundBackgroundHarness(churchId, { pauseStoredFetch = false } = {}) {
  const storedFetchStarted = createDeferred();
  const storedFetchRelease = createDeferred();
  const providerReads = [];
  const localApplies = [];
  const makeSnapshot = (id) => ({
    fetchedAt: '2026-08-03T05:00:00.000Z',
    complete: true,
    people: [{ id, passedBackgroundCheck: true }],
  });
  const overrides = {
    isTrackingEnabled: async () => true,
    now: () => 1_000,
    withToken: async (scopedChurchId, operation) => {
      const credentials = await connectionStore.getCredentials(scopedChurchId, 'planning_center');
      if (!credentials) throw new Error(`Planning Center connection unavailable for ${scopedChurchId}`);
      return operation(credentials.accessToken);
    },
    fetchSnapshot: async ({ accessToken }) => {
      providerReads.push(accessToken);
      if (pauseStoredFetch && accessToken === 'stored-access') {
        storedFetchStarted.resolve();
        await storedFetchRelease.promise;
      }
      return makeSnapshot(accessToken === 'stored-access' ? 'old-snapshot' : 'fresh-snapshot');
    },
    applySnapshot: (scopedChurchId, snapshot) => Database.transactionForChurch(
      scopedChurchId,
      async () => {
        localApplies.push(snapshot.people[0].id);
        return {
          fetchedAt: snapshot.fetchedAt,
          updated: 1,
          cleared: 1,
          notCleared: 0,
          unknown: 0,
        };
      }
    ),
  };
  return {
    refresh: () => backgroundCheckSync.refreshBackgroundCheckStatuses(churchId, overrides),
    waitForStoredFetch: () => storedFetchStarted.promise,
    releaseStoredFetch: () => storedFetchRelease.resolve(),
    providerReads,
    localApplies,
  };
}

function mockPcoTokenExchange(t) {
  t.mock.method(https, 'request', (_options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.write = () => {};
    request.destroy = (error) => request.emit('error', error);
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-type': 'application/json' };
      callback(response);
      queueMicrotask(() => {
        response.emit('data', JSON.stringify({
          access_token: 'replacement-access-token',
          refresh_token: 'replacement-refresh-token',
          expires_in: 7200,
        }));
        response.emit('end');
      });
    };
    return request;
  });
}

async function seedPcoConnection(churchId) {
  await connectionStore.upsertConnection({
    churchId,
    provider: 'planning_center',
    authType: 'oauth',
    credentials: { accessToken: 'stored-access', refreshToken: 'stored-refresh', expiresAt: Date.now() + 3600_000 },
    metadata: { accountName: 'Example Church' },
  });
}

async function withPcoStatusStubs(stubs, run) {
  const originals = {
    getAccessTokenForChurch: pcoSync.getAccessTokenForChurch,
    getTokensForChurch: pcoSync.getTokensForChurch,
    validatePlanningCenterToken: pcoSync.validatePlanningCenterToken,
  };
  Object.assign(pcoSync, stubs);
  try {
    return await run();
  } finally {
    Object.assign(pcoSync, originals);
  }
}

test('PCO status reports reconnect required when a stored connection cannot refresh credentials', async () => {
  // Catches status treating a stored but unusable church connection as an ordinary first-time disconnect.
  const previousEnabled = process.env.PLANNING_CENTER_ENABLED;
  process.env.PLANNING_CENTER_ENABLED = 'true';
  try {
    await withRouteChurchDb(async ({ churchId, app }) => {
      await seedPcoConnection(churchId);
      await withPcoStatusStubs({
        getAccessTokenForChurch: async () => {
          const error = new Error('credentials unavailable');
          error.code = 'SYNC_SOURCE_AUTH';
          throw error;
        },
        getTokensForChurch: async () => null,
        validatePlanningCenterToken: async () => ({ connected: true, accountName: 'Example Church' }),
      }, async () => {
        const response = await app.request('/api/integrations/planning-center/status');
        assert.equal(response.status, 200);
        assert.equal(response.body.connected, false);
        assert.equal(response.body.reconnectRequired, true);
        assert.equal(response.body.connectionErrorCode, 'SYNC_SOURCE_AUTH');
        assert.equal(response.body.configured, true);
      });
    });
  } finally {
    if (previousEnabled === undefined) delete process.env.PLANNING_CENTER_ENABLED;
    else process.env.PLANNING_CENTER_ENABLED = previousEnabled;
  }
});

test('PCO status distinguishes a first-time connection from reconnect recovery', async () => {
  // Catches recovery UI appearing when no encrypted Planning Center connection exists.
  const previousEnabled = process.env.PLANNING_CENTER_ENABLED;
  process.env.PLANNING_CENTER_ENABLED = 'true';
  try {
    await withRouteChurchDb(async ({ app }) => {
      await withPcoStatusStubs({
        getAccessTokenForChurch: async () => null,
        getTokensForChurch: async () => null,
        validatePlanningCenterToken: async () => ({ connected: false, accountName: null }),
      }, async () => {
        const response = await app.request('/api/integrations/planning-center/status');
        assert.equal(response.status, 200);
        assert.equal(response.body.connected, false);
        assert.equal(response.body.reconnectRequired, false);
        assert.equal(response.body.connectionErrorCode, null);
      });
    });
  } finally {
    if (previousEnabled === undefined) delete process.env.PLANNING_CENTER_ENABLED;
    else process.env.PLANNING_CENTER_ENABLED = previousEnabled;
  }
});

test('PCO status keeps a transient validation failure separate from credential recovery', async () => {
  // Catches a PCO rate limit or outage incorrectly prompting an admin to replace valid credentials.
  const previousEnabled = process.env.PLANNING_CENTER_ENABLED;
  process.env.PLANNING_CENTER_ENABLED = 'true';
  try {
    await withRouteChurchDb(async ({ churchId, app }) => {
      await seedPcoConnection(churchId);
      await withPcoStatusStubs({
        getAccessTokenForChurch: async () => 'current-access-token',
        getTokensForChurch: async () => null,
        validatePlanningCenterToken: async () => ({ connected: false, accountName: null, status: 503 }),
      }, async () => {
        const response = await app.request('/api/integrations/planning-center/status');
        assert.equal(response.status, 200);
        assert.equal(response.body.connected, false);
        assert.equal(response.body.reconnectRequired, false);
        assert.equal(response.body.connectionErrorCode, null);
        assert.equal(response.body.error, 'Failed to verify connection');
      });
    });
  } finally {
    if (previousEnabled === undefined) delete process.env.PLANNING_CENTER_ENABLED;
    else process.env.PLANNING_CENTER_ENABLED = previousEnabled;
  }
});

test('PCO status keeps a rate-limited validation separate from credential recovery', async () => {
  // Catches PCO rate limiting incorrectly prompting an admin to replace valid credentials.
  const previousEnabled = process.env.PLANNING_CENTER_ENABLED;
  process.env.PLANNING_CENTER_ENABLED = 'true';
  try {
    await withRouteChurchDb(async ({ churchId, app }) => {
      await seedPcoConnection(churchId);
      await withPcoStatusStubs({
        getAccessTokenForChurch: async () => 'current-access-token',
        getTokensForChurch: async () => null,
        validatePlanningCenterToken: async () => ({ connected: false, accountName: null, status: 429 }),
      }, async () => {
        const response = await app.request('/api/integrations/planning-center/status');
        assert.equal(response.status, 200);
        assert.equal(response.body.connected, false);
        assert.equal(response.body.reconnectRequired, false);
        assert.equal(response.body.connectionErrorCode, null);
        assert.equal(response.body.error, 'Failed to verify connection');
      });
    });
  } finally {
    if (previousEnabled === undefined) delete process.env.PLANNING_CENTER_ENABLED;
    else process.env.PLANNING_CENTER_ENABLED = previousEnabled;
  }
});

test('PCO status reports reconnect required when validation rejects the access token', async () => {
  // Catches a rejected /me response being flattened into the transient connection-error state.
  const previousEnabled = process.env.PLANNING_CENTER_ENABLED;
  process.env.PLANNING_CENTER_ENABLED = 'true';
  try {
    await withRouteChurchDb(async ({ churchId, app }) => {
      await seedPcoConnection(churchId);
      await withPcoStatusStubs({
        getAccessTokenForChurch: async () => 'rejected-access-token',
        getTokensForChurch: async () => null,
        validatePlanningCenterToken: async () => ({ connected: false, accountName: null, status: 401 }),
      }, async () => {
        const response = await app.request('/api/integrations/planning-center/status');
        assert.equal(response.status, 200);
        assert.equal(response.body.connected, false);
        assert.equal(response.body.reconnectRequired, true);
        assert.equal(response.body.connectionErrorCode, 'SYNC_SOURCE_AUTH');
      });
    });
  } finally {
    if (previousEnabled === undefined) delete process.env.PLANNING_CENTER_ENABLED;
    else process.env.PLANNING_CENTER_ENABLED = previousEnabled;
  }
});

test('PCO status preserves typed transient credential-refresh failures without requesting reconnect', async () => {
  // Catches token-endpoint rate limits/outages being flattened to a null
  // status code even though reconnecting cannot resolve them.
  const previousEnabled = process.env.PLANNING_CENTER_ENABLED;
  process.env.PLANNING_CENTER_ENABLED = 'true';
  try {
    await withRouteChurchDb(async ({ churchId, app }) => {
      await seedPcoConnection(churchId);
      for (const code of ['SYNC_SOURCE_RATE_LIMIT', 'SYNC_SOURCE_CHECK_FAILED']) {
        await withPcoStatusStubs({
          getAccessTokenForChurch: async () => {
            const error = new Error('transient refresh failure');
            error.code = code;
            throw error;
          },
          getTokensForChurch: async () => null,
          validatePlanningCenterToken: async () => ({ connected: true, accountName: 'Example Church' }),
        }, async () => {
          const response = await app.request('/api/integrations/planning-center/status');
          assert.equal(response.status, 200);
          assert.equal(response.body.connected, false);
          assert.equal(response.body.reconnectRequired, false);
          assert.equal(response.body.connectionErrorCode, code);
          assert.equal(response.body.error, 'Failed to verify connection');
        });
      }
    });
  } finally {
    if (previousEnabled === undefined) delete process.env.PLANNING_CENTER_ENABLED;
    else process.env.PLANNING_CENTER_ENABLED = previousEnabled;
  }
});

test('successful OAuth credential replacement invalidates the church background-check snapshot', async (t) => {
  const previousClientId = process.env.PLANNING_CENTER_CLIENT_ID;
  const previousClientSecret = process.env.PLANNING_CENTER_CLIENT_SECRET;
  process.env.PLANNING_CENTER_CLIENT_ID = 'test-client';
  process.env.PLANNING_CENTER_CLIENT_SECRET = 'test-secret';
  mockPcoTokenExchange(t);

  try {
    await withRouteChurchDb(async ({ churchId, app }) => {
      backgroundCheckSync.invalidateBackgroundCheckStatusCache(churchId);
      try {
        await seedPcoConnection(churchId);
        const backgroundRefresh = makeBackgroundRefreshHarness(churchId);
        await backgroundRefresh.refresh();
        assert.equal(backgroundRefresh.providerReads(), 1);

        const state = Buffer.from(JSON.stringify({
          redirectUri: 'http://localhost/api/integrations/planning-center/callback',
        })).toString('base64');
        await withPcoStatusStubs({
          validatePlanningCenterToken: async () => ({
            connected: true,
            accountName: 'Replacement Account',
          }),
        }, async () => {
          const response = await app.request(
            `/api/integrations/planning-center/callback?code=test-code&state=${encodeURIComponent(state)}`,
            { redirect: 'manual' }
          );
          assert.equal(response.status, 302);
          assert.match(response.location, /pco_success=true/);
        });

        await backgroundRefresh.refresh();
        assert.equal(backgroundRefresh.providerReads(), 2);
      } finally {
        backgroundCheckSync.invalidateBackgroundCheckStatusCache(churchId);
      }
    });
  } finally {
    if (previousClientId === undefined) delete process.env.PLANNING_CENTER_CLIENT_ID;
    else process.env.PLANNING_CENTER_CLIENT_ID = previousClientId;
    if (previousClientSecret === undefined) delete process.env.PLANNING_CENTER_CLIENT_SECRET;
    else process.env.PLANNING_CENTER_CLIENT_SECRET = previousClientSecret;
  }
});

test('OAuth replacement blocks an old fetched snapshot and applies one fresh snapshot after commit', async (t) => {
  const previousClientId = process.env.PLANNING_CENTER_CLIENT_ID;
  const previousClientSecret = process.env.PLANNING_CENTER_CLIENT_SECRET;
  process.env.PLANNING_CENTER_CLIENT_ID = 'test-client';
  process.env.PLANNING_CENTER_CLIENT_SECRET = 'test-secret';
  mockPcoTokenExchange(t);

  try {
    await withRouteChurchDb(async ({ churchId, app }) => {
      backgroundCheckSync.invalidateBackgroundCheckStatusCache(churchId);
      try {
        await seedPcoConnection(churchId);
        const backgroundRefresh = makeCredentialBoundBackgroundHarness(
          churchId,
          { pauseStoredFetch: true }
        );
        const oldRefresh = backgroundRefresh.refresh();
        await backgroundRefresh.waitForStoredFetch();

        const credentialWriteEntered = createDeferred();
        const credentialWriteRelease = createDeferred();
        const originalUpsertConnection = connectionStore.upsertConnection;
        t.mock.method(connectionStore, 'upsertConnection', async (input) => {
          if (input.credentials?.accessToken === 'replacement-access-token') {
            credentialWriteEntered.resolve();
            await credentialWriteRelease.promise;
          }
          return originalUpsertConnection(input);
        });

        const state = Buffer.from(JSON.stringify({
          redirectUri: 'http://localhost/api/integrations/planning-center/callback',
        })).toString('base64');
        const routeResponse = withPcoStatusStubs({
          validatePlanningCenterToken: async () => ({
            connected: true,
            accountName: 'Replacement Account',
          }),
        }, () => app.request(
          `/api/integrations/planning-center/callback?code=test-code&state=${encodeURIComponent(state)}`,
          { redirect: 'manual' }
        ));

        await credentialWriteEntered.promise;
        backgroundRefresh.releaseStoredFetch();
        await new Promise((resolve) => setImmediate(resolve));
        const appliesWhileCredentialTransactionHeld = [...backgroundRefresh.localApplies];
        credentialWriteRelease.resolve();

        const [refreshResult, response] = await Promise.all([oldRefresh, routeResponse]);
        assert.equal(response.status, 302);
        assert.match(response.location, /pco_success=true/);
        assert.equal(refreshResult.updated, 1);
        assert.deepEqual(appliesWhileCredentialTransactionHeld, []);
        assert.deepEqual(backgroundRefresh.providerReads, [
          'stored-access',
          'replacement-access-token',
        ]);
        assert.deepEqual(backgroundRefresh.localApplies, ['fresh-snapshot']);
      } finally {
        backgroundCheckSync.invalidateBackgroundCheckStatusCache(churchId);
      }
    });
  } finally {
    if (previousClientId === undefined) delete process.env.PLANNING_CENTER_CLIENT_ID;
    else process.env.PLANNING_CENTER_CLIENT_ID = previousClientId;
    if (previousClientSecret === undefined) delete process.env.PLANNING_CENTER_CLIENT_SECRET;
    else process.env.PLANNING_CENTER_CLIENT_SECRET = previousClientSecret;
  }
});

test('successful PCO disconnect invalidates the church background-check snapshot', async () => {
  await withRouteChurchDb(async ({ churchId, app }) => {
    backgroundCheckSync.invalidateBackgroundCheckStatusCache(churchId);
    try {
      await seedPcoConnection(churchId);
      const backgroundRefresh = makeBackgroundRefreshHarness(churchId);
      await backgroundRefresh.refresh();
      assert.equal(backgroundRefresh.providerReads(), 1);

      const response = await app.request('/api/integrations/planning-center/disconnect', {
        method: 'POST',
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.success, true);

      await backgroundRefresh.refresh();
      assert.equal(backgroundRefresh.providerReads(), 2);
    } finally {
      backgroundCheckSync.invalidateBackgroundCheckStatusCache(churchId);
    }
  });
});

test('PCO disconnect blocks a cached old snapshot after the credential deletion commits', async (t) => {
  await withRouteChurchDb(async ({ churchId, app }) => {
    backgroundCheckSync.invalidateBackgroundCheckStatusCache(churchId);
    try {
      await seedPcoConnection(churchId);
      const backgroundRefresh = makeCredentialBoundBackgroundHarness(churchId);
      await backgroundRefresh.refresh();
      assert.deepEqual(backgroundRefresh.localApplies, ['old-snapshot']);

      const credentialMutationEntered = createDeferred();
      const credentialMutationRelease = createDeferred();
      const originalRunTransaction = Database._runTransaction;
      let holdNextChurchTransaction = true;
      t.mock.method(Database, '_runTransaction', (db, callback, scopedChurchId) => {
        if (scopedChurchId === churchId && holdNextChurchTransaction) {
          holdNextChurchTransaction = false;
          return originalRunTransaction.call(Database, db, async (conn) => {
            credentialMutationEntered.resolve();
            await credentialMutationRelease.promise;
            return callback(conn);
          }, scopedChurchId);
        }
        return originalRunTransaction.call(Database, db, callback, scopedChurchId);
      });
      const routeResponse = app.request('/api/integrations/planning-center/disconnect', {
        method: 'POST',
      });
      await credentialMutationEntered.promise;

      const cachedRefresh = backgroundRefresh.refresh();
      const cachedOutcome = cachedRefresh.then(
        (value) => ({ status: 'fulfilled', value }),
        (error) => ({ status: 'rejected', error })
      );
      credentialMutationRelease.resolve();

      const response = await routeResponse;
      const outcome = await cachedOutcome;
      assert.equal(response.status, 200);
      assert.equal(response.body.success, true);
      assert.equal(outcome.status, 'rejected');
      assert.match(outcome.error.message, /Planning Center connection unavailable/);
      assert.deepEqual(backgroundRefresh.providerReads, ['stored-access']);
      assert.deepEqual(backgroundRefresh.localApplies, ['old-snapshot']);
    } finally {
      backgroundCheckSync.invalidateBackgroundCheckStatusCache(churchId);
    }
  });
});

test('PCO disconnect is blocked while Planning Center is the authority provider', async () => {
  // Catches a direct API request bypassing the panel's guarded Disconnect flow.
  await withRouteChurchDb(async ({ churchId, app }) => {
    await seedPcoConnection(churchId);
    await Database.query(
      `UPDATE people_sync_settings
          SET authority_provider = 'planning_center', pending_authority_provider = NULL
        WHERE church_id = ?`,
      [churchId]
    );

    const response = await app.request('/api/integrations/planning-center/disconnect', { method: 'POST' });
    assert.equal(response.status, 409);
    assert.match(response.body.error, /authoritative people source/i);
    assert.ok(await connectionStore.getConnection(churchId, 'planning_center'));
  });
});

test('PCO disconnect is blocked while Planning Center authority is pending review', async () => {
  // Catches deleting the credential after authority preview but before its
  // reviewed reconciliation is atomically applied and activated.
  await withRouteChurchDb(async ({ churchId, app }) => {
    await seedPcoConnection(churchId);
    await Database.query(
      `UPDATE people_sync_settings
          SET authority_provider = 'none', pending_authority_provider = 'planning_center'
        WHERE church_id = ?`,
      [churchId]
    );

    const response = await app.request('/api/integrations/planning-center/disconnect', { method: 'POST' });
    assert.equal(response.status, 409);
    assert.match(response.body.error, /authority|source/i);
    assert.ok(await connectionStore.getConnection(churchId, 'planning_center'));
  });
});
