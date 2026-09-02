const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const attendanceRouter = require('./attendance');

const TEST_SECRET = 'attendance-session-state-route-test';

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/attendance', attendanceRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
}

async function requestState(baseUrl, token, body) {
  const response = await fetch(`${baseUrl}/api/attendance/sessions/state`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function requestExclusion(baseUrl, token, body) {
  const response = await fetch(`${baseUrl}/api/attendance/sessions/exclusion`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function requestJson(baseUrl, token, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test('session state route enforces permissions, validation, church isolation, and activity conflicts', async () => {
  await withTestChurchDb(async (churchId) => {
    Database.getRegistryDb().prepare(
      `INSERT INTO churches (church_id, church_name, is_approved)
       VALUES (?, 'Session State Test', 1)`,
    ).run(churchId);

    const users = {};
    for (const role of ['admin', 'coordinator', 'attendance_taker']) {
      const result = await Database.query(
        `INSERT INTO users (email, role, first_name, last_name, is_active, church_id)
         VALUES (?, ?, ?, 'User', 1, ?)`,
        [`${role}@session-state.test`, role, role, churchId],
      );
      users[role] = result.insertId;
    }

    const standard = await Database.query(
      `INSERT INTO gathering_types (name, attendance_type, church_id)
       VALUES ('Standard', 'standard', ?)`,
      [churchId],
    );
    const cancelledBeforeCreation = await Database.query(
      `INSERT INTO gathering_types (name, attendance_type, church_id)
       VALUES ('Cancelled', 'standard', ?)`,
      [churchId],
    );
    const conflictGathering = await Database.query(
      `INSERT INTO gathering_types (name, attendance_type, church_id)
       VALUES ('Conflict', 'standard', ?)`,
      [churchId],
    );
    const otherChurchGathering = await Database.query(
      `INSERT INTO gathering_types (name, attendance_type, church_id)
       VALUES ('Other church', 'standard', 'other_church')`,
    );

    const previousSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = TEST_SECRET;
    const tokens = Object.fromEntries(Object.entries(users).map(([role, userId]) => [
      role,
      jwt.sign({ userId, churchId }, TEST_SECRET),
    ]));
    const { server, baseUrl } = await startApp();

    try {
      const adminHeld = await requestState(baseUrl, tokens.admin, {
        gatheringTypeId: standard.insertId,
        sessionDate: '2026-08-17',
        status: 'held',
        churchId: 'other_church',
      });
      assert.equal(adminHeld.response.status, 200);
      assert.deepEqual(adminHeld.body.sessionState, {
        id: adminHeld.body.sessionState.id,
        gatheringTypeId: standard.insertId,
        sessionDate: '2026-08-17',
        status: 'held',
        rosterProvenanceVersion: 1,
        cancelledAt: null,
        cancelledBy: null,
      });

      const coordinatorCancelled = await requestState(baseUrl, tokens.coordinator, {
        gatheringTypeId: cancelledBeforeCreation.insertId,
        sessionDate: '2026-08-18',
        status: 'cancelled',
      });
      assert.equal(coordinatorCancelled.response.status, 200);
      assert.equal(coordinatorCancelled.body.sessionState.status, 'cancelled');
      assert.equal(coordinatorCancelled.body.sessionState.cancelledBy, users.coordinator);

      const denied = await requestState(baseUrl, tokens.attendance_taker, {
        gatheringTypeId: standard.insertId,
        sessionDate: '2026-08-17',
        status: 'cancelled',
      });
      assert.equal(denied.response.status, 403);

      for (const invalid of [
        { gatheringTypeId: standard.insertId, sessionDate: '17-08-2026', status: 'held' },
        { gatheringTypeId: standard.insertId, sessionDate: '2026-02-30', status: 'held' },
        { gatheringTypeId: standard.insertId, sessionDate: '2026-08-17', status: 'finished' },
      ]) {
        const result = await requestState(baseUrl, tokens.admin, invalid);
        assert.equal(result.response.status, 400);
      }

      const isolated = await requestState(baseUrl, tokens.admin, {
        gatheringTypeId: otherChurchGathering.insertId,
        sessionDate: '2026-08-17',
        status: 'cancelled',
      });
      assert.equal(isolated.response.status, 404);

      const held = await requestState(baseUrl, tokens.admin, {
        gatheringTypeId: conflictGathering.insertId,
        sessionDate: '2026-08-19',
        status: 'held',
      });
      assert.equal(held.response.status, 200);
      const person = await Database.query(
        `INSERT INTO individuals (first_name, last_name, people_type, church_id)
         VALUES ('Present', 'Person', 'regular', ?)`,
        [churchId],
      );
      await Database.query(
        `INSERT INTO attendance_records
           (session_id, individual_id, present, eligible_at_snapshot, church_id)
         VALUES (?, ?, 1, 0, ?)`,
        [held.body.sessionState.id, person.insertId, churchId],
      );

      const conflict = await requestState(baseUrl, tokens.admin, {
        gatheringTypeId: conflictGathering.insertId,
        sessionDate: '2026-08-19',
        status: 'cancelled',
      });
      assert.equal(conflict.response.status, 409);
      assert.equal(conflict.body.code, 'SESSION_HAS_ACTIVITY');
      assert.match(conflict.body.error, /Correct present attendance/);
      assert.equal(JSON.stringify(conflict.body).includes('SQLITE'), false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
    }
  });
});

test('session exclusion can create an empty session and is reversible', async () => {
  await withTestChurchDb(async (churchId) => {
    Database.getRegistryDb().prepare(
      `INSERT INTO churches (church_id, church_name, is_approved)
       VALUES (?, 'Session Exclusion Test', 1)`,
    ).run(churchId);
    const admin = await Database.query(
      `INSERT INTO users (email, role, first_name, last_name, is_active, church_id)
       VALUES ('exclude-admin@test.example', 'admin', 'Exclude', 'Admin', 1, ?)`,
      [churchId],
    );
    const gathering = await Database.query(
      `INSERT INTO gathering_types (name, attendance_type, church_id)
       VALUES ('Excluded gathering', 'standard', ?)`,
      [churchId],
    );

    const previousSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = TEST_SECRET;
    const token = jwt.sign({ userId: admin.insertId, churchId }, TEST_SECRET);
    const { server, baseUrl } = await startApp();
    try {
      const excluded = await requestExclusion(baseUrl, token, {
        gatheringTypeId: gathering.insertId,
        sessionDate: '2026-08-24',
        excluded: true,
      });
      assert.equal(excluded.response.status, 200);
      assert.equal(excluded.body.excludedFromStats, true);
      assert.equal(excluded.body.sessionId > 0, true);

      const included = await requestExclusion(baseUrl, token, {
        gatheringTypeId: gathering.insertId,
        sessionDate: '2026-08-24',
        excluded: false,
      });
      assert.equal(included.response.status, 200);
      assert.equal(included.body.excludedFromStats, false);
      assert.equal(included.body.sessionId, excluded.body.sessionId);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
    }
  });
});

test('REST standard and headcount writes finalize the session in the write transaction', async () => {
  await withTestChurchDb(async (churchId) => {
    Database.getRegistryDb().prepare(
      `INSERT INTO churches (church_id, church_name, is_approved)
       VALUES (?, 'Attendance Write Test', 1)`,
    ).run(churchId);
    const admin = await Database.query(
      `INSERT INTO users (email, role, first_name, last_name, is_active, church_id)
       VALUES ('write-admin@test.example', 'admin', 'Write', 'Admin', 1, ?)`,
      [churchId],
    );
    const target = await Database.query(
      `INSERT INTO users (email, role, first_name, last_name, is_active, church_id)
       VALUES ('write-target@test.example', 'attendance_taker', 'Target', 'User', 1, ?)`,
      [churchId],
    );
    const standard = await Database.query(
      `INSERT INTO gathering_types (name, attendance_type, church_id)
       VALUES ('Standard write', 'standard', ?)`,
      [churchId],
    );
    const headcount = await Database.query(
      `INSERT INTO gathering_types (name, attendance_type, church_id)
       VALUES ('Headcount write', 'headcount', ?)`,
      [churchId],
    );
    const person = await Database.query(
      `INSERT INTO individuals (first_name, last_name, people_type, church_id)
       VALUES ('Roster', 'Member', 'regular', ?)`,
      [churchId],
    );
    await Database.query(
      `INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id)
       VALUES (?, ?, ?)`,
      [standard.insertId, person.insertId, churchId],
    );

    const previousSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = TEST_SECRET;
    const token = jwt.sign({ userId: admin.insertId, churchId }, TEST_SECRET);
    const { server, baseUrl } = await startApp();
    try {
      const standardWrite = await requestJson(
        baseUrl,
        token,
        `/api/attendance/${standard.insertId}/2026-08-20`,
        {
          attendanceRecords: [{
            individualId: person.insertId,
            present: true,
            clientTimestamp: '2099-08-20T00:00:00.000Z',
          }],
          visitors: [],
        },
      );
      assert.equal(standardWrite.response.status, 200);
      assert.equal(standardWrite.body.sessionState.status, 'held');
      const standardSession = (await Database.query(
        `SELECT id, session_status, roster_provenance_version
         FROM attendance_sessions
         WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?`,
        [standard.insertId, '2026-08-20', churchId],
      ))[0];
      assert.equal(standardSession.session_status, 'held');
      assert.equal(standardSession.roster_provenance_version, 1);
      assert.deepEqual(await Database.query(
        `SELECT present, eligible_at_snapshot, updated_by
         FROM attendance_records
         WHERE session_id = ? AND individual_id = ? AND church_id = ?`,
        [standardSession.id, person.insertId, churchId],
      ), [{ present: 1, eligible_at_snapshot: 1, updated_by: admin.insertId }]);

      const zeroWrite = await requestJson(
        baseUrl,
        token,
        `/api/attendance/headcount/update/${headcount.insertId}/2026-08-20`,
        { headcount: 0, mode: 'separate' },
      );
      assert.equal(zeroWrite.response.status, 200);
      assert.deepEqual(await Database.query(
        `SELECT s.session_status, h.headcount
         FROM attendance_sessions s
         JOIN headcount_records h ON h.session_id = s.id
         WHERE s.gathering_type_id = ? AND s.session_date = ? AND s.church_id = ?`,
        [headcount.insertId, '2026-08-20', churchId],
      ), [{ session_status: 'held', headcount: 0 }]);

      const updateUserZero = await requestJson(
        baseUrl,
        token,
        `/api/attendance/headcount/update-user/${headcount.insertId}/2026-08-21/${target.insertId}`,
        { headcount: 0 },
      );
      assert.equal(updateUserZero.response.status, 200);
      assert.deepEqual(await Database.query(
        `SELECT s.session_status, h.headcount, h.updated_by
         FROM attendance_sessions s
         JOIN headcount_records h ON h.session_id = s.id
         WHERE s.gathering_type_id = ? AND s.session_date = ? AND s.church_id = ?`,
        [headcount.insertId, '2026-08-21', churchId],
      ), [{ session_status: 'held', headcount: 0, updated_by: target.insertId }]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
    }
  });
});

test('REST attendance edits preserve a non-null historical people type', async () => {
  await withTestChurchDb(async (churchId) => {
    Database.getRegistryDb().prepare(
      `INSERT INTO churches (church_id, church_name, is_approved)
       VALUES (?, 'Historical Type Test', 1)`,
    ).run(churchId);
    const admin = await Database.query(
      `INSERT INTO users (email, role, first_name, last_name, is_active, church_id)
       VALUES ('historical-type@test.example', 'admin', 'Historical', 'Admin', 1, ?)`,
      [churchId],
    );
    const gathering = await Database.query(
      `INSERT INTO gathering_types (name, attendance_type, church_id)
       VALUES ('Historical gathering', 'standard', ?)`,
      [churchId],
    );
    const person = await Database.query(
      `INSERT INTO individuals (first_name, last_name, people_type, church_id)
       VALUES ('Former', 'Visitor', 'local_visitor', ?)`,
      [churchId],
    );
    const session = await Database.query(
      `INSERT INTO attendance_sessions
         (gathering_type_id, session_date, created_by, session_status,
          roster_provenance_version, church_id)
       VALUES (?, '2025-08-20', ?, 'held', 0, ?)`,
      [gathering.insertId, admin.insertId, churchId],
    );
    await Database.query(
      `INSERT INTO attendance_records
         (session_id, individual_id, present, people_type_at_time, church_id)
       VALUES (?, ?, 0, 'local_visitor', ?)`,
      [session.insertId, person.insertId, churchId],
    );
    await Database.query(
      `UPDATE individuals SET people_type = 'regular'
       WHERE id = ? AND church_id = ?`,
      [person.insertId, churchId],
    );

    const previousSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = TEST_SECRET;
    const token = jwt.sign({ userId: admin.insertId, churchId }, TEST_SECRET);
    const { server, baseUrl } = await startApp();
    try {
      const result = await requestJson(
        baseUrl,
        token,
        `/api/attendance/${gathering.insertId}/2025-08-20`,
        {
          attendanceRecords: [{
            individualId: person.insertId,
            present: true,
            clientTimestamp: '2099-08-20T00:00:00.000Z',
          }],
          visitors: [],
        },
      );
      assert.equal(result.response.status, 200);
      assert.deepEqual(await Database.query(
        `SELECT present, people_type_at_time
         FROM attendance_records
         WHERE session_id = ? AND individual_id = ? AND church_id = ?`,
        [session.insertId, person.insertId, churchId],
      ), [{ present: 1, people_type_at_time: 'local_visitor' }]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
    }
  });
});
