'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const pcoSync = require('../services/planningCenterSync');
const integrationsRouter = require('./integrations');

async function withRouteChurchDb(run) {
  return withTestChurchDb(async () => {
    const churchId = `tst${Math.random().toString(36).slice(2, 12)}`;
    Database.getChurchDb(churchId);
    await Database.queryForChurch(churchId,
      `INSERT INTO church_settings (church_id, church_name) VALUES (?, 'Route Test Church')`, [churchId]);
    return Database.setChurchContext(churchId, () => run(churchId));
  });
}

async function startApp(churchId) {
  const user = await Database.query(
    `INSERT INTO users (email, role, first_name, last_name, is_active, church_id)
     VALUES (?, 'admin', 'Admin', 'User', 1, ?)`,
    [`pco-route-${Math.random().toString(36).slice(2)}@example.com`, churchId]
  );
  Database.getRegistryDb().prepare(
    `INSERT INTO churches (church_id, church_name, is_approved) VALUES (?, 'Route Test Church', 1)`
  ).run(churchId);
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'pco-sync-route-test-secret';
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

function settings(name) {
  return {
    name, defaultPeopleType: 'local_visitor', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
    scheduleEnabled: true, scheduleFrequency: 'monthly', scheduleDay: 15,
  };
}

function sourceCreateBody(name, overrides = {}) {
  return {
    ...settings(name), sourceKind: 'planning_center_list', sourceExternalId: 'list-1',
    ...overrides,
  };
}

async function createSourceBatch(churchId) {
  return pcoSync.createBatch(churchId, {
    name: 'Source members', initialDraftSource: { kind: 'planning_center_list', externalId: 'list-1', name: 'Members' },
    defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
    scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1,
  });
}

test('PCO source-era PUT accepts settings only and never creates legacy compatibility rows', async () => {
  await withRouteChurchDb(async (churchId) => {
    const batch = await createSourceBatch(churchId);
    const app = await startApp(churchId);
    try {
      const response = await app.request(`/api/integrations/planning-center/sync-batches/${batch.id}`, { method: 'PUT', body: settings('Renamed members') });
      assert.equal(response.status, 200);
      assert.equal(response.body.batch.name, 'Renamed members');
      const legacy = await Database.query('SELECT * FROM planning_center_sync_batches WHERE church_id = ?', [churchId]);
      assert.deepEqual(legacy, []);
    } finally {
      await app.close();
    }
  });
});

test('PCO source POST rejects invalid schedule ranges, unsafe gathering IDs, unknown fields, wrong field types, and filter fields', async () => {
  await withRouteChurchDb(async (churchId) => {
    const app = await startApp(churchId);
    try {
      const invalidBodies = [
        sourceCreateBody('Weekly 7', { scheduleFrequency: 'weekly', scheduleDay: 7 }),
        sourceCreateBody('Monthly 0', { scheduleFrequency: 'monthly', scheduleDay: 0 }),
        sourceCreateBody('Zero gathering', { gatheringTypeId: 0 }),
        sourceCreateBody('Negative gathering', { gatheringTypeId: -1 }),
        sourceCreateBody('Unsafe gathering', { gatheringTypeId: Number.MAX_SAFE_INTEGER + 1 }),
        sourceCreateBody('Fraction gathering', { gatheringTypeId: 1.5 }),
        sourceCreateBody('Wrong auto remove', { gatheringAutoRemoveEnabled: 'false' }),
        { ...sourceCreateBody('Unknown'), unexpected: true },
        { ...sourceCreateBody('Smuggled'), filterConfig: { branches: [], exclusions: [] } },
      ];
      for (const body of invalidBodies) {
        const response = await app.request('/api/integrations/planning-center/sync-batches', { method: 'POST', body });
        assert.equal(response.status, 400, body.name);
      }
      assert.equal((await pcoSync.listBatches(churchId)).length, 0);
    } finally {
      await app.close();
    }
  });
});

test('PCO source POST accepts valid boundaries before server-side source resolution', async () => {
  await withRouteChurchDb(async (churchId) => {
    const gathering = await Database.query('INSERT INTO gathering_types (church_id, name) VALUES (?, ?)', [churchId, 'Monthly gathering']);
    const app = await startApp(churchId);
    try {
      const weekly = await app.request('/api/integrations/planning-center/sync-batches', {
        method: 'POST', body: sourceCreateBody('Weekly boundary', { scheduleFrequency: 'weekly', scheduleDay: 0, gatheringTypeId: null }),
      });
      const monthly = await app.request('/api/integrations/planning-center/sync-batches', {
        method: 'POST', body: sourceCreateBody('Monthly boundary', { scheduleFrequency: 'monthly', scheduleDay: 31, gatheringTypeId: gathering.insertId }),
      });
      assert.equal(weekly.status, 409);
      assert.equal(monthly.status, 409);
    } finally {
      await app.close();
    }
  });
});

test('PCO DELETE rejects unsafe batch identifiers before repository lookup', async () => {
  await withRouteChurchDb(async (churchId) => {
    const app = await startApp(churchId);
    try {
      for (const id of ['nope', '0', '-1', '1.5', '9007199254740992', '1e309']) {
        const response = await app.request(`/api/integrations/planning-center/sync-batches/${id}`, { method: 'DELETE' });
        assert.equal(response.status, 400, id);
      }
    } finally {
      await app.close();
    }
  });
});

test('PCO source-era PUT rejects malformed and smuggled filter input', async () => {
  await withRouteChurchDb(async (churchId) => {
    const batch = await createSourceBatch(churchId);
    const app = await startApp(churchId);
    try {
      const malformed = await app.request(`/api/integrations/planning-center/sync-batches/${batch.id}`, {
        method: 'PUT', body: { ...settings('Bad schedule'), scheduleDay: '15' },
      });
      assert.equal(malformed.status, 400);
      const smuggled = await app.request(`/api/integrations/planning-center/sync-batches/${batch.id}`, {
        method: 'PUT', body: { ...settings('Smuggled'), filterConfig: { branches: [], exclusions: [] } },
      });
      assert.equal(smuggled.status, 400);
      assert.match(smuggled.body.error, /filter criteria must not/i);
      const unchanged = await pcoSync.getBatch(churchId, batch.id);
      assert.equal(unchanged.name, 'Source members');
    } finally {
      await app.close();
    }
  });
});

test('PCO PUT rejects malformed batch identifiers before database lookup', async () => {
  await withRouteChurchDb(async (churchId) => {
    const app = await startApp(churchId);
    try {
      for (const id of ['nope', '0', '-1', '1.5', '9007199254740992', '1e309']) {
        const response = await app.request(`/api/integrations/planning-center/sync-batches/${id}`, { method: 'PUT', body: {} });
        assert.equal(response.status, 400, id);
        assert.deepEqual(response.body, { error: 'Invalid sync batch id.' }, id);
      }
    } finally {
      await app.close();
    }
  });
});

test('PCO source-era PUT rejects filter payloads and scopes missing batches to the church', async () => {
  await withRouteChurchDb(async (churchId) => {
    const batch = await pcoSync.createBatch(churchId, {
      name: 'Source members', initialDraftSource: { kind: 'planning_center_list', externalId: 'list-1', name: 'Members' },
      defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
      scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1,
    });
    const otherChurchId = `tst${Math.random().toString(36).slice(2, 12)}`;
    Database.getChurchDb(otherChurchId);
    await Database.queryForChurch(otherChurchId,
      `INSERT INTO church_settings (church_id, church_name) VALUES (?, 'Other Church')`, [otherChurchId]);
    // Create three rows so this target id does not exist in the authenticated church.
    let otherBatch;
    for (let index = 0; index < 3; index += 1) {
      otherBatch = await pcoSync.createBatch(otherChurchId, {
        name: `Other ${index}`, initialDraftSource: { kind: 'planning_center_list', externalId: `list-${index}`, name: 'Members' },
        defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
        scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1,
      });
    }
    const app = await startApp(churchId);
    try {
      const updated = await app.request(`/api/integrations/planning-center/sync-batches/${batch.id}`, {
        method: 'PUT',
        body: { ...settings('Legacy updated'), filterSchemaVersion: 1, membershipFilterEnabled: true, membershipAllowlist: ['Members'], fieldFilterEnabled: false, fieldFilters: [] },
      });
      assert.equal(updated.status, 400);
      assert.match(updated.body.error, /filter criteria must not/i);
      const missing = await app.request('/api/integrations/planning-center/sync-batches/999', { method: 'PUT', body: {} });
      assert.equal(missing.status, 404);
      const crossChurch = await app.request(`/api/integrations/planning-center/sync-batches/${otherBatch.id}`, { method: 'PUT', body: {} });
      assert.equal(crossChurch.status, 404);
      assert.deepEqual(crossChurch.body, missing.body);
    } finally {
      await app.close();
    }
  });
});

test('PCO source-era settings update never fetches a roster or claims existing gathering ownership', async () => {
  await withRouteChurchDb(async (churchId) => {
    const gathering = await Database.query('INSERT INTO gathering_types (church_id, name) VALUES (?, ?)', [churchId, 'Sunday']);
    const batch = await pcoSync.createBatch(churchId, {
      name: 'Source batch', initialDraftSource: { kind: 'planning_center_list', externalId: 'list-1', name: 'Members' },
      defaultPeopleType: 'regular', gatheringTypeId: gathering.insertId, gatheringAutoRemoveEnabled: false,
      scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1,
    });
    const originalGetAccessToken = pcoSync.getAccessTokenForChurch;
    let rosterFetches = 0;
    pcoSync.getAccessTokenForChurch = async () => { rosterFetches += 1; return 'must-not-fetch'; };
    const app = await startApp(churchId);
    try {
      const response = await app.request(`/api/integrations/planning-center/sync-batches/${batch.id}`, {
        method: 'PUT', body: { ...settings('Updated source batch'), gatheringTypeId: gathering.insertId, gatheringAutoRemoveEnabled: true },
      });
      assert.equal(response.status, 200);
      assert.equal(rosterFetches, 0);
      const owned = await Database.query(
        'SELECT id FROM gathering_lists WHERE gathering_type_id = ? AND added_by_sync_batch_id = ?', [gathering.insertId, batch.id]
      );
      assert.deepEqual(owned, []);
    } finally {
      pcoSync.getAccessTokenForChurch = originalGetAccessToken;
      await app.close();
    }
  });
});
