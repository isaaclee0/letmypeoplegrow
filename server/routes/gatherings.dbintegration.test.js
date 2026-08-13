'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const Database = require('../config/database');
const logger = require('../config/logger');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const gatheringsRouter = require('./gatherings');

logger.exceptions?.unhandle();
logger.rejections?.unhandle();

async function withRouteChurchDb(fn) {
  return withTestChurchDb(async () => {
    const churchId = `tst${Math.random().toString(36).slice(2, 12)}`;
    Database.getChurchDb(churchId);
    await Database.queryForChurch(
      churchId,
      `INSERT INTO church_settings (church_id, church_name) VALUES (?, 'Gatherings Route Test Church')`,
      [churchId],
    );
    return Database.setChurchContext(churchId, () => fn(churchId));
  });
}

async function seedAdmin(churchId, label) {
  const result = await Database.query(
    `INSERT INTO users (email, role, first_name, last_name, is_active, church_id)
     VALUES (?, 'admin', ?, 'Admin', 1, ?)`,
    [`${label}-${Math.random().toString(36).slice(2)}@example.com`, label, churchId],
  );
  return Number(result.insertId);
}

async function seedGathering(churchId, createdBy, name = 'Network Youth') {
  const result = await Database.query(
    `INSERT INTO gathering_types (name, attendance_type, created_by, church_id)
     VALUES (?, 'standard', ?, ?)`,
    [name, createdBy, churchId],
  );
  return Number(result.insertId);
}

async function startApp(churchId, userId) {
  Database.getRegistryDb().prepare(
    `INSERT INTO churches (church_id, church_name, is_approved) VALUES (?, 'Gatherings Test Church', 1)`,
  ).run(churchId);

  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'gatherings-route-test-secret';
  const token = jwt.sign({ userId, churchId }, process.env.JWT_SECRET);

  const app = express();
  app.use(express.json());
  app.use('/api/gatherings', gatheringsRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    deleteGathering: async (gatheringId) => {
      const response = await fetch(`${baseUrl}/api/gatherings/${gatheringId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      return { status: response.status, body: await response.json() };
    },
    close: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => server.close(resolve));
      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
    },
  };
}

test('an admin can delete a gathering created by another admin in the same church', async () => {
  await withRouteChurchDb(async (churchId) => {
    const creatorId = await seedAdmin(churchId, 'Creator');
    const deletingAdminId = await seedAdmin(churchId, 'Deleting');
    const gatheringId = await seedGathering(churchId, creatorId);
    const app = await startApp(churchId, deletingAdminId);

    try {
      const response = await app.deleteGathering(gatheringId);

      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { message: 'Gathering deleted successfully.' });
      const remaining = await Database.query(
        'SELECT id FROM gathering_types WHERE id = ? AND church_id = ?',
        [gatheringId, churchId],
      );
      assert.deepEqual(remaining, []);
    } finally {
      await app.close();
    }
  });
});
