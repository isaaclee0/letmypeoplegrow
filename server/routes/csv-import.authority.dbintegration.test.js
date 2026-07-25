const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const { beginAuthoritySwitch, commitAuthoritySwitch } = require('../services/peopleSync/authority');
const csvImportRouter = require('./csv-import');

async function withRouteChurchDb(fn) {
  return withTestChurchDb(async () => {
    const churchId = `tst${Math.random().toString(36).slice(2, 12)}`;
    Database.getChurchDb(churchId);
    await Database.queryForChurch(
      churchId,
      `INSERT INTO church_settings (church_id, church_name) VALUES (?, 'CSV Test Church')`,
      [churchId]
    );
    return Database.setChurchContext(churchId, () => fn(churchId));
  });
}

async function startCsvRouteApp(churchId) {
  const user = await Database.query(
    `INSERT INTO users (email, role, first_name, last_name, is_active, church_id)
     VALUES (?, 'admin', 'CSV', 'Admin', 1, ?)`,
    [`csv-${Math.random().toString(36).slice(2)}@example.com`, churchId]
  );
  const gathering = await Database.query(
    `INSERT INTO gathering_types (name, church_id) VALUES ('CSV Gathering', ?)`,
    [churchId]
  );
  Database.getRegistryDb().prepare(
    `INSERT INTO churches (church_id, church_name, is_approved) VALUES (?, 'CSV Test Church', 1)`
  ).run(churchId);

  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'csv-authority-route-test-secret';
  const token = jwt.sign({ userId: user.insertId, churchId }, process.env.JWT_SECRET);
  const app = express();
  app.use(express.json());
  app.use('/api/csv-import', csvImportRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    upload: async () => {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/csv-import/upload/${gathering.insertId}`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
      );
      return { status: response.status, body: await response.json() };
    },
    copyPaste: async () => {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/csv-import/copy-paste`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: 'First\tLast' }),
        }
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

for (const provider of ['elvanto', 'planning_center']) {
  test(`CSV regular creation is blocked while ${provider} is authoritative`, async () => {
    await withRouteChurchDb(async (churchId) => {
      await beginAuthoritySwitch(churchId, provider);
      await commitAuthoritySwitch(churchId, provider);
      const app = await startCsvRouteApp(churchId);
      try {
        const response = await app.upload();
        assert.strictEqual(response.status, 403);
        assert.strictEqual(response.body.code, 'PEOPLE_SOURCE_LOCKED');
        assert.strictEqual(response.body.provider, provider);
        assert.strictEqual(response.body.action, 'import');

        const copyPasteResponse = await app.copyPaste();
        assert.strictEqual(copyPasteResponse.status, 403);
        assert.strictEqual(copyPasteResponse.body.code, 'PEOPLE_SOURCE_LOCKED');
        assert.strictEqual(copyPasteResponse.body.provider, provider);
        assert.strictEqual(copyPasteResponse.body.action, 'import');
      } finally {
        await app.close();
      }
    });
  });
}
