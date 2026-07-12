const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { hasLinkedPeople, notLinkedResponse, PCO_NOT_LINKED } = require('./checkinGate');

async function seedIndividual(churchId, { planningCenterId = null } = {}) {
  const res = await Database.query(
    `INSERT INTO individuals (first_name, last_name, church_id, is_active, planning_center_id)
     VALUES ('Test', 'Person', ?, 1, ?)`,
    [churchId, planningCenterId]
  );
  return res.insertId;
}

test('hasLinkedPeople: false for a church with no individuals at all', async () => {
  await withTestChurchDb(async (churchId) => {
    assert.strictEqual(await hasLinkedPeople(churchId), false);
  });
});

test('hasLinkedPeople: false when individuals exist but none have a planning_center_id', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedIndividual(churchId);
    await seedIndividual(churchId);
    assert.strictEqual(await hasLinkedPeople(churchId), false);
  });
});

test('hasLinkedPeople: true once at least one individual has a planning_center_id', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedIndividual(churchId);
    await seedIndividual(churchId, { planningCenterId: 'pco_123' });
    assert.strictEqual(await hasLinkedPeople(churchId), true);
  });
});

test('hasLinkedPeople: is scoped per church (church isolation)', async () => {
  await withTestChurchDb(async (churchIdA) => {
    await withTestChurchDb(async (churchIdB) => {
      await seedIndividual(churchIdB, { planningCenterId: 'pco_999' });
      assert.strictEqual(await hasLinkedPeople(churchIdA), false);
      assert.strictEqual(await hasLinkedPeople(churchIdB), true);
    });
  });
});

test('notLinkedResponse: default message and PCO_NOT_LINKED code', () => {
  const body = notLinkedResponse();
  assert.strictEqual(body.code, PCO_NOT_LINKED);
  assert.match(body.error, /link/i);
});

test('notLinkedResponse: accepts a custom message', () => {
  const body = notLinkedResponse('custom message');
  assert.strictEqual(body.error, 'custom message');
  assert.strictEqual(body.code, PCO_NOT_LINKED);
});
