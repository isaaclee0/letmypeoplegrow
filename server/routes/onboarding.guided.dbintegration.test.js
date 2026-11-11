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
const onboarding = require('./onboarding');

async function withOnboarding(fn) {
  return withTestChurchDb(async (churchId) => {
    const secret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'guided-onboarding-db-test-secret';
    Database.getRegistryDb().prepare(
      'INSERT INTO churches (church_id, church_name, is_approved) VALUES (?, ?, 1)'
    ).run(churchId, 'Test Church');

    const addUser = async (email, role = 'admin') => {
      const user = await Database.query(
        "INSERT INTO users (church_id, email, role, first_name, last_name) VALUES (?, ?, ?, 'Test', 'User')",
        [churchId, email, role],
      );
      return user.insertId;
    };

    const adminId = await addUser('admin@example.com');
    const app = express();
    app.use(express.json());
    app.use('/api/onboarding', onboarding);
    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const request = async (path, method = 'GET', payload, userId = adminId) => {
      const token = jwt.sign({ userId, churchId }, process.env.JWT_SECRET);
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/onboarding/${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = response.headers.get('content-type')?.includes('application/json')
        ? await response.json()
        : await response.text();
      return { status: response.status, body };
    };

    try {
      return await fn({ churchId, request, addUser, adminId });
    } finally {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => server.close(resolve));
      if (secret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = secret;
    }
  });
}

async function addGathering(churchId, type, active = 1) {
  const { insertId } = await Database.query(
    'INSERT INTO gathering_types (church_id, name, attendance_type, is_active) VALUES (?, ?, ?, ?)',
    [churchId, 'Test Service', type, active],
  );
  return insertId;
}

async function addFamily(churchId) {
  const { insertId } = await Database.query(
    "INSERT INTO families (church_id, family_name) VALUES (?, 'Test Family')", [churchId],
  );
  return insertId;
}

async function addPerson(churchId, familyId, active = 1) {
  await Database.query(
    "INSERT INTO individuals (church_id, first_name, last_name, family_id, is_active) VALUES (?, 'Test', 'Member', ?, ?)",
    [churchId, familyId, active],
  );
}

async function enableV2(churchId) {
  await Database.query('UPDATE church_settings SET onboarding_version = 2 WHERE church_id = ?', [churchId]);
}

test('status preserves legacy behavior and requires guided setup only when explicitly enabled', async () => {
  await withOnboarding(async ({ churchId, request }) => {
    const legacy = await request('status');
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.completed, 0);
    assert.deepEqual(legacy.body.guided, {
      version: 0,
      required: false,
      state: { step: 'gathering' },
      gatheringCount: 0,
      standardGatheringCount: 0,
      populatedFamilyCount: 0,
      canFinish: false,
    });

    await enableV2(churchId);
    const guided = await request('status');
    assert.equal(guided.status, 200);
    assert.equal(guided.body.guided.version, 2);
    assert.equal(guided.body.guided.required, true);
  });
});

test('opening guided setup opts in an empty church and retries do not reset it', async () => {
  await withOnboarding(async ({ churchId, request }) => {
    // A legacy completion flag must not prevent explicit setup when the church is empty.
    assert.equal((await request('complete', 'POST')).status, 200);
    const start = await request('guided-start', 'POST');
    assert.equal(start.status, 200);
    assert.equal(start.body.guided.required, true);

    await addGathering(churchId, 'headcount');
    assert.equal((await request('complete', 'POST')).status, 200);
    const retry = await request('guided-start', 'POST');
    assert.equal(retry.status, 200);
    assert.equal(retry.body.guided.required, false);
  });
});

test('opening guided setup rejects an existing church with archived records', async () => {
  await withOnboarding(async ({ churchId, request }) => {
    await addPerson(churchId, null, 0);
    const start = await request('guided-start', 'POST');
    assert.equal(start.status, 409);
    assert.equal((await request('status')).body.guided.version, 0);
  });
});

test('guided completion checks active scoped counts and requires a populated family for mixed attendance', async () => {
  await withOnboarding(async ({ churchId, request }) => {
    await enableV2(churchId);
    assert.equal((await request('complete', 'POST')).status, 409);
    await addGathering(churchId, 'headcount');
    await addGathering(churchId, 'standard');
    await addGathering(churchId, 'standard', 0);
    const foreignChurchId = `${churchId}_foreign`;
    await addGathering(foreignChurchId, 'standard');
    const familyId = await addFamily(churchId);
    const foreignFamily = await addFamily(foreignChurchId);
    await addPerson(churchId, familyId, 0);
    await addPerson(foreignChurchId, familyId);
    await addPerson(churchId, foreignFamily);

    const early = await request('complete', 'POST', { canFinish: true });
    assert.equal(early.status, 409);
    assert.equal(early.body.code, 'GUIDED_ONBOARDING_INCOMPLETE');
    const status = (await request('status')).body;
    assert.equal(status.completed, 0);
    assert.equal(status.guided.gatheringCount, 2);
    assert.equal(status.guided.standardGatheringCount, 1);
    assert.equal(status.guided.populatedFamilyCount, 0);
    assert.equal(status.guided.canFinish, false);

    await addPerson(churchId, familyId);
    await addPerson(churchId, familyId);
    const done = await request('complete', 'POST');
    assert.equal(done.status, 200);
    assert.equal(done.body.guided.populatedFamilyCount, 1);
    assert.equal(done.body.guided.required, false);
  });
});

test('headcount completion and invitation deferral affect only the signed-in church and administrator', async () => {
  await withOnboarding(async ({ churchId, request, addUser, adminId }) => {
    const foreignChurchId = `${churchId}_foreign`;
    await Database.query(
      "INSERT INTO church_settings (id, church_id, church_name, onboarding_version) VALUES (-1, ?, 'Foreign Church', 2)",
      [foreignChurchId],
    );
    await enableV2(churchId);
    await addGathering(churchId, 'standard', 0);
    const headcountId = await addGathering(churchId, 'headcount');
    const otherAdminId = await addUser('another-admin@example.com');
    const state = { step: 'invite', lastGatheringId: headcountId, inviteDeferred: true };
    assert.equal((await request('guided-progress', 'PUT', { state })).status, 200);
    assert.deepEqual((await request('status')).body.guided.state, state);
    assert.deepEqual((await request('status', 'GET', undefined, otherAdminId)).body.guided.state, { step: 'gathering' });

    const complete = await request('complete', 'POST');
    assert.equal(complete.status, 200);
    assert.deepEqual(complete.body.guided.state, state);
    assert.equal(complete.body.guided.canFinish, true);
    assert.equal(complete.body.guided.required, false);
    assert.equal((await request('status')).body.completed, 1);
    assert.deepEqual(await Database.query(
      'SELECT onboarding_completed FROM church_settings WHERE church_id = ?', [foreignChurchId],
    ), [{ onboarding_completed: 0 }]);
    assert.deepEqual(await Database.query(
      'SELECT user_id FROM onboarding_progress WHERE church_id = ?', [churchId],
    ), [{ user_id: adminId }]);
  });
});

test('guided progress validates the complete allowlist and the gathering reference', async () => {
  await withOnboarding(async ({ churchId, request }) => {
    const state = { step: 'people', provider: 'elvanto', mode: 'import', peopleMethod: 'copy-paste' };
    assert.equal((await request('guided-progress', 'PUT', { state })).status, 409);
    await enableV2(churchId);
    assert.equal((await request('guided-progress', 'PUT', { state })).status, 200);
    const foreignId = await addGathering(`${churchId}_foreign`, 'standard');

    for (const invalidState of [
      null, [], { step: 'complete' }, { step: 'people', provider: 'unknown' },
      { step: 'people', mode: false }, { step: 'people', peopleMethod: 'api' },
      { step: 'invite', inviteDeferred: 1 }, { step: 'gathering-created', lastGatheringId: -1 },
      { step: 'gathering-created', lastGatheringId: '1' },
      { step: 'people', accessToken: 'fixture-secret' },
      { step: 'people', roster: [{ name: 'Fixture Person' }] },
    ]) {
      assert.equal((await request('guided-progress', 'PUT', { state: invalidState })).status, 400);
    }
    assert.equal((await request('guided-progress', 'PUT', {
      state: { step: 'gathering-created', lastGatheringId: foreignId },
    })).status, 400);
    assert.deepEqual((await request('status')).body.guided.state, state);
  });
});

test('guided routes require approval and an administrator', async () => {
  await withOnboarding(async ({ churchId, request, addUser }) => {
    const memberId = await addUser('member@example.com', 'attendance_taker');
    for (const [path, method] of [['status', 'GET'], ['guided-start', 'POST'], ['guided-progress', 'PUT'], ['complete', 'POST']]) {
      assert.equal((await request(path, method, undefined, memberId)).status, 403);
    }
    Database.approveChurch(churchId, false);
    const pending = await request('guided-start', 'POST');
    assert.equal(pending.status, 403);
    assert.equal(pending.body.code, 'CHURCH_PENDING_APPROVAL');
  });
});

test('opening an existing database migrates legacy progress without opting in', async () => {
  await withOnboarding(async ({ churchId, request, adminId }) => {
    const db = Database.getChurchDb(churchId);
    db.exec('ALTER TABLE church_settings DROP COLUMN onboarding_version');
    db.exec('ALTER TABLE onboarding_progress DROP COLUMN guided_state');
    db.prepare('INSERT INTO onboarding_progress (user_id, current_step) VALUES (?, 3)').run(adminId);
    Database.closeChurchDb(churchId);
    const response = await request('status');
    assert.equal(response.status, 200);
    assert.equal(response.body.guided.version, 0);
    assert.equal(response.body.guided.required, false);
    assert.equal(response.body.progress.current_step, 3);
    assert.equal((await request('guided-start', 'POST')).status, 200);
    assert.equal((await request('guided-progress', 'PUT', { state: { step: 'people' } })).status, 200);
  });
});
