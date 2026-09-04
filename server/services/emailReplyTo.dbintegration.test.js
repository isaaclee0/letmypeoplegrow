const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../config/database');
const logger = require('../config/logger');
logger.exceptions?.unhandle();
logger.rejections?.unhandle();
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const { resolveMainAdminReplyTo } = require('./emailReplyTo');

test('resolveMainAdminReplyTo selects the earliest-created active admin with an email', async () => {
  await withTestChurchDb(async (churchId) => {
    await Database.query(
      `INSERT INTO users (church_id, email, role, first_name, is_active, created_at)
       VALUES (?, 'inactive@example.test', 'admin', 'Inactive', 0, '2026-01-01 00:00:00'),
              (?, 'coordinator@example.test', 'coordinator', 'Coordinator', 1, '2026-01-02 00:00:00'),
              (?, '', 'admin', 'No email', 1, '2026-01-03 00:00:00'),
              (?, 'main-admin@example.test', 'admin', 'Main', 1, '2026-01-04 00:00:00'),
              (?, 'later-admin@example.test', 'admin', 'Later', 1, '2026-01-05 00:00:00')`,
      [churchId, churchId, churchId, churchId, churchId],
    );

    assert.equal(await resolveMainAdminReplyTo(churchId), 'main-admin@example.test');
  });
});

test('resolveMainAdminReplyTo returns null when the church has no eligible admin email', async () => {
  await withTestChurchDb(async (churchId) => {
    await Database.query(
      `INSERT INTO users (church_id, email, role, is_active)
       VALUES (?, 'inactive@example.test', 'admin', 0),
              (?, 'coordinator@example.test', 'coordinator', 1)`,
      [churchId, churchId],
    );

    assert.equal(await resolveMainAdminReplyTo(churchId), null);
  });
});
