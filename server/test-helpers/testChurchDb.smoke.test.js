const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const Database = require('../config/database');
const { withTestChurchDb } = require('./testChurchDb');

test('withTestChurchDb: real SQLite read/write works against a fresh, schema\'d church DB', async () => {
  const result = await withTestChurchDb(async (churchId) => {
    const insert = await Database.query(
      `INSERT INTO individuals (first_name, last_name, church_id) VALUES (?, ?, ?)`,
      ['Ada', 'Lovelace', churchId]
    );
    assert.ok(insert.insertId > 0, 'insert should return a new row id');

    const rows = await Database.query(
      `SELECT * FROM individuals WHERE church_id = ?`,
      [churchId]
    );
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].first_name, 'Ada');
    assert.strictEqual(rows[0].last_name, 'Lovelace');
    assert.strictEqual(rows[0].church_id, churchId);
    return churchId;
  });

  assert.match(result, /^test_/);
});

test('withTestChurchDb: temp directory is deleted after the call returns', async () => {
  let capturedTempDir;

  await withTestChurchDb(
    async () => {
      assert.ok(fs.existsSync(capturedTempDir), 'temp dir should exist while fn runs');
    },
    ({ tempDir }) => {
      capturedTempDir = tempDir;
    }
  );

  assert.ok(capturedTempDir, 'onReady should have been called with a tempDir');
  assert.strictEqual(
    fs.existsSync(capturedTempDir),
    false,
    'temp dir should have been removed by cleanup'
  );
});

test('withTestChurchDb: cleans up even when fn throws', async () => {
  let capturedTempDir;

  await assert.rejects(
    () =>
      withTestChurchDb(
        async () => {
          throw new Error('boom');
        },
        ({ tempDir }) => {
          capturedTempDir = tempDir;
        }
      ),
    /boom/
  );

  assert.ok(capturedTempDir, 'onReady should have been called with a tempDir');
  assert.strictEqual(
    fs.existsSync(capturedTempDir),
    false,
    'temp dir should have been removed by cleanup even after fn throws'
  );
});

test('withTestChurchDb: two sequential calls get distinct, isolated church databases', async () => {
  const churchIds = [];

  const first = await withTestChurchDb(async (churchId) => {
    churchIds.push(churchId);
    await Database.query(
      `INSERT INTO individuals (first_name, last_name, church_id) VALUES (?, ?, ?)`,
      ['First', 'Church', churchId]
    );
    const rows = await Database.query(`SELECT * FROM individuals`);
    return rows.length;
  });

  const second = await withTestChurchDb(async (churchId) => {
    churchIds.push(churchId);
    // A fresh church DB should not see the previous call's row — proves
    // isolation, not just a different churchId label.
    const rows = await Database.query(`SELECT * FROM individuals`);
    assert.strictEqual(rows.length, 0, 'second call should start with an empty individuals table');

    await Database.query(
      `INSERT INTO individuals (first_name, last_name, church_id) VALUES (?, ?, ?)`,
      ['Second', 'Church', churchId]
    );
    const rowsAfter = await Database.query(`SELECT * FROM individuals`);
    return rowsAfter.length;
  });

  assert.strictEqual(churchIds.length, 2);
  assert.notStrictEqual(churchIds[0], churchIds[1], 'sequential calls should get distinct church ids');
  assert.strictEqual(first, 1);
  assert.strictEqual(second, 1);
});
