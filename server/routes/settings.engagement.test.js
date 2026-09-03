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

async function startApp(churchId, role, dependencies) {
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
  app.use('/api/settings', settingsRouter.createEngagementSettingsRouter(dependencies));
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

function inputFor(overrides = {}) {
  return {
    coreMinimum: overrides.coreMinimum ?? 60,
    casualMinimum: overrides.casualMinimum ?? 20,
    tiers: overrides.tiers || {
      core: { label: 'Regular', colour: '#16A34A' },
      casual: { label: 'Occasional', colour: '#D97706' },
      irregular: { label: 'Infrequent', colour: '#DC2626' },
    },
    // Legacy clients still submit this field; the service must ignore it.
    gatheringRoles: overrides.gatheringRoles || [{ gatheringTypeId: 999999, role: 'other' }],
  };
}

test('admins and coordinators can read engagement settings, but attendance takers cannot', async () => {
  for (const [role, expectedStatus] of [
    ['admin', 200],
    ['coordinator', 200],
    ['attendance_taker', 403],
  ]) {
    await withTestChurchDb(async (churchId) => {
      const gathering = await Database.query(
        `INSERT INTO gathering_types (name, engagement_role, church_id)
         VALUES ('Sunday', 'primary', ?)`,
        [churchId],
      );
      const person = await Database.query(
        `INSERT INTO individuals (first_name, last_name, people_type, is_active, church_id)
         VALUES ('Regular', 'Person', 'regular', 1, ?)`,
        [churchId],
      );
      await Database.query(
        `INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id)
         VALUES (?, ?, ?)`,
        [gathering.insertId, person.insertId, churchId],
      );
      const app = await startApp(churchId, role);
      try {
        const response = await app.request('GET');
        assert.equal(response.status, expectedStatus);
        if (expectedStatus === 200) {
          assert.equal(response.body.settings.coreMinimum, 60);
          assert.deepEqual(response.body.settings.gatheringRoles.map(({ name, role }) => ({ name, role })), [
            { name: 'Sunday', role: 'primary' },
          ]);
          assert.deepEqual(response.body.settings.assignmentPreview, {
            primaryAssigned: 1,
            communityAssigned: 0,
            primaryNotAssigned: 0,
          });
        }
      } finally {
        await app.close();
      }
    });
  }
});

test('only admins can write threshold and tier settings without changing gathering roles', async () => {
  for (const [role, expectedStatus] of [
    ['admin', 200],
    ['coordinator', 403],
  ]) {
    await withTestChurchDb(async (churchId) => {
      const gathering = await Database.query(
        `INSERT INTO gathering_types (name, engagement_role, church_id)
         VALUES ('Sunday', 'primary', ?)`,
        [churchId],
      );
      const app = await startApp(churchId, role);
      try {
        const response = await app.request('PUT', inputFor({ coreMinimum: 65 }));
        assert.equal(response.status, expectedStatus);
        const [stored] = await Database.query(
          `SELECT engagement_role AS role FROM gathering_types
           WHERE id = ? AND church_id = ?`,
          [gathering.insertId, churchId],
        );
        assert.equal(stored.role, 'primary');
      } finally {
        await app.close();
      }
    });
  }
});

test('invalid settings receive a client error without partial writes', async () => {
  await withTestChurchDb(async (churchId) => {
    const app = await startApp(churchId, 'admin');
    try {
      const response = await app.request('PUT', inputFor({ casualMinimum: 60 }));
      assert.equal(response.status, 400);
      assert.equal(response.body.code, 'INVALID_ENGAGEMENT_SETTINGS');
      assert.deepEqual(
        await Database.query('SELECT * FROM engagement_settings WHERE church_id = ?', [churchId]),
        [],
      );
    } finally {
      await app.close();
    }
  });
});

test('a label or colour-only engagement settings save does not request a baseline', async () => {
  await withTestChurchDb(async (churchId) => {
    const baselines = [];
    const app = await startApp(churchId, 'admin', {
      evaluateEngagementTierConfirmations: async (...args) => baselines.push(args),
    });
    try {
      const input = inputFor();
      input.tiers.core.label = 'Committed';
      input.tiers.casual.colour = '#123456';

      const response = await app.request('PUT', input);

      assert.equal(response.status, 200);
      assert.equal(response.body.settings.tiers.core.label, 'Committed');
      assert.equal(response.body.baselinePending, false);
      assert.deepEqual(baselines, []);
    } finally {
      await app.close();
    }
  });
});

test('a threshold-only change requests a successful immediate baseline', async () => {
  await withTestChurchDb(async (churchId) => {
    const baselines = [];
    const app = await startApp(churchId, 'admin', {
      evaluateEngagementTierConfirmations: async (baselineChurchId, options) => {
        baselines.push({ baselineChurchId, options });
      },
    });
    try {
      const response = await app.request('PUT', inputFor({ coreMinimum: 65 }));

      assert.equal(response.status, 200);
      assert.equal(response.body.baselinePending, false);
      assert.equal(baselines.length, 1);
      assert.equal(baselines[0].baselineChurchId, churchId);
      assert.equal(baselines[0].options.baselineOnly, true);
      assert.ok(baselines[0].options.asOf instanceof Date);
    } finally {
      await app.close();
    }
  });
});

test('a failed immediate baseline leaves the committed settings save available for weekly retry', async () => {
  await withTestChurchDb(async (churchId) => {
    const gathering = await Database.query(
      `INSERT INTO gathering_types (name, engagement_role, church_id)
       VALUES ('Sunday', 'primary', ?)`,
      [churchId],
    );
    const app = await startApp(churchId, 'admin', {
      evaluateEngagementTierConfirmations: async () => {
        throw new Error('baseline evaluator unavailable');
      },
    });
    try {
      const response = await app.request('PUT', inputFor({ coreMinimum: 65 }));
      const [stored] = await Database.query(
        `SELECT core_minimum AS coreMinimum, engagement_role AS role
         FROM engagement_settings es
         JOIN gathering_types gt ON gt.church_id = es.church_id
         WHERE es.church_id = ? AND gt.id = ?`,
        [churchId, gathering.insertId],
      );

      assert.equal(response.status, 200);
      assert.equal(response.body.settings.coreMinimum, 65);
      assert.equal(response.body.baselinePending, true);
      assert.equal(stored.coreMinimum, 65);
      assert.equal(stored.role, 'primary');
    } finally {
      await app.close();
    }
  });
});
