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
const integrationsRouter = require('./integrations');

const TEST_SECRET = 'pco-checkin-route-test-secret';

async function withCredentialKey(run) {
  const previous = process.env.INTEGRATION_CREDENTIALS_KEY;
  process.env.INTEGRATION_CREDENTIALS_KEY = Buffer.alloc(32, 29).toString('base64');
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.INTEGRATION_CREDENTIALS_KEY;
    else process.env.INTEGRATION_CREDENTIALS_KEY = previous;
  }
}

// withTestChurchDb's generated id contains two underscores and is rejected by
// ensureChurchIsolation. Create a second database in the same disposable data
// directory with a production-valid church id, matching the existing real-route
// integrations test harnesses.
async function withRouteChurchDb(run) {
  return withCredentialKey(() => withTestChurchDb(async () => {
    const churchId = `tst${Math.random().toString(36).slice(2, 12)}`;
    Database.getChurchDb(churchId);
    await Database.queryForChurch(
      churchId,
      `INSERT INTO church_settings (church_id, church_name)
       VALUES (?, 'PCO Check-in Route Test')`,
      [churchId],
    );
    return Database.setChurchContext(churchId, () => run(churchId));
  }));
}

async function startApp(churchId) {
  const user = await Database.query(
    `INSERT INTO users (email, role, first_name, last_name, is_active, church_id)
     VALUES (?, 'admin', 'PCO', 'Admin', 1, ?)`,
    [`pco-checkins-${Math.random().toString(36).slice(2)}@example.com`, churchId],
  );
  const userId = Number(user.insertId);
  Database.getRegistryDb().prepare(
    `INSERT INTO churches (church_id, church_name, is_approved)
     VALUES (?, 'PCO Check-in Route Test', 1)`,
  ).run(churchId);

  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = TEST_SECRET;
  const token = jwt.sign({ userId, churchId }, TEST_SECRET);
  const app = express();
  app.use(express.json());
  app.use('/api/integrations', integrationsRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    userId,
    async request(path, body) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
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

function checkinPayload({ checkinId, periodId, date }) {
  return {
    data: [{
      type: 'CheckIn',
      id: checkinId,
      attributes: { created_at: `${date}T12:00:00Z` },
      relationships: {
        event: { data: { type: 'Event', id: 'event-1' } },
        person: { data: { type: 'Person', id: 'pco-person-1' } },
        event_period: { data: { type: 'EventPeriod', id: periodId } },
        event_times: { data: [] },
      },
    }],
    included: [
      { type: 'Event', id: 'event-1', attributes: { name: 'Sunday gathering' } },
      {
        type: 'Person',
        id: 'pco-person-1',
        attributes: { first_name: 'Linked', last_name: 'Person' },
      },
      {
        type: 'EventPeriod',
        id: periodId,
        attributes: { starts_at: `${date}T10:00:00+10:00` },
      },
    ],
    meta: { total_count: 1 },
  };
}

function mockCheckinsResponse(t, payloadForRequest) {
  t.mock.method(https, 'request', (options, callback) => {
    if (options.hostname !== 'api.planningcenteronline.com'
        || !options.path.startsWith('/check-ins/v2/check_ins?')) {
      throw new Error(`Unexpected Planning Center request: ${options.hostname}${options.path}`);
    }
    if (options.headers?.Authorization !== 'Bearer fresh-access') {
      throw new Error('Check-in import did not use the stored Planning Center access token');
    }

    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.write = () => true;
    request.destroy = (error) => request.emit('error', error);
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-type': 'application/json' };
      callback(response);
      queueMicrotask(() => {
        response.emit('data', JSON.stringify(payloadForRequest()));
        response.emit('end');
      });
    };
    return request;
  });
}

test('real PCO check-in route holds present-only imports and rejects cancelled-session writes', async (t) => {
  await withRouteChurchDb(async (churchId) => {
    const app = await startApp(churchId);
    const successfulDate = '2026-08-02';
    const cancelledDate = '2026-08-09';
    let providerPayload = checkinPayload({
      checkinId: 'checkin-success',
      periodId: 'period-success',
      date: successfulDate,
    });
    mockCheckinsResponse(t, () => providerPayload);

    try {
      await connectionStore.upsertConnection({
        churchId,
        provider: 'planning_center',
        authType: 'oauth',
        credentials: {
          accessToken: 'fresh-access',
          refreshToken: 'fresh-refresh',
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        },
        connectedBy: app.userId,
      });
      const gathering = await Database.query(
        `INSERT INTO gathering_types (name, attendance_type, created_by, church_id)
         VALUES ('Sunday gathering', 'standard', ?, ?)`,
        [app.userId, churchId],
      );
      const gatheringTypeId = Number(gathering.insertId);
      const person = await Database.query(
        `INSERT INTO individuals
           (first_name, last_name, people_type, is_active, planning_center_id, created_by, church_id)
         VALUES ('Linked', 'Person', 'regular', 1, 'pco-person-1', ?, ?)`,
        [app.userId, churchId],
      );
      const individualId = Number(person.insertId);
      const mappings = [{
        pcoEventId: 'event-1',
        target: 'existing',
        gatheringTypeId,
      }];

      const imported = await app.request(
        '/api/integrations/planning-center/import-checkins/execute',
        { startDate: successfulDate, endDate: successfulDate, mappings },
      );
      assert.equal(imported.status, 200);
      assert.equal(imported.body.success, true);
      assert.equal(imported.body.sessionsCreated, 1);
      assert.equal(imported.body.recordsWritten, 1);

      const [heldSession] = await Database.query(
        `SELECT id, session_status, roster_snapshotted, roster_provenance_version
         FROM attendance_sessions
         WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?`,
        [gatheringTypeId, successfulDate, churchId],
      );
      assert.deepEqual({
        sessionStatus: heldSession.session_status,
        rosterSnapshotted: heldSession.roster_snapshotted,
        rosterProvenanceVersion: heldSession.roster_provenance_version,
      }, {
        sessionStatus: 'held',
        rosterSnapshotted: 0,
        rosterProvenanceVersion: 0,
      });
      assert.deepEqual(await Database.query(
        `SELECT present, people_type_at_time, eligible_at_snapshot
         FROM attendance_records
         WHERE session_id = ? AND individual_id = ? AND church_id = ?`,
        [heldSession.id, individualId, churchId],
      ), [{ present: 1, people_type_at_time: 'regular', eligible_at_snapshot: 0 }]);
      assert.deepEqual(await Database.query(
        `SELECT last_attendance_date FROM individuals WHERE id = ? AND church_id = ?`,
        [individualId, churchId],
      ), [{ last_attendance_date: successfulDate }]);

      const cancelled = await Database.query(
        `INSERT INTO attendance_sessions
           (gathering_type_id, session_date, created_by, session_status,
            cancelled_at, cancelled_by, church_id)
         VALUES (?, ?, ?, 'cancelled', datetime('now'), ?, ?)`,
        [gatheringTypeId, cancelledDate, app.userId, app.userId, churchId],
      );
      providerPayload = checkinPayload({
        checkinId: 'checkin-cancelled',
        periodId: 'period-cancelled',
        date: cancelledDate,
      });

      const rejected = await app.request(
        '/api/integrations/planning-center/import-checkins/execute',
        { startDate: cancelledDate, endDate: cancelledDate, mappings },
      );
      assert.equal(rejected.status, 409);
      assert.equal(rejected.body.success, false);
      assert.equal(rejected.body.code, 'PCO_CHECKIN_SESSION_CANCELLED');
      const [cancelledSession] = await Database.query(
        `SELECT session_status, cancelled_at, cancelled_by
         FROM attendance_sessions WHERE id = ? AND church_id = ?`,
        [cancelled.insertId, churchId],
      );
      assert.equal(cancelledSession.session_status, 'cancelled');
      assert.equal(cancelledSession.cancelled_by, app.userId);
      assert.equal(typeof cancelledSession.cancelled_at, 'string');
      assert.ok(cancelledSession.cancelled_at.length > 0);
      assert.deepEqual(await Database.query(
        `SELECT id FROM attendance_records WHERE session_id = ? AND church_id = ?`,
        [cancelled.insertId, churchId],
      ), []);
      assert.deepEqual(await Database.query(
        `SELECT last_attendance_date FROM individuals WHERE id = ? AND church_id = ?`,
        [individualId, churchId],
      ), [{ last_attendance_date: successfulDate }]);

      const [settings] = await Database.query(
        `SELECT planning_center_checkin_import_state AS state
         FROM church_settings WHERE church_id = ?`,
        [churchId],
      );
      const checkpoint = JSON.parse(settings.state);
      assert.equal(checkpoint.lastRange.startDate, successfulDate);
      assert.equal(checkpoint.lastRange.endDate, successfulDate);
      assert.equal(checkpoint.imported['event-1'].lastImportedDate, successfulDate);
    } finally {
      await app.close();
    }
  });
});
