'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const Database = require('../config/database');
const logger = require('../config/logger');
const email = require('../utils/email');
const locationSearch = require('../services/locationSearch');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');

logger.exceptions?.unhandle();
logger.rejections?.unhandle();

// Exercise registration and its validators against SQLite, without delivering mail.
email.sendOTCEmail = async () => {};
email.sendNewChurchApprovalEmail = async () => {};
const authRouter = require('./auth');

const auckland = {
  locationName: 'Auckland, New Zealand',
  locationLat: -36.8485,
  locationLng: 174.7633,
  countryCode: 'NZ',
};
const account = {
  email: 'new@example.com',
  firstName: 'New',
  lastName: 'Admin',
  churchName: 'Test Church',
};

async function withAuthApp(run) {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const request = async (path, options) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth${path}`, options);
    const isJson = response.headers.get('content-type')?.includes('application/json');
    return { status: response.status, body: isJson ? await response.json() : await response.text() };
  };
  try {
    return await run({
      request,
      register: (data) => request('/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...account, ...data }),
      }),
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function registeredSettings() {
  const { church_id: churchId } = Database.lookupChurchByEmail(account.email);
  const [settings] = await Database.queryForChurch(churchId, `
    SELECT location_name, location_lat, location_lng, country_code, timezone
    FROM church_settings WHERE church_id = ?
  `, [churchId]);
  return settings;
}

async function registeredOnboardingVersion() {
  const { church_id: churchId } = Database.lookupChurchByEmail(account.email);
  const [settings] = await Database.queryForChurch(churchId,
    'SELECT onboarding_version FROM church_settings WHERE church_id = ?', [churchId]);
  return settings.onboarding_version;
}

test('registration saves the selected location, derives its timezone and enables guided onboarding', async () => {
  await withTestChurchDb(() => withAuthApp(async ({ register }) => {
    const result = await register({ ...auckland, timezone: 'Australia/Sydney' });
    assert.equal(result.status, 201);
    assert.deepEqual(await registeredSettings(), {
      location_name: 'Auckland, New Zealand',
      location_lat: -36.8485,
      location_lng: 174.7633,
      country_code: 'NZ',
      timezone: 'Pacific/Auckland',
    });
    assert.equal(await registeredOnboardingVersion(), 2);
  }));
});

test('registration without a location keeps the default country and timezone', async () => {
  await withTestChurchDb(() => withAuthApp(async ({ register }) => {
    const result = await register();
    assert.equal(result.status, 201);
    assert.deepEqual(await registeredSettings(), {
      location_name: null,
      location_lat: null,
      location_lng: null,
      country_code: 'AU',
      timezone: 'Australia/Sydney',
    });
    assert.equal(await registeredOnboardingVersion(), 2);
  }));
});

test('invalid or incomplete location does not provision a church or account', async () => {
  await withTestChurchDb(() => withAuthApp(async ({ register }) => {
    for (const location of [
      { ...auckland, locationLat: 91 },
      { ...auckland, locationLng: '174.7633' },
      { ...auckland, locationLat: null },
      { locationName: 'Auckland' },
      { ...auckland, countryCode: 'NZL' },
      { ...auckland, countryCode: 'XX' },
    ]) {
      const result = await register(location);
      assert.equal(result.status, 400, JSON.stringify(location));
      assert.equal(Database.lookupChurchByEmail(account.email), null);
      assert.equal(Database.listChurches().length, 0);
    }
  }));
});

test('same-name registration leaves an approved church and its users untouched', async () => {
  await withTestChurchDb(async existingChurchId => {
    Database.ensureChurch(existingChurchId, account.churchName);
    Database.getRegistryDb().prepare('UPDATE churches SET is_approved = 1 WHERE church_id = ?').run(existingChurchId);
    await Database.query('UPDATE church_settings SET location_name = ?, location_lat = ?, location_lng = ?, timezone = ? WHERE church_id = ?',
      ['Hobart, Tasmania, Australia', -42.88, 147.33, 'Australia/Hobart', existingChurchId]);

    await withAuthApp(async ({ register }) => {
      const result = await register(auckland);
      assert.equal(result.status, 201);
      const { church_id: newChurchId } = Database.lookupChurchByEmail(account.email);
      assert.notEqual(newChurchId, existingChurchId);
      assert.equal(Database.isChurchApproved(newChurchId), false);
      assert.equal(Database.listChurches().length, 2);
      assert.deepEqual(await Database.query('SELECT email FROM users WHERE church_id = ?', [existingChurchId]), []);
      assert.deepEqual(await Database.query(
        'SELECT location_name, location_lat, location_lng, country_code, timezone FROM church_settings WHERE church_id = ?',
        [existingChurchId],
      ), [{
        location_name: 'Hobart, Tasmania, Australia',
        location_lat: -42.88,
        location_lng: 147.33,
        country_code: 'AU',
        timezone: 'Australia/Hobart',
      }]);
    });
  });
});

test('signup search is public, bounds queries and reports provider unavailability', async t => {
  const result = {
    name: 'Auckland', admin1: null, country: 'New Zealand', countryCode: 'NZ',
    lat: -36.8485, lng: 174.7633, timezone: 'Pacific/Auckland', displayName: 'Auckland, New Zealand',
    source: 'open-meteo', population: null,
  };
  const search = t.mock.method(locationSearch, 'search', async query => {
    if (query !== 'Auckland') throw new Error('Unavailable');
    return [result];
  });
  await withAuthApp(async ({ request }) => {
    assert.deepEqual(await request('/location-search?q=%20Auckland%20'), { status: 200, body: { results: [result] } });
    assert.deepEqual(await request('/location-search?q=Au'), { status: 200, body: { results: [] } });
    assert.equal((await request(`/location-search?q=${'a'.repeat(121)}`)).status, 400);
    assert.equal((await request('/location-search?q=one&q=two')).status, 400);
    assert.equal(search.mock.callCount(), 1);
    assert.equal((await request('/location-search?q=Wellington')).status, 502);
  });
});

test('successful signup searches count against the public rate limit', async t => {
  t.mock.method(locationSearch, 'search', async () => []);
  await withAuthApp(async ({ request }) => {
    let status;
    for (let attempt = 0; attempt < 40 && status !== 429; attempt++) {
      status = (await request('/location-search?q=Auckland')).status;
      assert.ok(status === 200 || status === 429);
    }
    assert.equal(status, 429);
  });
});
