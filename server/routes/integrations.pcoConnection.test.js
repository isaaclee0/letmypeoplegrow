'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const connectionStore = require('../services/peopleSync/connectionStore');
const pcoSync = require('../services/planningCenterSync');
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
      return { status: response.status, body: await response.json() };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
    },
  };
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
