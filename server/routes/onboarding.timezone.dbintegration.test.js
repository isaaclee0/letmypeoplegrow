'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');
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
    saveChurchInfo: async (payload) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/onboarding/church-info`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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
