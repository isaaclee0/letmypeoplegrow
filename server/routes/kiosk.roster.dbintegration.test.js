const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const kioskRouter = require('./kiosk');

test('adding a church person to a check-in roster does not mark them present', async () => {
  assert.equal(typeof kioskRouter.addPersonToGatheringRoster, 'function');

  await withTestChurchDb(async (churchId) => {
    const user = await Database.query(
      `INSERT INTO users (church_id, email, role, first_name, last_name, is_active)
       VALUES (?, 'leader@example.test', 'attendance_taker', 'Leader', 'One', 1)`,
      [churchId]
    );
    const gathering = await Database.query(
      `INSERT INTO gathering_types
         (church_id, name, attendance_type, frequency, is_active)
       VALUES (?, 'Evening Service', 'standard', 'weekly', 1)`,
      [churchId]
    );
    const family = await Database.query(
      `INSERT INTO families (church_id, family_name, family_type)
       VALUES (?, 'North Family', 'regular')`,
      [churchId]
    );
    const person = await Database.query(
      `INSERT INTO individuals
         (church_id, first_name, last_name, family_id, people_type, is_active)
       VALUES (?, 'Avery', 'North', ?, 'regular', 1)`,
      [churchId, Number(family.insertId)]
    );

    await kioskRouter.addPersonToGatheringRoster({
      churchId,
      gatheringTypeId: Number(gathering.insertId),
      individualId: Number(person.insertId),
      addedBy: Number(user.insertId),
    });

    const assignments = await Database.query(
      `SELECT individual_id FROM gathering_lists
       WHERE church_id = ? AND gathering_type_id = ?`,
      [churchId, Number(gathering.insertId)]
    );
    const attendance = await Database.query(
      `SELECT ar.id
       FROM attendance_records ar
       JOIN attendance_sessions s ON s.id = ar.session_id
       WHERE ar.church_id = ? AND s.gathering_type_id = ?`,
      [churchId, Number(gathering.insertId)]
    );

    assert.deepEqual(assignments.map((row) => Number(row.individual_id)), [Number(person.insertId)]);
    assert.deepEqual(attendance, []);
  });
});
