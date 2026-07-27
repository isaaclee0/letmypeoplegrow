'use strict';

// Proves the ACTUAL production mount order in routes/integrations.js is
// correct — the thing this task must not silently break. Neither
// elvanto.test.js's mount-order test (a synthetic stub parent router) nor
// integrations.elvantoLegacyKey.test.js (calls resolveElvantoApiKeyOrRespond
// directly in a one-route synthetic app) actually exercises the real
// `router.use('/people-sync', createPeopleSyncRouter())` /
// `router.use('/elvanto', createElvantoRouter())` mounts inside the real
// routes/integrations.js, ahead of the retained gathering-only routes. This
// file requires and mounts the REAL exported router
// (no fakes for the router composition itself), with a REAL signed JWT and
// a REAL admin user seeded in a disposable church DB — the same harness
// pattern routes/families.dbintegration.test.js already uses for the same
// reason (exercising the real verifyToken/ensureChurchIsolation/requireRole
// chain, not a stand-in for it).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const integrationsRouter = require('./integrations');

// withTestChurchDb's own generated churchId (`test_<timestamp>_<random>`)
// does not satisfy utils/churchIdGenerator.js's isValidChurchId (two
// underscores, non-hex trailing segment) — ensureChurchIsolation would
// reject every request as an "Invalid church context" 401 before ever
// reaching a route handler. Mirrors routes/families.dbintegration.test.js's
// own withRouteChurchDb helper exactly: generate a SEPARATE, isValidChurchId
// -compliant id, create its own church DB and church_settings row (which
// fires the ensure_people_sync_settings schema trigger) under it, and run
// the test body in that church's context.
async function withRouteChurchDb(fn) {
  return withTestChurchDb(async () => {
    const churchId = `tst${Math.random().toString(36).slice(2, 12)}`;
    Database.getChurchDb(churchId);
    await Database.queryForChurch(
      churchId,
      `INSERT INTO church_settings (church_id, church_name) VALUES (?, 'Route Test Church')`,
      [churchId]
    );
    return Database.setChurchContext(churchId, () => fn(churchId));
  });
}

async function seedAdmin(churchId) {
  const res = await Database.query(
    `INSERT INTO users (email, role, first_name, last_name, is_active, church_id)
     VALUES (?, 'admin', 'Admin', 'User', 1, ?)`,
    [`admin-${Math.random().toString(36).slice(2)}@example.com`, churchId]
  );
  return res.insertId;
}

async function startIntegrationsApp(churchId) {
  const userId = await seedAdmin(churchId);
  Database.getRegistryDb().prepare(
    `INSERT INTO churches (church_id, church_name, is_approved) VALUES (?, 'Test Church', 1)`
  ).run(churchId);

  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'integrations-mount-order-test-secret';
  const token = jwt.sign({ userId, churchId }, process.env.JWT_SECRET);

  const app = express();
  app.use(express.json());
  // Mounted at the exact real prefix server/index.js uses (toKebabCase('integrations') -> '/api/integrations').
  app.use('/api/integrations', integrationsRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    request: async (path, options = {}) => {
      const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
      });
      let body = null;
      try { body = await response.json(); } catch (_) { body = null; }
      return { status: response.status, body };
    },
    close: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => server.close(resolve));
      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
    },
  };
}

test('the real integrations router keeps reviewed sync and gathering routes while blind people import is absent', async () => {
  await withRouteChurchDb(async (churchId) => {
    const app = await startIntegrationsApp(churchId);
    try {
      // ─── New Elvanto router's own route (createElvantoRouter, mounted
      // FIRST at '/elvanto') — a fresh church has no Elvanto connection at
      // all, so this must resolve to the NEW router's real /status
      // handler's "not configured" shape.
      const status = await app.request('/api/integrations/elvanto/status');
      assert.equal(status.status, 200);
      assert.deepEqual(status.body, { configured: false, connected: false, elvantoAccount: null });

      // ─── New Elvanto router's own route with NO equivalent in the old
      // legacy file at all (proves the new router's OWN routes are
      // genuinely reachable, not merely "requests aren't swallowed").
      const batches = await app.request('/api/integrations/elvanto/sync-batches');
      assert.equal(batches.status, 200);
      assert.deepEqual(batches.body, { success: true, batches: [] });

      // The old selected-person import path must not fall through to a
      // parent handler anymore.
      const people = await app.request('/api/integrations/elvanto/people');
      assert.equal(people.status, 404);

      // Gathering discovery is still retained and reaches its connection
      // gate (this church has no encrypted Elvanto connection).
      const groups = await app.request('/api/integrations/elvanto/groups');
      assert.equal(groups.status, 401);
      assert.match(groups.body.error, /not connected/i);

      // ─── The provider-neutral router, mounted at an entirely different
      // prefix ('/people-sync'), also resolves correctly on the same app.
      const settings = await app.request('/api/integrations/people-sync/settings');
      assert.equal(settings.status, 200);
      assert.equal(settings.body.settings.authorityProvider, 'none');

      // ─── Sanity: a path matching neither the new router nor any legacy
      // route still 404s normally (the fallthrough isn't a catch-all).
      const missing = await app.request('/api/integrations/elvanto/this-route-does-not-exist-anywhere');
      assert.equal(missing.status, 404);
    } finally {
      await app.close();
    }
  });
});
