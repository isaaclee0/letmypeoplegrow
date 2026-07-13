const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const { consolidateGatheringAssignments } = require('./families');

async function seedUser(churchId) {
  const res = await Database.query(
    `INSERT INTO users (email, role, first_name, last_name, is_active, church_id)
     VALUES (?, 'admin', 'Admin', 'User', 1, ?)`,
    [`admin-${Math.random().toString(36).slice(2)}@example.com`, churchId]
  );
  return res.insertId;
}

async function seedIndividual(churchId) {
  const res = await Database.query(
    `INSERT INTO individuals (first_name, last_name, church_id, is_active)
     VALUES ('Test', 'Person', ?, 1)`,
    [churchId]
  );
  return res.insertId;
}

async function seedGatheringType(churchId, name) {
  const res = await Database.query(
    `INSERT INTO gathering_types (name, church_id) VALUES (?, ?)`,
    [name, churchId]
  );
  return res.insertId;
}

async function assignToGathering(churchId, gatheringTypeId, individualId, addedBy) {
  await Database.query(
    `INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id)
     VALUES (?, ?, ?, ?)`,
    [gatheringTypeId, individualId, addedBy, churchId]
  );
}

async function getAssignments(churchId) {
  return Database.query(
    `SELECT gathering_type_id, individual_id, added_by
     FROM gathering_lists WHERE church_id = ?
     ORDER BY gathering_type_id, individual_id`,
    [churchId]
  );
}

test('consolidateGatheringAssignments assigns every individual to the union of gathering types held by any of them', async () => {
  await withTestChurchDb(async (churchId) => {
    const admin = await seedUser(churchId);
    const gatheringA = await seedGatheringType(churchId, 'Sunday AM');
    const gatheringB = await seedGatheringType(churchId, 'Youth Group');

    const alice = await seedIndividual(churchId);
    const bob = await seedIndividual(churchId);
    const carol = await seedIndividual(churchId);

    // Alice was only in gathering A, Bob only in gathering B, Carol in neither.
    await assignToGathering(churchId, gatheringA, alice, admin);
    await assignToGathering(churchId, gatheringB, bob, admin);

    await Database.transaction((conn) =>
      consolidateGatheringAssignments(conn, {
        individualIds: [alice, bob, carol],
        churchId,
        addedBy: admin,
      })
    );

    const assignments = await getAssignments(churchId);
    const pairs = assignments.map((a) => `${a.gathering_type_id}:${a.individual_id}`).sort();

    const expected = [
      `${gatheringA}:${alice}`,
      `${gatheringA}:${bob}`,
      `${gatheringA}:${carol}`,
      `${gatheringB}:${alice}`,
      `${gatheringB}:${bob}`,
      `${gatheringB}:${carol}`,
    ].sort();

    assert.deepStrictEqual(pairs, expected);

    // Regression guard: individual_id must always reference one of the merged
    // individuals, never a families-table id (the original bug).
    for (const a of assignments) {
      assert.ok([alice, bob, carol].includes(a.individual_id));
    }
  });
});

test('consolidateGatheringAssignments does not duplicate an existing row, and refreshes added_by via ON CONFLICT', async () => {
  await withTestChurchDb(async (churchId) => {
    const firstAdmin = await seedUser(churchId);
    const secondAdmin = await seedUser(churchId);
    const gatheringA = await seedGatheringType(churchId, 'Sunday AM');

    const alice = await seedIndividual(churchId);
    const bob = await seedIndividual(churchId);

    await assignToGathering(churchId, gatheringA, alice, firstAdmin);

    await Database.transaction((conn) =>
      consolidateGatheringAssignments(conn, {
        individualIds: [alice, bob],
        churchId,
        addedBy: secondAdmin,
      })
    );

    const assignments = await getAssignments(churchId);
    assert.strictEqual(assignments.length, 2);

    const aliceRow = assignments.find((a) => a.individual_id === alice);
    assert.strictEqual(aliceRow.added_by, secondAdmin);
  });
});
