'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const https = require('node:https');
const jwt = require('jsonwebtoken');
const Database = require('../config/database');
const logger = require('../config/logger');
const locationSearchService = require('../services/locationSearch');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const settingsRouter = require('./settings');

// Let node:test report assertion failures directly instead of routing them
// through Winston's process-level exception handlers.
logger.exceptions?.unhandle();
logger.rejections?.unhandle();

async function startApp(churchId) {
  const inserted = await Database.query(
    `INSERT INTO users (email, role, first_name, last_name, is_active, church_id)
     VALUES (?, 'admin', 'Admin', 'User', 1, ?)`,
    [`location-${Math.random().toString(36).slice(2)}@example.com`, churchId],
  );
  const previousSecret = process.env.JWT_SECRET;
  Database.getRegistryDb().prepare(
    `INSERT INTO churches (church_id, church_name, is_approved) VALUES (?, 'Location Test Church', 1)`,
  ).run(churchId);
  process.env.JWT_SECRET = 'settings-location-test-secret';
  const token = jwt.sign({ userId: inserted.insertId, churchId }, process.env.JWT_SECRET);
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    search: async (query) => {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/settings/location-search?q=${encodeURIComponent(query)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      return { status: response.status, body: await response.json() };
    },
    update: async (payload) => {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/settings/location`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      return { status: response.status, body: await response.json() };
    },
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
    },
  };
}

test('location search returns normalized service results', async (t) => {
  await withTestChurchDb(async (churchId) => {
    t.mock.method(locationSearchService, 'search', async () => [{
      name: 'Hobart', admin1: 'Tasmania', country: 'Australia', countryCode: 'AU',
      lat: -42.87936, lng: 147.3294, timezone: 'Australia/Hobart', population: 252639,
      source: 'open-meteo', displayName: 'Hobart, Tasmania, Australia',
    }]);
    t.mock.method(https, 'get', () => { throw new Error('route bypassed location search service'); });
    const app = await startApp(churchId);
    try {
      const response = await app.search('Hobart');
      assert.equal(response.status, 200);
      assert.equal(response.body.results[0].population, 252639);
      assert.equal(response.body.results[0].source, 'open-meteo');
    } finally {
      await app.close();
    }
  });
});

test('location search preserves the unavailable response when all providers fail', async (t) => {
  await withTestChurchDb(async (churchId) => {
    t.mock.method(locationSearchService, 'search', async () => { throw new Error('providers unavailable'); });
    t.mock.method(https, 'get', () => { throw new Error('legacy provider unavailable'); });
    const app = await startApp(churchId);
    try {
      const response = await app.search('Hobart');
      assert.equal(response.status, 502);
      assert.deepEqual(response.body, { error: 'Location search is temporarily unavailable.' });
    } finally {
      await app.close();
    }
  });
});

test('updating a location atomically saves its derived timezone', async () => {
  await withTestChurchDb(async (churchId) => {
    const app = await startApp(churchId);
    try {
      const response = await app.update({ name: 'Hobart, Tasmania, Australia', lat: -42.8821, lng: 147.3272 });
      assert.equal(response.status, 200);
      assert.equal(response.body.location.timezone, 'Australia/Hobart');
      const rows = await Database.query('SELECT location_name, timezone FROM church_settings WHERE church_id = ?', [churchId]);
      assert.deepEqual(rows[0], { location_name: 'Hobart, Tasmania, Australia', timezone: 'Australia/Hobart' });
    } finally {
      await app.close();
    }
  });
});
