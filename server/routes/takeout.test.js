const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');
const AdmZip = require('adm-zip');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const takeoutRouter = require('./takeout');

test('data export filename uses the church-local calendar date', () => {
  assert.equal(
    takeoutRouter.exportFilename('Australia/Hobart', new Date('2026-08-13T14:30:00Z')),
    'church-data-export-2026-08-14.zip',
  );
});

test('an admin downloads their church CSVs as a ZIP with credentials redacted', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'takeout-test-secret';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  await withTestChurchDb(async (churchId) => {
    Database.ensureChurch(churchId, 'Export church');
    Database.approveChurch(churchId, true);
    const { insertId } = await Database.query(
      "INSERT INTO users (church_id, email, role) VALUES (?, ?, 'admin')", [churchId, 'admin@example.test'],
    );
    const otherChurch = churchId + '_other';
    Database.ensureChurch(otherChurch, 'Another church');
    await Database.queryForChurch(otherChurch,
      'INSERT INTO users (church_id, email) VALUES (?, ?)', [otherChurch, 'other@example.test'],
    );
    await Database.query(
      'INSERT INTO user_preferences (church_id, user_id, preference_key, preference_value) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
      [churchId, insertId, 'theme', 'dark', churchId, insertId, 'planning_center_tokens', 'test-credential'],
    );

    const app = express();
    app.use('/api/takeout', takeoutRouter);
    const server = app.listen(0, '127.0.0.1');
    t.after(() => new Promise(resolve => server.close(resolve)));
    await once(server, 'listening');
    const token = jwt.sign({ userId: insertId, churchId }, process.env.JWT_SECRET);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/takeout/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/zip/);
    const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
    const users = zip.readAsText('users.csv');
    assert.ok(users.includes('admin@example.test'));
    assert.ok(!users.includes('other@example.test'));
    const preferences = zip.readAsText('user_preferences.csv');
    assert.ok(preferences.includes('dark'));
    assert.ok(!preferences.includes('test-credential'));
  });
});
