'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const Database = require('../config/database');
const logger = require('../config/logger');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const authRouter = require('./auth');

logger.exceptions?.unhandle();
logger.rejections?.unhandle();

async function startAuthApp(churchId, userId) {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'auth-timezone-test-secret';
  const token = jwt.sign({ userId, churchId }, process.env.JWT_SECRET);
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    request: async (path, options = {}) => {
      const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
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

test('auth payloads expose the active church timezone for login, me, and church switching', async () => {
  await withTestChurchDb(async (churchId) => {
    const otherChurchId = `other_${Math.random().toString(36).slice(2, 12)}`;
    const email = `timezone-${Math.random().toString(36).slice(2)}@example.com`;
    const primaryUser = await Database.query(
      `INSERT INTO users (email, primary_contact_method, role, first_name, last_name, is_active, church_id)
       VALUES (?, 'email', 'admin', 'Primary', 'Admin', 1, ?)`,
      [email, churchId],
    );
    const otherDb = Database.getChurchDb(otherChurchId);
    otherDb.prepare(`INSERT INTO church_settings (church_id, church_name, timezone) VALUES (?, 'Other Church', 'Pacific/Auckland')`)
      .run(otherChurchId);
    const otherUser = await Database.queryForChurch(
      otherChurchId,
      `INSERT INTO users (email, primary_contact_method, role, first_name, last_name, is_active, church_id)
       VALUES (?, 'email', 'admin', 'Other', 'Admin', 1, ?)`,
      [email, otherChurchId],
    );
    await Database.query('UPDATE church_settings SET timezone = ? WHERE church_id = ?', ['Australia/Hobart', churchId]);
    Database.getRegistryDb().prepare(
      `INSERT INTO churches (church_id, church_name, is_approved) VALUES (?, 'Primary Church', 1), (?, 'Other Church', 1)`,
    ).run(churchId, otherChurchId);
    Database.registerUserLookup(primaryUser.insertId, email, null, churchId);
    Database.registerUserLookup(otherUser.insertId, email, null, otherChurchId);

    const app = await startAuthApp(churchId, primaryUser.insertId);
    try {
      const me = await app.request('/api/auth/me');
      assert.equal(me.status, 200);
      assert.equal(me.body.user.timezone, 'Australia/Hobart');

      const refreshed = await app.request('/api/auth/refresh', { method: 'POST' });
      assert.equal(refreshed.status, 200);
      assert.equal(refreshed.body.user.timezone, 'Australia/Hobart');

      const switched = await app.request('/api/auth/switch-church', {
        method: 'POST', body: JSON.stringify({ targetChurchId: otherChurchId }),
      });
      assert.equal(switched.status, 200);
      assert.equal(switched.body.user.timezone, 'Pacific/Auckland');
      assert.notEqual(switched.body.user.timezone, me.body.user.timezone);

      await Database.query('INSERT INTO otc_codes (contact_identifier, contact_type, code, expires_at) VALUES (?, \'email\', \'123456\', datetime(\'now\', \'1 hour\'))', [email]);
      const verified = await app.request('/api/auth/verify-code', {
        method: 'POST', body: JSON.stringify({ contact: email, code: '123456', churchId }),
      });
      assert.equal(verified.status, 200);
      assert.equal(verified.body.user.timezone, 'Australia/Hobart');
    } finally {
      await app.close();
    }
  });
});
