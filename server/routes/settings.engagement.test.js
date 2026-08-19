'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const Database = require('../config/database');
const logger = require('../config/logger');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const settingsRouter = require('./settings');

logger.exceptions?.unhandle();
logger.rejections?.unhandle();

async function startApp(churchId, role) {
  const inserted = await Database.query(
    `INSERT INTO users (email, role, first_name, last_name, is_active, church_id)
     VALUES (?, ?, 'Settings', 'User', 1, ?)`,
    [`engagement-${role}-${Math.random().toString(36).slice(2)}@example.com`, role, churchId],
  );
  Database.getRegistryDb().prepare(
    `INSERT INTO churches (church_id, church_name, is_approved)
     VALUES (?, 'Engagement Settings Test Church', 1)`,
  ).run(churchId);
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'settings-engagement-test-secret';
  const token = jwt.sign({ userId: inserted.insertId, churchId }, process.env.JWT_SECRET);
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    request: async (method, body) => {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/settings/engagement`,
        {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
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

function inputFor(gatheringTypeId) {
  return {
    coreMinimum: 60,
    casualMinimum: 20,
    tiers: {
      core: { label: 'Core', colour: '#16A34A' },
      casual: { label: 'Casual', colour: '#D97706' },
      irregular: { label: 'Irregular', colour: '#DC2626' },
    },
    gatheringRoles: [{ gatheringTypeId, role: 'primary' }],
  };
}

test('admins and coordinators can read engagement settings, but attendance takers cannot', async () => {
  for (const [role, expectedStatus] of [
    ['admin', 200],
    ['coordinator', 200],
    ['attendance_taker', 403],
  ]) {
    await withTestChurchDb(async (churchId) => {
      await Database.query(
        `INSERT INTO gathering_types (name, church_id) VALUES ('Sunday', ?)`,
        [churchId],
      );
      const app = await startApp(churchId, role);
      try {
        const response = await app.request('GET');
        assert.equal(response.status, expectedStatus);
        if (expectedStatus === 200) {
          assert.equal(response.body.settings.coreMinimum, 60);
          assert.equal(response.body.settings.gatheringRoles[0].role, null);
        }
      } finally {
        await app.close();
      }
    });
  }
});

test('engagement settings include display metadata for every active, inactive, and headcount gathering', async () => {
  await withTestChurchDb(async (churchId) => {
    await Database.query(
      `INSERT INTO gathering_types
         (name, attendance_type, is_active, engagement_role, church_id)
       VALUES
         ('Sunday', 'standard', 1, 'primary', ?),
         ('Old Youth', 'standard', 0, 'community', ?),
         ('Conference', 'headcount', 1, 'other', ?)`,
      [churchId, churchId, churchId],
    );
    const app = await startApp(churchId, 'coordinator');
    try {
      const response = await app.request('GET');
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.settings.gatheringRoles.map((gathering) => ({
        name: gathering.name,
        attendanceType: gathering.attendanceType,
        isActive: gathering.isActive,
        role: gathering.role,
      })), [
        { name: 'Sunday', attendanceType: 'standard', isActive: true, role: 'primary' },
        { name: 'Old Youth', attendanceType: 'standard', isActive: false, role: 'community' },
        { name: 'Conference', attendanceType: 'headcount', isActive: true, role: 'other' },
      ]);
    } finally {
      await app.close();
    }
  });
});

test('only admins can atomically write the complete engagement settings object', async () => {
  for (const [role, expectedStatus] of [
    ['admin', 200],
    ['coordinator', 403],
  ]) {
    await withTestChurchDb(async (churchId) => {
      const gathering = await Database.query(
        `INSERT INTO gathering_types (name, church_id) VALUES ('Sunday', ?)`,
        [churchId],
      );
      const app = await startApp(churchId, role);
      try {
        const response = await app.request('PUT', inputFor(gathering.insertId));
        assert.equal(response.status, expectedStatus);
        const [stored] = await Database.query(
          `SELECT engagement_role AS role FROM gathering_types
           WHERE id = ? AND church_id = ?`,
          [gathering.insertId, churchId],
        );
        assert.equal(stored.role, expectedStatus === 200 ? 'primary' : null);
      } finally {
        await app.close();
      }
    });
  }
});

test('invalid complete settings receive a client error without partial writes', async () => {
  await withTestChurchDb(async (churchId) => {
    const gathering = await Database.query(
      `INSERT INTO gathering_types (name, church_id) VALUES ('Sunday', ?)`,
      [churchId],
    );
    const app = await startApp(churchId, 'admin');
    try {
      const input = inputFor(gathering.insertId);
      input.casualMinimum = 60;
      const response = await app.request('PUT', input);
      assert.equal(response.status, 400);
      assert.equal(response.body.code, 'INVALID_ENGAGEMENT_SETTINGS');
      const [stored] = await Database.query(
        `SELECT engagement_role AS role FROM gathering_types
         WHERE id = ? AND church_id = ?`,
        [gathering.insertId, churchId],
      );
      assert.equal(stored.role, null);
    } finally {
      await app.close();
    }
  });
});
