'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const pcoSync = require('../services/planningCenterSync');
const batchRepository = require('../services/peopleSync/batchRepository');
const connectionStore = require('../services/peopleSync/connectionStore');
const providerRegistry = require('../services/peopleSync/providerRegistry');
const integrationsRouter = require('./integrations');

process.env.INTEGRATION_CREDENTIALS_KEY = process.env.INTEGRATION_CREDENTIALS_KEY || Buffer.alloc(32, 11).toString('base64');
providerRegistry.registerProvider('planning_center', {
  provider: 'planning_center',
  validateConnection: async () => ({ valid: true }),
  listSources: async () => [{ kind: 'planning_center_list', externalId: 'list-1', name: 'Members' }],
  fetchSourceSnapshot: async () => ({ provider: 'planning_center', complete: true, people: [], memberExternalIds: [] }),
  isLifecycleEligible: () => true,
});

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

function settings() {
  return {
    defaultPeopleType: 'local_visitor', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
    scheduleEnabled: true, scheduleFrequency: 'monthly', scheduleDay: 15,
  };
}

function sourceCreateBody(overrides = {}) {
  return {
    ...settings(), sourceKind: 'planning_center_list', sourceExternalId: 'list-1',
    ...overrides,
  };
}

async function createSourceBatch(churchId) {
  return pcoSync.createBatch(churchId, {
    initialDraftSource: { kind: 'planning_center_list', externalId: 'list-1', name: 'Members' },
    defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
    scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1,
  });
}

test('PCO source-era PUT retains the trusted List name while updating settings without legacy compatibility rows', async () => {
  await withRouteChurchDb(async (churchId) => {
    const batch = await createSourceBatch(churchId);
    const app = await startApp(churchId);
    try {
      const response = await app.request(`/api/integrations/planning-center/sync-batches/${batch.id}`, { method: 'PUT', body: settings() });
      assert.equal(response.status, 200);
      assert.equal(response.body.batch.name, 'Members');
      const legacy = await Database.query('SELECT * FROM planning_center_sync_batches WHERE church_id = ?', [churchId]);
      assert.deepEqual(legacy, []);
    } finally {
      await app.close();
    }
  });
});

test('migrated legacy PCO history keeps prior scheduling separate from disabled operational settings', async () => {
  await withRouteChurchDb(async (churchId) => {
    const legacyRow = await Database.query(
      `INSERT INTO planning_center_sync_batches
        (church_id, name, membership_allowlist, field_filters, schedule_enabled, schedule_frequency, schedule_day)
       VALUES (?, 'Retired scheduled members', '[]', '[]', 1, 'monthly', 15)`,
      [churchId],
    );

    Database.closeChurchDb(churchId);
    Database.getChurchDb(churchId);
    const [migrated] = await Database.query(
      `SELECT id, enabled, schedule_enabled FROM people_sync_batches
       WHERE church_id = ? AND provider = 'planning_center' AND legacy_provider_batch_id = ?`,
      [churchId, legacyRow.insertId],
    );
    assert.deepEqual(
      { enabled: migrated.enabled, scheduleEnabled: migrated.schedule_enabled },
      { enabled: 0, scheduleEnabled: 0 },
    );

    const app = await startApp(churchId);
    try {
      const response = await app.request('/api/integrations/planning-center/sync-batches');
      assert.equal(response.status, 200);
      const retired = response.body.batches.find((candidate) => candidate.id === migrated.id);
      assert.deepEqual({
        scheduleEnabled: retired.scheduleEnabled,
        priorScheduleEnabled: retired.priorScheduleEnabled,
        priorScheduleFrequency: retired.priorScheduleFrequency,
        priorScheduleDay: retired.priorScheduleDay,
      }, {
        scheduleEnabled: false,
        priorScheduleEnabled: true,
        priorScheduleFrequency: 'monthly',
        priorScheduleDay: 15,
      });
    } finally {
      await app.close();
    }
  });
});

test('retired legacy PCO deletion survives restart without removing people, links, attendance, or gathering membership', async () => {
  await withRouteChurchDb(async (churchId) => {
    const legacyRow = await Database.query(
      `INSERT INTO planning_center_sync_batches (church_id, name, membership_allowlist, field_filters)
       VALUES (?, 'Retired legacy members', '[]', '[]')`,
      [churchId],
    );
    const batch = await batchRepository.createBatch({
      churchId, provider: 'planning_center', name: 'Retired legacy members',
      legacyProviderBatchId: legacyRow.insertId,
      initialDraftSource: { kind: 'planning_center_list', externalId: 'legacy-list', name: 'Legacy list' },
    });
    const gathering = await Database.query(
      `INSERT INTO gathering_types (church_id, name) VALUES (?, 'Legacy gathering')`, [churchId],
    );
    const person = await Database.query(
      `INSERT INTO individuals (church_id, first_name, last_name, people_type, is_active)
       VALUES (?, 'Retained', 'Person', 'regular', 1)`, [churchId],
    );
    const attendanceUser = await Database.query(
      `INSERT INTO users (church_id, email, role, first_name, last_name, is_active)
       VALUES (?, ?, 'admin', 'Attendance', 'Recorder', 1)`,
      [churchId, `retention-${Math.random().toString(36).slice(2)}@example.com`],
    );
    await Database.query(
      `INSERT INTO external_person_links
        (church_id, provider, external_person_id, individual_id, link_source)
       VALUES (?, 'planning_center', 'retained-pco-person', ?, 'legacy_backfill')`,
      [churchId, person.insertId],
    );
    const session = await Database.query(
      `INSERT INTO attendance_sessions
        (church_id, gathering_type_id, session_date, created_by)
       VALUES (?, ?, '2026-07-20', ?)`,
      [churchId, gathering.insertId, attendanceUser.insertId],
    );
    await Database.query(
      `INSERT INTO attendance_records
        (church_id, session_id, individual_id, present, people_type_at_time)
       VALUES (?, ?, ?, 1, 'regular')`,
      [churchId, session.insertId, person.insertId],
    );
    await Database.query(
      `INSERT INTO gathering_lists
        (church_id, gathering_type_id, individual_id, added_by_sync_batch_id, added_by_pco_batch_id)
       VALUES (?, ?, ?, ?, ?)`,
      [churchId, gathering.insertId, person.insertId, batch.id, legacyRow.insertId],
    );
    const app = await startApp(churchId);
    try {
      const put = await app.request(`/api/integrations/planning-center/sync-batches/${batch.id}`, {
        method: 'PUT', body: { ...settings(), name: 'Stale pre-deployment editor name' },
      });
      assert.equal(put.status, 409);
      assert.deepEqual(put.body, {
        error: 'This legacy Planning Center batch is retired and can only be viewed or deleted.',
        code: 'PCO_LEGACY_BATCH_RETIRED',
      });

      const remove = await app.request(`/api/integrations/planning-center/sync-batches/${batch.id}`, { method: 'DELETE' });
      assert.equal(remove.status, 200);
      assert.equal((await Database.query(
        'SELECT id FROM people_sync_batches WHERE id = ? AND church_id = ?', [batch.id, churchId],
      )).length, 0);
      assert.equal((await Database.query(
        'SELECT id FROM planning_center_sync_batches WHERE id = ? AND church_id = ?', [legacyRow.insertId, churchId],
      )).length, 0);
    } finally {
      await app.close();
    }

    Database.closeChurchDb(churchId);
    Database.getChurchDb(churchId);
    assert.equal((await Database.query(
      'SELECT id FROM people_sync_batches WHERE id = ? AND church_id = ?', [batch.id, churchId],
    )).length, 0, 'deleted canonical batch must not be backfilled on restart');
    assert.equal((await Database.query(
      'SELECT id FROM planning_center_sync_batches WHERE id = ? AND church_id = ?', [legacyRow.insertId, churchId],
    )).length, 0, 'deleted compatibility row must remain absent on restart');
    assert.equal((await Database.query(
      'SELECT id FROM individuals WHERE id = ? AND church_id = ?', [person.insertId, churchId],
    )).length, 1);
    assert.equal((await Database.query(
      `SELECT id FROM external_person_links
       WHERE church_id = ? AND provider = 'planning_center' AND external_person_id = ? AND individual_id = ?`,
      [churchId, 'retained-pco-person', person.insertId],
    )).length, 1);
    assert.equal((await Database.query(
      `SELECT id FROM attendance_records
       WHERE church_id = ? AND session_id = ? AND individual_id = ? AND present = 1`,
      [churchId, session.insertId, person.insertId],
    )).length, 1);
    const [membership] = await Database.query(
      `SELECT id, added_by_sync_batch_id, added_by_pco_batch_id FROM gathering_lists
       WHERE church_id = ? AND gathering_type_id = ? AND individual_id = ?`,
      [churchId, gathering.insertId, person.insertId],
    );
    assert.ok(membership);
    assert.equal(membership.added_by_sync_batch_id, null);
    assert.equal(membership.added_by_pco_batch_id, null);
  });
});

test('PCO source POST rejects invalid schedule ranges, unsafe gathering IDs, client names, unknown fields, and wrong field types', async () => {
  await withRouteChurchDb(async (churchId) => {
    const app = await startApp(churchId);
    try {
      const invalidBodies = [
        sourceCreateBody({ scheduleFrequency: 'weekly', scheduleDay: 7 }),
        sourceCreateBody({ scheduleFrequency: 'monthly', scheduleDay: 0 }),
        sourceCreateBody({ gatheringTypeId: 0 }),
        sourceCreateBody({ gatheringTypeId: -1 }),
        sourceCreateBody({ gatheringTypeId: Number.MAX_SAFE_INTEGER + 1 }),
        sourceCreateBody({ gatheringTypeId: 1.5 }),
        sourceCreateBody({ gatheringAutoRemoveEnabled: 'false' }),
        sourceCreateBody({ name: 'Client override' }),
        { ...sourceCreateBody(), unexpected: true },
        { ...sourceCreateBody(), unexpectedNestedRule: { branches: [] } },
      ];
      for (const body of invalidBodies) {
        const response = await app.request('/api/integrations/planning-center/sync-batches', { method: 'POST', body });
        assert.equal(response.status, 400, JSON.stringify(body));
      }
      assert.equal((await pcoSync.listBatches(churchId)).length, 0);
    } finally {
      await app.close();
    }
  });
});

test('PCO source POST derives the batch name from the server-resolved List', async () => {
  await withRouteChurchDb(async (churchId) => {
    await connectionStore.upsertConnection({
      churchId, provider: 'planning_center', authType: 'oauth', credentials: { accessToken: 'test-token' },
    });
    const app = await startApp(churchId);
    try {
      const response = await app.request('/api/integrations/planning-center/sync-batches', {
        method: 'POST', body: sourceCreateBody(),
      });

      assert.equal(response.status, 200);
      assert.equal(response.body.batch.name, 'Members');
      assert.equal(response.body.batch.draftSource.name, 'Members');
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
        method: 'POST', body: sourceCreateBody({ scheduleFrequency: 'weekly', scheduleDay: 0, gatheringTypeId: null }),
      });
      const monthly = await app.request('/api/integrations/planning-center/sync-batches', {
        method: 'POST', body: sourceCreateBody({ scheduleFrequency: 'monthly', scheduleDay: 31, gatheringTypeId: gathering.insertId }),
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

test('PCO source-era PUT rejects malformed and unknown input', async () => {
  await withRouteChurchDb(async (churchId) => {
    const batch = await createSourceBatch(churchId);
    const app = await startApp(churchId);
    try {
      const malformed = await app.request(`/api/integrations/planning-center/sync-batches/${batch.id}`, {
        method: 'PUT', body: { ...settings(), scheduleDay: '15' },
      });
      assert.equal(malformed.status, 400);
      const smuggled = await app.request(`/api/integrations/planning-center/sync-batches/${batch.id}`, {
        method: 'PUT', body: { ...settings(), name: 'Client override' },
      });
      assert.equal(smuggled.status, 400);
      assert.match(smuggled.body.error, /only change batch settings/i);
      const unchanged = await pcoSync.getBatch(churchId, batch.id);
      assert.equal(unchanged.name, 'Members');
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

test('PCO source-era PUT rejects unknown payloads and scopes missing batches to the church', async () => {
  await withRouteChurchDb(async (churchId) => {
    const batch = await pcoSync.createBatch(churchId, {
      initialDraftSource: { kind: 'planning_center_list', externalId: 'list-1', name: 'Members' },
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
        initialDraftSource: { kind: 'planning_center_list', externalId: `list-${index}`, name: 'Members' },
        defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
        scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1,
      });
    }
    const app = await startApp(churchId);
    try {
      const updated = await app.request(`/api/integrations/planning-center/sync-batches/${batch.id}`, {
        method: 'PUT',
        body: { ...settings(), name: 'Client override' },
      });
      assert.equal(updated.status, 400);
      assert.match(updated.body.error, /only change batch settings/i);
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
      initialDraftSource: { kind: 'planning_center_list', externalId: 'list-1', name: 'Members' },
      defaultPeopleType: 'regular', gatheringTypeId: gathering.insertId, gatheringAutoRemoveEnabled: false,
      scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1,
    });
    const originalGetAccessToken = pcoSync.getAccessTokenForChurch;
    let rosterFetches = 0;
    pcoSync.getAccessTokenForChurch = async () => { rosterFetches += 1; return 'must-not-fetch'; };
    const app = await startApp(churchId);
    try {
      const response = await app.request(`/api/integrations/planning-center/sync-batches/${batch.id}`, {
        method: 'PUT', body: { ...settings(), gatheringTypeId: gathering.insertId, gatheringAutoRemoveEnabled: true },
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
