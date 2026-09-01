'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'reports-engagement-route-test-secret';

const Database = require('../config/database');
const logger = require('../config/logger');
logger.exceptions?.unhandle();
logger.rejections?.unhandle();

const { verifyToken, requireRole } = require('../middleware/auth');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const { createDrilldownToken } = require('../services/engagement/drilldownTokens');
const engagementRouter = require('./reports/engagement');

async function seedUser(churchId, role) {
  const inserted = await Database.query(
    `INSERT INTO users (email, role, first_name, last_name, is_active, church_id)
     VALUES (?, ?, 'Report', 'User', 1, ?)`,
    [`engagement-${role}-${Math.random().toString(36).slice(2)}@example.com`, role, churchId],
  );
  Database.getRegistryDb().prepare(
    `INSERT OR IGNORE INTO churches (church_id, church_name, is_approved)
     VALUES (?, 'Engagement Report Test Church', 1)`,
  ).run(churchId);
  return jwt.sign({ userId: inserted.insertId, churchId }, process.env.JWT_SECRET);
}

async function startApp(churchId, role) {
  const token = await seedUser(churchId, role);
  const app = express();
  app.use(express.json());
  app.use(
    '/api/reports/engagement',
    verifyToken,
    requireRole(['admin', 'coordinator']),
    engagementRouter,
  );
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    request: async (path) => {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/reports/engagement${path}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      return { status: response.status, body: await response.json() };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('admin and coordinator can view the overview while attendance takers are denied', async () => {
  for (const [role, expectedStatus] of [
    ['admin', 200],
    ['coordinator', 200],
    ['attendance_taker', 403],
  ]) {
    await withTestChurchDb(async (churchId) => {
      const app = await startApp(churchId, role);
      try {
        const response = await app.request('/overview');
        assert.equal(response.status, expectedStatus);
        if (expectedStatus === 200) {
          assert.equal(response.body.schemaVersion, 2);
          assert.equal(response.body.churchId, churchId);
          assert.deepEqual(response.body.baseline, { pending: false, pendingAxes: 0 });
          assert.equal(response.body.movement, undefined);
        }
      } finally {
        await app.close();
      }
    });
  }
});

test('overview rejects client date filters instead of changing the fixed completed-week window', async () => {
  await withTestChurchDb(async (churchId) => {
    const app = await startApp(churchId, 'admin');
    try {
      for (const query of ['?startDate=2026-01-01', '?endDate=2026-02-01', '?asOf=2026-03-01']) {
        const response = await app.request(`/overview${query}`);
        assert.equal(response.status, 400);
        assert.equal(response.body.code, 'ENGAGEMENT_DATE_FILTER_UNSUPPORTED');
      }
    } finally {
      await app.close();
    }
  });
});

async function seedCorePeople(churchId) {
  await Database.query(
    `UPDATE church_settings SET timezone = 'Australia/Hobart' WHERE church_id = ?`,
    [churchId],
  );
  const [user] = await Database.query(
    `SELECT id FROM users WHERE church_id = ? ORDER BY id LIMIT 1`,
    [churchId],
  );
  const gathering = await Database.query(
    `INSERT INTO gathering_types
       (name, attendance_type, engagement_role, is_active, church_id)
     VALUES ('Sunday', 'standard', 'primary', 1, ?)`,
    [churchId],
  );
  const people = [];
  for (const [firstName, lastName] of [['Amy', 'Able'], ['Ben', 'Baker'], ['Cara', 'Clark']]) {
    const inserted = await Database.query(
      `INSERT INTO individuals (first_name, last_name, people_type, is_active, church_id)
       VALUES (?, ?, 'regular', 1, ?)`,
      [firstName, lastName, churchId],
    );
    people.push(inserted.insertId);
    await Database.query(
      `INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id)
       VALUES (?, ?, ?)`,
      [gathering.insertId, inserted.insertId, churchId],
    );
  }
  for (const date of [
    '2026-06-21', '2026-06-28', '2026-07-05', '2026-07-12',
    '2026-07-19', '2026-07-26', '2026-08-02', '2026-08-09',
  ]) {
    const session = await Database.query(
      `INSERT INTO attendance_sessions
         (gathering_type_id, session_date, created_by, roster_snapshotted,
          session_status, roster_provenance_version, church_id)
       VALUES (?, ?, ?, 1, 'held', 1, ?)`,
      [gathering.insertId, date, user.id, churchId],
    );
    for (const individualId of people) {
      await Database.query(
        `INSERT INTO attendance_records
           (session_id, individual_id, present, eligible_at_snapshot,
            people_type_at_time, church_id)
         VALUES (?, ?, 1, 1, 'regular', ?)`,
        [session.insertId, individualId, churchId],
      );
    }
  }
  return people;
}

test('drilldowns enforce max 100, reject tampering, and paginate with stable opaque cursors', async () => {
  await withTestChurchDb(async (churchId) => {
    const app = await startApp(churchId, 'admin');
    try {
      const people = await seedCorePeople(churchId);
      const overview = await app.request('/overview');
      assert.equal(overview.status, 200);
      const segment = overview.body.primaryDistribution.classified.tiers
        .find((tier) => tier.tier === 'core').peopleToken;

      const tooLarge = await app.request(`/people?segment=${encodeURIComponent(segment)}&limit=101`);
      assert.equal(tooLarge.status, 400);
      assert.equal(tooLarge.body.code, 'INVALID_ENGAGEMENT_LIMIT');

      const tampered = `${segment.slice(0, -1)}${segment.endsWith('A') ? 'B' : 'A'}`;
      const invalid = await app.request(`/people?segment=${encodeURIComponent(tampered)}`);
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.code, 'INVALID_DRILLDOWN_TOKEN');

      const first = await app.request(`/people?segment=${encodeURIComponent(segment)}&limit=2`);
      assert.equal(first.status, 200);
      assert.equal(first.body.rows.length, 2);
      assert.ok(first.body.nextCursor);
      assert.equal(first.body.nextCursor.includes('Baker'), false);
      const second = await app.request(
        `/people?segment=${encodeURIComponent(segment)}&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      );
      assert.equal(second.status, 200);
      assert.deepEqual(
        [...first.body.rows, ...second.body.rows].map((row) => row.individualId),
        people,
      );

      const wrongChurch = createDrilldownToken({
        churchId: 'another_church',
        kind: 'people',
        selector: { type: 'confirmation', axis: 'primary', direction: 'higher' },
        completedWeekEnd: overview.body.window.completedWeekEnd,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const isolated = await app.request(`/people?segment=${encodeURIComponent(wrongChurch)}`);
      assert.equal(isolated.status, 400);
      assert.equal(isolated.body.code, 'INVALID_DRILLDOWN_TOKEN');

      const retiredMovement = createDrilldownToken({
        churchId,
        kind: 'people',
        selector: { type: 'movement', direction: 'same' },
        completedWeekEnd: overview.body.window.completedWeekEnd,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const retired = await app.request(
        `/people?segment=${encodeURIComponent(retiredMovement)}`,
      );
      assert.equal(retired.status, 400);
      assert.equal(retired.body.code, 'INVALID_DRILLDOWN_TOKEN');
    } finally {
      await app.close();
    }
  });
});
