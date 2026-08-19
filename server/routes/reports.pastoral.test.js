'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'reports-pastoral-route-test-secret';

const Database = require('../config/database');
const logger = require('../config/logger');
logger.exceptions?.unhandle();
logger.rejections?.unhandle();
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const reportsRouter = require('./reports');

async function startApp(churchId, role) {
  const user = await Database.query(
    `INSERT INTO users (church_id, email, role, first_name, last_name, is_active)
     VALUES (?, ?, ?, 'Route', 'Tester', 1)`,
    [churchId, `${role}-${Math.random().toString(36).slice(2)}@example.com`, role],
  );
  Database.getRegistryDb().prepare(
    `INSERT OR IGNORE INTO churches (church_id, church_name, is_approved)
     VALUES (?, 'Pastoral Route Test', 1)`,
  ).run(churchId);
  const token = jwt.sign({ userId: user.insertId, churchId }, process.env.JWT_SECRET);
  const app = express();
  app.use(express.json());
  app.use('/api/reports', reportsRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const request = async (path, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/reports${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch (_) { body = { raw: text }; }
    return { status: response.status, body };
  };
  return {
    actorId: user.insertId,
    request,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('admin and coordinator can view pastoral insights while attendance takers are denied', async () => {
  for (const [role, expected] of [['admin', 200], ['coordinator', 200], ['attendance_taker', 403]]) {
    await withTestChurchDb(async (churchId) => {
      const app = await startApp(churchId, role);
      try {
        const response = await app.request('/pastoral');
        assert.equal(response.status, expected);
        if (expected === 200) {
          assert.equal(response.body.schemaVersion, 1);
          assert.equal(response.body.churchId, churchId);
        }
      } finally {
        await app.close();
      }
    });
  }
});

test('PATCH validates action shape and snooze date without accepting factual state', async () => {
  await withTestChurchDb(async (churchId) => {
    const app = await startApp(churchId, 'admin');
    try {
      for (const body of [
        { action: 'archive' },
        { action: 'snooze' },
        { action: 'snooze', snoozeUntil: '19/08/2026' },
        { action: 'dismiss', snoozeUntil: '2026-08-30' },
        { action: 'dismiss', fromTier: 'core' },
        { action: 'dismiss', church_id: churchId },
      ]) {
        const response = await app.request('/pastoral/1', {
          method: 'PATCH', body: JSON.stringify(body),
        });
        assert.equal(response.status, 400, JSON.stringify(body));
        assert.equal(response.body.code, 'INVALID_PASTORAL_ACTION');
      }
    } finally {
      await app.close();
    }
  });
});

test('PATCH derives factual fields on the server and denies cross-church insight IDs', async () => {
  await withTestChurchDb(async (churchId) => {
    const app = await startApp(churchId, 'coordinator');
    try {
      const person = await Database.query(
        `INSERT INTO individuals
           (first_name, last_name, people_type, is_active, church_id)
         VALUES ('Pat', 'Person', 'regular', 1, ?)`,
        [churchId],
      );
      const event = await Database.query(
        `INSERT INTO engagement_decline_events
           (church_id, individual_id, from_tier, to_tier, effective_week_end,
            rules_version, detected_at)
         VALUES (?, ?, 'core', 'casual', '2026-08-16', 1, '2026-08-17 08:00:00')`,
        [churchId, person.insertId],
      );
      const state = await Database.query(
        `INSERT INTO pastoral_insight_states
           (church_id, insight_type, subject_id, episode_key, decline_event_id)
         VALUES (?, 'primary_decline', ?, ?, ?)`,
        [churchId, person.insertId, `primary_decline:event:${event.insertId}`, event.insertId],
      );

      const changed = await app.request(`/pastoral/${state.insertId}`, {
        method: 'PATCH', body: JSON.stringify({ action: 'dismiss' }),
      });
      assert.equal(changed.status, 200);
      assert.equal(changed.body.insight.declineEventId, event.insertId);
      assert.equal(changed.body.insight.evidence.fromTier, 'core');
      assert.equal(changed.body.insight.evidence.toTier, 'casual');
      assert.equal(changed.body.insight.workflow.state, 'dismissed');

      const foreign = await Database.query(
        `INSERT INTO pastoral_insight_states
           (church_id, insight_type, subject_id, episode_key)
         VALUES ('other_church', 'visitor_next_step', ?, 'visitor_next_step:first_primary:2026-08-10')`,
        [person.insertId],
      );
      const denied = await app.request(`/pastoral/${foreign.insertId}`, {
        method: 'PATCH', body: JSON.stringify({ action: 'dismiss' }),
      });
      assert.equal(denied.status, 404);
      assert.equal(denied.body.code, 'PASTORAL_INSIGHT_NOT_FOUND');
    } finally {
      await app.close();
    }
  });
});

test('GET reports a load failure instead of an update failure', async () => {
  await withTestChurchDb(async (churchId) => {
    const app = await startApp(churchId, 'admin');
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      Database.getChurchDb(churchId).exec('DROP TABLE church_settings');
      const response = await app.request('/pastoral');
      assert.equal(response.status, 500);
      assert.equal(response.body.error, 'Failed to load the pastoral-care report.');
    } finally {
      console.error = originalConsoleError;
      await app.close();
    }
  });
});
