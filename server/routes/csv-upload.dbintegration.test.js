const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');

const csv = 'FIRST NAME,LAST NAME,FAMILY NAME\nAvery,Test,Test Family\n';
function multipart(contents = csv, type = 'text/csv', field = 'csvFile') {
  const form = new FormData();
  form.append(field, new Blob([contents], { type }), 'members.csv');
  return form;
}

for (const [mount, routerFile, uploadPath, role] of [
  ['/api/csv-import', './csv-import', 'upload', 'admin'],
  ['/api/onboarding', './onboarding', 'upload-csv', 'coordinator'],
]) {
  test(`${mount} multipart upload`, async t => {
    const cwd = process.cwd();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lmpg-csv-'));
    const previousSecret = process.env.JWT_SECRET;
    t.after(async () => {
      process.chdir(cwd);
      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
      await fs.rm(dir, { recursive: true, force: true });
    });
    await fs.mkdir(path.join(dir, 'uploads'));
    process.chdir(dir);
    process.env.JWT_SECRET = 'csv-upload-test-secret';

    await withTestChurchDb(async churchId => {
      Database.getRegistryDb().prepare(
        'INSERT INTO churches (church_id, church_name, is_approved) VALUES (?, ?, 1)'
      ).run(churchId, 'Upload Test');
      const addUser = async role => (await Database.query(
        'INSERT INTO users (church_id, email, role, first_name, last_name) VALUES (?, ?, ?, ?, ?)',
        [churchId, role + '@example.test', role, 'Test', 'User']
      )).insertId;
      const owner = await addUser(role);
      const taker = await addUser('attendance_taker');
      const gathering = (await Database.query(
        'INSERT INTO gathering_types (church_id, name, created_by) VALUES (?, ?, ?)',
        [churchId, 'Upload gathering', owner]
      )).insertId;
      const app = express();
      app.use(cookieParser());
      app.use(mount, require(routerFile));
      const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
      });
      const post = (body, userId = owner, gatheringId = gathering) => {
        const headers = userId ? {
          Cookie: 'authToken=' + jwt.sign({ churchId, userId }, process.env.JWT_SECRET)
        } : {};
        return fetch(`http://127.0.0.1:${server.address().port}${mount}/${uploadPath}/${gatheringId}`,
          { method: 'POST', headers, body });
      };
      try {
        await t.test('requires an authenticated admin or coordinator', async () => {
          assert.equal((await post(multipart(), null)).status, 401);
          assert.equal((await post(multipart(), taker)).status, 403);
          assert.deepEqual(await fs.readdir('uploads'), []);
        });
        await t.test('imports a CSV file and persists the gathering assignment', async () => {
          const form = multipart();
          form.append('source', 'upload-test');
          const response = await post(form);
          const result = await response.json();
          assert.equal(response.status, 200, JSON.stringify(result));
          assert.equal(result.imported, 1);
          assert.equal(result.families, 1);
          const people = await Database.query(
            `SELECT i.first_name FROM individuals i JOIN gathering_lists gl ON gl.individual_id = i.id
             WHERE i.church_id = ? AND gl.church_id = ? AND gl.gathering_type_id = ?`,
            [churchId, churchId, gathering]
          );
          assert.deepEqual(people, [{ first_name: 'Avery' }]);
          if (mount === '/api/onboarding') {
            const [progress] = await Database.query(
              'SELECT csv_upload FROM onboarding_progress WHERE church_id = ? AND user_id = ?', [churchId, owner]
            );
            assert.equal(JSON.parse(progress.csv_upload).imported, 1);
          }
          assert.deepEqual(await fs.readdir('uploads'), []);
        });
        await t.test('rejects a mismatched MIME type without retaining the file', async () => {
          assert.equal((await post(multipart(csv, 'text/plain'))).status, 400);
          assert.deepEqual(await fs.readdir('uploads'), []);
        });
        await t.test('rejects an unexpected file field and enforces the 5 MiB limit', async () => {
          assert.equal((await post(multipart(csv, 'text/csv', 'wrongFile'))).status, 400);
          assert.equal((await post(multipart(Buffer.alloc(5 * 1024 * 1024 + 1)))).status, 413);
          assert.deepEqual(await fs.readdir('uploads'), []);
        });
        await t.test('rejects nested multipart metadata without importing the file', async () => {
          const form = multipart();
          form.append('source[label]', 'upload-test');
          const response = await post(form);
          assert.equal(response.status, 400);
          assert.equal((await response.json()).code, 'LIMIT_FIELD_NESTING');
          const [people] = await Database.query('SELECT COUNT(*) AS total FROM individuals WHERE church_id = ?', [churchId]);
          assert.equal(people.total, 1);
          assert.deepEqual(await fs.readdir('uploads'), []);
        });
        await t.test('rejects an unavailable gathering without retaining the file', async () => {
          const response = await post(multipart(), owner, Number(gathering) + 1);
          assert.equal(response.status, mount === '/api/onboarding' ? 404 : 403);
          assert.deepEqual(await fs.readdir('uploads'), []);
        });
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
    });
  });
}
