'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const settingsRouter = require('./settings');
const { beginAuthoritySwitch, commitAuthoritySwitch, getAuthority } = require('../services/peopleSync/authority');
const backgroundCheckSync = require('../services/planningCenter/backgroundCheckSync');

async function startApp(churchId) {
  const inserted = await Database.query(
    `INSERT INTO users (email, role, first_name, last_name, is_active, church_id)
     VALUES (?, 'admin', 'Admin', 'User', 1, ?)`,
    [`settings-${Math.random().toString(36).slice(2)}@example.com`, churchId],
  );
  const previousSecret = process.env.JWT_SECRET;
  Database.getRegistryDb().prepare(
    `INSERT INTO churches (church_id, church_name, is_approved) VALUES (?, 'Settings Test Church', 1)`,
  ).run(churchId);
  process.env.JWT_SECRET = 'settings-integrations-test-secret';
  const token = jwt.sign({ userId: inserted.insertId, churchId }, process.env.JWT_SECRET);
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    request: async (body, method = 'PUT', path = 'integrations') => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/settings/${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
    },
  };
}

test('legacy settings route rejects direct PCO authority activation and leaves authority unchanged', async () => {
  await withTestChurchDb(async (churchId) => {
    await Database.query(
      `INSERT INTO church_settings (church_id, church_name, planning_center_sync_indicator)
       VALUES (?, 'Settings Test Church', 0)`,
      [churchId],
    );
    const app = await startApp(churchId);
    try {
      const response = await app.request({ planningCenterSyncIndicator: true });
      assert.equal(response.status, 409);
      assert.equal(response.body.code, 'AUTHORITY_REVIEW_REQUIRED');
      assert.match(response.body.error, /people-sync\/people-authority\/preview/i);
      assert.deepEqual(await getAuthority(churchId), { active: 'none', pending: null });
      const row = (await Database.query(
        `SELECT planning_center_sync_indicator FROM church_settings WHERE church_id = ?`,
        [churchId],
      ))[0];
      assert.equal(row.planning_center_sync_indicator, 0);
    } finally {
      await app.close();
    }
  });
});

test('integration settings expose boolean-only medical configuration and adoptable appearances', async () => {
  await withTestChurchDb(async (churchId) => {
    const gathering = await Database.query("INSERT INTO gathering_types (name, church_id) VALUES ('Sunday', ?)", [churchId]);
    await Database.query(
      `UPDATE church_settings SET planning_center_medical_notes_enabled = 1,
       planning_center_medical_notes_minimum_role = 'coordinator',
       planning_center_medical_notes_badge_icon = 'heart',
       planning_center_medical_notes_badge_color = '#facc15'
       WHERE church_id = ?`, [churchId]
    );
    await Database.query('INSERT INTO planning_center_medical_note_gatherings (church_id, gathering_type_id) VALUES (?, ?)', [churchId, gathering.insertId]);
    await Database.query(
      `INSERT INTO individuals (first_name, last_name, church_id, badge_icon, badge_color)
       VALUES ('Badge', 'Person', ?, 'heart', '#FACC15')`, [churchId]
    );
    const app = await startApp(churchId);
    try {
      const settings = await app.request(undefined, 'GET');
      assert.equal(settings.status, 200);
      assert.deepEqual(settings.body.planningCenterMedicalNotes, {
        enabled: true,
        minimumRole: 'coordinator',
        gatheringTypeIds: [gathering.insertId],
        badgeIcon: 'heart',
        badgeColor: '#facc15',
        lastRefreshedAt: null,
        lastRefreshResult: null,
      });
      const appearances = await app.request(undefined, 'GET', 'integrations/planning-center/medical-notes/badge-appearances');
      assert.deepEqual(appearances.body, { appearances: [{ icon: 'heart', color: '#facc15', count: 1 }] });
      assert.equal(JSON.stringify(settings.body).includes('medical_notes'), false);
    } finally {
      await app.close();
    }
  });
});

test('legacy settings route may disable active PCO authority without activating another provider', async () => {
  await withTestChurchDb(async (churchId) => {
    await Database.query(
      `INSERT INTO church_settings (church_id, church_name, planning_center_sync_indicator)
       VALUES (?, 'Settings Test Church', 1)`,
      [churchId],
    );
    await beginAuthoritySwitch(churchId, 'planning_center');
    await commitAuthoritySwitch(churchId, 'planning_center');
    const app = await startApp(churchId);
    try {
      const response = await app.request({ planningCenterSyncIndicator: false });
      assert.equal(response.status, 200);
      assert.deepEqual(await getAuthority(churchId), { active: 'none', pending: null });
    } finally {
      await app.close();
    }
  });
});

test('enabling background-check tracking immediately refreshes Planning Center statuses', async (t) => {
  await withTestChurchDb(async (churchId) => {
    await Database.query(
      `INSERT INTO church_settings (church_id, church_name, planning_center_track_background_checks)
       VALUES (?, 'Settings Test Church', 0)`,
      [churchId],
    );
    const refreshedChurches = [];
    t.mock.method(backgroundCheckSync, 'refreshBackgroundCheckStatuses', async (refreshedChurchId) => {
      refreshedChurches.push(refreshedChurchId);
      return { updated: 3, cleared: 2, notCleared: 1, unknown: 0 };
    });
    const app = await startApp(churchId);
    try {
      const response = await app.request({ planningCenterTrackBackgroundChecks: true });

      assert.equal(response.status, 200);
      assert.deepEqual(refreshedChurches, [churchId]);
      const row = (await Database.query(
        `SELECT planning_center_track_background_checks
           FROM church_settings WHERE church_id = ?`,
        [churchId],
      ))[0];
      assert.equal(row.planning_center_track_background_checks, 1);
    } finally {
      await app.close();
    }
  });
});
