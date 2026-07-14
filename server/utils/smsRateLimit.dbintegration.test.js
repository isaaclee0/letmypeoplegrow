const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const { checkSmsSendAllowed, recordSmsSend } = require('./smsRateLimit');

async function seedSend(churchId, contactIdentifier, offset) {
  await Database.queryForChurch(
    churchId,
    `INSERT INTO sms_send_log (church_id, contact_identifier, sent_at) VALUES (?, ?, datetime('now', ?))`,
    [churchId, contactIdentifier, offset]
  );
}

test('checkSmsSendAllowed allows a first send for a contact with no history', async () => {
  await withTestChurchDb(async (churchId) => {
    const result = await checkSmsSendAllowed(churchId, '+61400000001');
    assert.deepStrictEqual(result, { allowed: true });
  });
});

test('checkSmsSendAllowed blocks a second send within the cooldown window', async () => {
  await withTestChurchDb(async (churchId) => {
    await recordSmsSend(churchId, '+61400000002');
    const result = await checkSmsSendAllowed(churchId, '+61400000002');
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, 'cooldown');
  });
});

test('checkSmsSendAllowed allows a send once the cooldown window has passed', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedSend(churchId, '+61400000003', '-60 seconds');
    const result = await checkSmsSendAllowed(churchId, '+61400000003');
    assert.deepStrictEqual(result, { allowed: true });
  });
});

test('checkSmsSendAllowed blocks once the daily limit is reached', async () => {
  await withTestChurchDb(async (churchId) => {
    for (let i = 0; i < 10; i++) {
      await seedSend(churchId, '+61400000004', `-${i + 1} hours`);
    }
    const result = await checkSmsSendAllowed(churchId, '+61400000004');
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, 'daily_limit');
  });
});

test('checkSmsSendAllowed does not count sends older than 24h toward the daily limit', async () => {
  await withTestChurchDb(async (churchId) => {
    for (let i = 0; i < 10; i++) {
      await seedSend(churchId, '+61400000005', '-2 days');
    }
    const result = await checkSmsSendAllowed(churchId, '+61400000005');
    assert.deepStrictEqual(result, { allowed: true });
  });
});

test('checkSmsSendAllowed scopes cooldown and daily limit per contact_identifier', async () => {
  await withTestChurchDb(async (churchId) => {
    for (let i = 0; i < 10; i++) {
      await seedSend(churchId, '+61400000006', `-${i + 1} hours`);
    }
    const blocked = await checkSmsSendAllowed(churchId, '+61400000006');
    const allowed = await checkSmsSendAllowed(churchId, '+61400000007');
    assert.strictEqual(blocked.allowed, false);
    assert.deepStrictEqual(allowed, { allowed: true });
  });
});

test('recordSmsSend prunes rows older than the retention window', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedSend(churchId, '+61400000008', '-3 days');
    await recordSmsSend(churchId, '+61400000009');

    const remaining = await Database.queryForChurch(
      churchId,
      `SELECT contact_identifier FROM sms_send_log ORDER BY contact_identifier`,
      []
    );
    assert.deepStrictEqual(
      remaining.map((r) => r.contact_identifier),
      ['+61400000009']
    );
  });
});
