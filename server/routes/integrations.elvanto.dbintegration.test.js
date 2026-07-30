'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');

process.env.INTEGRATION_CREDENTIALS_KEY = process.env.INTEGRATION_CREDENTIALS_KEY || Buffer.alloc(32, 19).toString('base64');

const connectionStore = require('../services/peopleSync/connectionStore');
const providerRegistry = require('../services/peopleSync/providerRegistry');
const integrationsRouter = require('./integrations');

const resolvedChurchIds = [];
providerRegistry.registerProvider('elvanto', {
  provider: 'elvanto',
  validateConnection: async () => ({ valid: true }),
  listSources: async ({ churchId, credentials }) => {
    resolvedChurchIds.push(churchId);
    return credentials.apiKey === 'elvanto-test-key'
      ? [{ kind: 'elvanto_category', externalId: 'cat-1', name: 'Members' }]
      : [];
  },
  fetchSourceSnapshot: async () => ({ provider: 'elvanto', complete: true, people: [], memberExternalIds: [] }),
  isLifecycleEligible: () => true,
});

async function withRouteChurchDb(run) {
  return withTestChurchDb(async () => {
    const churchId = `tst${Math.random().toString(36).slice(2, 12)}`;
    Database.getChurchDb(churchId);
    await Database.queryForChurch(
      churchId,
      `INSERT INTO church_settings (church_id, church_name) VALUES (?, 'Route Test Church')`,
      [churchId],
    );
    return Database.setChurchContext(churchId, () => run(churchId));
  });
}

async function startApp(churchId) {
  const user = await Database.query(
    `INSERT INTO users (email, role, first_name, last_name, is_active, church_id)
     VALUES (?, 'admin', 'Admin', 'User', 1, ?)`,
    [`elvanto-route-${Math.random().toString(36).slice(2)}@example.com`, churchId],
  );
  Database.getRegistryDb().prepare(
    `INSERT INTO churches (church_id, church_name, is_approved) VALUES (?, 'Route Test Church', 1)`,
  ).run(churchId);
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'elvanto-sync-route-test-secret';
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

test('Elvanto source POST persists the church-scoped provider name and rejects a client name', async () => {
  await withRouteChurchDb(async (churchId) => {
    await connectionStore.upsertConnection({
      churchId, provider: 'elvanto', authType: 'api_key', credentials: { apiKey: 'elvanto-test-key' },
    });
    const app = await startApp(churchId);
    try {
      const rejected = await app.request('/api/integrations/elvanto/sync-batches', {
        method: 'POST',
        body: { name: 'Client name', sourceKind: 'elvanto_category', sourceExternalId: 'cat-1' },
      });
      assert.equal(rejected.status, 400);
      assert.equal(rejected.body.error, 'Unknown batch field: name');

      const created = await app.request('/api/integrations/elvanto/sync-batches', {
        method: 'POST',
        body: { sourceKind: 'elvanto_category', sourceExternalId: 'cat-1' },
      });
      assert.equal(created.status, 200);
      assert.equal(created.body.batch.name, 'Members');
      assert.deepEqual(created.body.batch.draftSource, {
        kind: 'elvanto_category', externalId: 'cat-1', name: 'Members',
      });
      assert.deepEqual(resolvedChurchIds, [churchId]);
    } finally {
      await app.close();
    }
  });
});
