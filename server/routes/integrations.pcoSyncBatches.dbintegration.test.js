'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const pcoSync = require('../services/planningCenterSync');
const filterFactsCache = require('../services/peopleSync/filterFactsCache');
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

function schema2CreateBody(name, overrides = {}) {
  return {
    ...settings(name), filterSchemaVersion: 2,
    draftFilterConfig: { branches: [{ groups: [{ dimensionId: 'membership', mode: 'any', values: ['Member'] }] }], exclusions: [] },
    broadMatchAcknowledged: false,
    ...overrides,
  };
}

function seedPcoFilterCache(churchId) {
  filterFactsCache.putComplete({
    churchId, provider: 'planning_center', mode: 'full', complete: true,
    coveredDimensionIds: ['membership'], populationGateDigest: 'gate', facts: [],
    dimensions: [{ id: 'membership', label: 'Membership', category: 'People', cardinality: 'single', values: [{ id: 'Member', label: 'Member', count: 0 }] }],
  });
}

async function createSchema2Batch(churchId) {
  const draft = { branches: [{ groups: [{ dimensionId: 'membership', mode: 'any', values: ['Member'] }] }], exclusions: [] };
  filterFactsCache.putComplete({
    churchId, provider: 'planning_center', mode: 'full', complete: true,
    coveredDimensionIds: ['membership'], populationGateDigest: 'gate', facts: [],
    dimensions: [{ id: 'membership', cardinality: 'single', values: [{ id: 'Member' }] }],
  });
  return pcoSync.createBatch(churchId, {
    name: 'Reviewed members', filterSchemaVersion: 2, draftFilterConfig: draft, broadMatchAcknowledged: false,
    defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
    scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1,
  });
}

test('PCO schema-2 PUT accepts settings only and preserves compatibility criteria', async () => {
  await withRouteChurchDb(async (churchId) => {
    const batch = await createSchema2Batch(churchId);
    await Database.query(
      `UPDATE planning_center_sync_batches
          SET membership_filter_enabled = 1, membership_allowlist = ?, field_filter_enabled = 1, field_filters = ?
        WHERE id = ? AND church_id = ?`,
      [JSON.stringify(['Legacy members']), JSON.stringify([{ fieldDefinitionId: 'status', tabName: 'Profile', fieldName: 'Status', values: ['Member'] }]), batch.legacyProviderBatchId, churchId]
    );
    const app = await startApp(churchId);
    try {
      const response = await app.request(`/api/integrations/planning-center/sync-batches/${batch.id}`, { method: 'PUT', body: settings('Renamed members') });
      assert.equal(response.status, 200);
      assert.equal(response.body.batch.name, 'Renamed members');
      const legacy = await Database.query(
        `SELECT membership_filter_enabled, membership_allowlist, field_filter_enabled, field_filters, default_people_type
           FROM planning_center_sync_batches WHERE id = ? AND church_id = ?`, [batch.legacyProviderBatchId, churchId]
      );
      assert.equal(legacy[0].membership_filter_enabled, 1);
      assert.equal(legacy[0].membership_allowlist, JSON.stringify(['Legacy members']));
      assert.equal(legacy[0].field_filter_enabled, 1);
      assert.equal(legacy[0].default_people_type, 'local_visitor');
    } finally {
      await app.close();
    }
  });
});

test('PCO schema-2 POST rejects invalid schedule ranges, unsafe gathering IDs, unknown fields, and wrong field types', async () => {
  await withRouteChurchDb(async (churchId) => {
    seedPcoFilterCache(churchId);
    const app = await startApp(churchId);
    try {
      const invalidBodies = [
        schema2CreateBody('Weekly 7', { scheduleFrequency: 'weekly', scheduleDay: 7 }),
        schema2CreateBody('Monthly 0', { scheduleFrequency: 'monthly', scheduleDay: 0 }),
        schema2CreateBody('Zero gathering', { gatheringTypeId: 0 }),
        schema2CreateBody('Negative gathering', { gatheringTypeId: -1 }),
        schema2CreateBody('Unsafe gathering', { gatheringTypeId: Number.MAX_SAFE_INTEGER + 1 }),
        schema2CreateBody('Fraction gathering', { gatheringTypeId: 1.5 }),
        schema2CreateBody('Wrong auto remove', { gatheringAutoRemoveEnabled: 'false' }),
        { ...schema2CreateBody('Unknown'), unexpected: true },
        { ...schema2CreateBody('Smuggled'), filterConfig: { branches: [], exclusions: [] } },
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

test('PCO schema-2 POST accepts weekly/monthly boundaries and positive safe gathering IDs', async () => {
  await withRouteChurchDb(async (churchId) => {
    seedPcoFilterCache(churchId);
    const gathering = await Database.query('INSERT INTO gathering_types (church_id, name) VALUES (?, ?)', [churchId, 'Monthly gathering']);
    const app = await startApp(churchId);
    try {
      const weekly = await app.request('/api/integrations/planning-center/sync-batches', {
        method: 'POST', body: schema2CreateBody('Weekly boundary', { scheduleFrequency: 'weekly', scheduleDay: 0, gatheringTypeId: null }),
      });
      const monthly = await app.request('/api/integrations/planning-center/sync-batches', {
        method: 'POST', body: schema2CreateBody('Monthly boundary', { scheduleFrequency: 'monthly', scheduleDay: 31, gatheringTypeId: gathering.insertId }),
      });
      assert.equal(weekly.status, 200);
      assert.equal(monthly.status, 200);
      assert.equal(weekly.body.batch.scheduleDay, 0);
      assert.equal(monthly.body.batch.scheduleDay, 31);
      assert.equal(monthly.body.batch.gatheringTypeId, gathering.insertId);
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

test('PCO schema-2 PUT rejects malformed and smuggled active filter input', async () => {
  await withRouteChurchDb(async (churchId) => {
    const batch = await createSchema2Batch(churchId);
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
      assert.match(smuggled.body.error, /filter draft endpoint/i);
      const unchanged = await pcoSync.getBatch(churchId, batch.id);
      assert.equal(unchanged.name, 'Reviewed members');
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

test('PCO schema-1 PUT retains legacy body support and scopes missing batches to the church', async () => {
  await withRouteChurchDb(async (churchId) => {
    const legacy = await pcoSync.createBatch(churchId, {
      name: 'Legacy members', membershipFilterEnabled: false, membershipAllowlist: [], fieldFilterEnabled: false, fieldFilters: [],
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
        name: `Other ${index}`, membershipFilterEnabled: false, membershipAllowlist: [], fieldFilterEnabled: false, fieldFilters: [],
        defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
        scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1,
      });
    }
    const app = await startApp(churchId);
    try {
      const updated = await app.request(`/api/integrations/planning-center/sync-batches/${legacy.id}`, {
        method: 'PUT',
        body: { ...settings('Legacy updated'), filterSchemaVersion: 1, membershipFilterEnabled: true, membershipAllowlist: ['Members'], fieldFilterEnabled: false, fieldFilters: [] },
      });
      assert.equal(updated.status, 200);
      assert.deepEqual(updated.body.batch.membershipAllowlist, ['Members']);
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
