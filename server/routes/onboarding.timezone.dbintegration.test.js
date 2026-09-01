'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const logger = require('../config/logger');
logger.exceptions?.unhandle();
logger.rejections?.unhandle();
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const onboardingRouter = require('./onboarding');

async function startApp(churchId) {
  const inserted = await Database.query(
    `INSERT INTO users (email, role, first_name, last_name, is_active, church_id)
     VALUES (?, 'admin', 'Admin', 'User', 1, ?)`,
    [`onboarding-${Math.random().toString(36).slice(2)}@example.com`, churchId],
  );
  const previousSecret = process.env.JWT_SECRET;
  Database.getRegistryDb().prepare(
    `INSERT INTO churches (church_id, church_name, is_approved) VALUES (?, 'Onboarding Test Church', 1)`,
  ).run(churchId);
  process.env.JWT_SECRET = 'onboarding-timezone-test-secret';
  const token = jwt.sign({ userId: inserted.insertId, churchId }, process.env.JWT_SECRET);
  const app = express();
  app.use(express.json());
  app.use('/api/onboarding', onboardingRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    userId: inserted.insertId,
    saveChurchInfo: async (payload) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/onboarding/church-info`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return { status: response.status, body: await response.json() };
    },
    clearSampleData: async () => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/onboarding/clear-sample-data`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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

test('church info derives timezone from supplied location coordinates', async () => {
  await withTestChurchDb(async (churchId) => {
    const app = await startApp(churchId);
    try {
      const response = await app.saveChurchInfo({
        churchName: 'Hobart Church',
        countryCode: 'AU',
        timezone: 'America/New_York',
        locationName: 'Hobart, Tasmania, Australia',
        locationLat: -42.8821,
        locationLng: 147.3272,
      });
      assert.equal(response.status, 200);
      const rows = await Database.query('SELECT timezone FROM church_settings WHERE church_id = ?', [churchId]);
      assert.equal(rows[0].timezone, 'Australia/Hobart');
    } finally {
      await app.close();
    }
  });
});

test('clear sample data removes engagement history before deleting people', async () => {
  await withTestChurchDb(async (churchId) => {
    const app = await startApp(churchId);
    try {
      await Database.query(
        'UPDATE church_settings SET has_sample_data = 1 WHERE church_id = ?',
        [churchId],
      );
      const person = await Database.query(
        `INSERT INTO individuals (church_id, first_name, last_name, people_type, is_active)
         VALUES (?, 'Sample', 'Person', 'regular', 1)`,
        [churchId],
      );
      const event = await Database.query(
        `INSERT INTO engagement_decline_events
           (church_id, individual_id, from_tier, to_tier,
            effective_week_end, rules_version, detected_at)
         VALUES (?, ?, 'core', 'casual', '2026-08-09', 1, '2026-08-10 08:00:00')`,
        [churchId, person.insertId],
      );
      await Database.query(
        `INSERT INTO engagement_decline_deliveries
           (church_id, event_id, recipient_type, recipient_id)
         VALUES (?, ?, 'user', ?)`,
        [churchId, event.insertId, app.userId],
      );
      await Database.query(
        `INSERT INTO pastoral_insight_states
           (church_id, insight_type, subject_id, episode_key, decline_event_id)
         VALUES (?, 'primary_decline', ?, ?, ?)`,
        [churchId, person.insertId, `primary_decline:event:${event.insertId}`, event.insertId],
      );
      await Database.query(
        `INSERT INTO engagement_evaluation_state
           (church_id, individual_id, rules_version, last_evaluated_week_end,
            current_tier, active_lowest_decline_tier)
         VALUES (?, ?, 1, '2026-08-09', 'casual', 'casual')`,
        [churchId, person.insertId],
      );
      await Database.query(
        `INSERT INTO engagement_tier_state
           (church_id, individual_id, axis, rules_version, established_tier,
            candidate_tier, candidate_direction, candidate_started_week_end,
            candidate_final_week_end, last_evaluated_week_end)
         VALUES (?, ?, 'primary', 1, 'core', 'casual', 'lower',
                 '2026-08-09', '2026-11-01', '2026-08-16')`,
        [churchId, person.insertId],
      );
      await Database.query(
        `INSERT INTO engagement_tier_transitions
           (church_id, individual_id, axis, from_tier, to_tier,
            candidate_started_week_end, confirmed_week_end, rules_version,
            long_term_attended, long_term_opportunities, long_term_rate,
            confirmation_attended, confirmation_opportunities, confirmation_rate,
            decline_event_id)
         VALUES (?, ?, 'primary', 'core', 'casual', '2026-05-10', '2026-08-09', 1,
                 7, 13, ?, 3, 8, 0.375, ?)`,
        [churchId, person.insertId, 7 / 13, event.insertId],
      );
      Database.getChurchDb(churchId).exec(`
        CREATE TRIGGER assert_transition_cleanup_before_decline_event
        BEFORE DELETE ON engagement_decline_events
        WHEN EXISTS (
          SELECT 1 FROM engagement_tier_transitions
          WHERE church_id = OLD.church_id AND decline_event_id = OLD.id
        )
        BEGIN
          SELECT RAISE(ABORT, 'transition history must be cleared before decline events');
        END;
        CREATE TRIGGER assert_tier_state_cleanup_before_individual
        BEFORE DELETE ON individuals
        WHEN EXISTS (
          SELECT 1 FROM engagement_tier_state
          WHERE church_id = OLD.church_id AND individual_id = OLD.id
        )
        BEGIN
          SELECT RAISE(ABORT, 'tier state must be cleared before individuals');
        END;
      `);

      const response = await app.clearSampleData();

      assert.equal(response.status, 200);
      for (const table of [
        'pastoral_insight_states',
        'engagement_decline_deliveries',
        'engagement_decline_events',
        'engagement_evaluation_state',
        'engagement_tier_transitions',
        'engagement_tier_state',
        'individuals',
      ]) {
        assert.equal((await Database.query(
          `SELECT COUNT(*) AS count FROM ${table} WHERE church_id = ?`,
          [churchId],
        ))[0].count, 0, `${table} should be empty`);
      }
      assert.equal((await Database.query(
        'SELECT has_sample_data AS hasSampleData FROM church_settings WHERE church_id = ?',
        [churchId],
      ))[0].hasSampleData, 0);
    } finally {
      await app.close();
    }
  });
});
