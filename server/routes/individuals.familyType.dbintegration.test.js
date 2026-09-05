const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const { updatePeopleSyncPolicy } = require('../services/peopleSync/authority');
const individualsRouter = require('./individuals');

test('changing the last visitor in a family to regular also makes the family regular when editing is unlocked', async () => {
  assert.equal(typeof individualsRouter.syncFamilyTypeIfUnified, 'function');

  await withTestChurchDb(async (churchId) => {
    await updatePeopleSyncPolicy(churchId, {
      syncEnabled: false,
      peopleEditingLocked: false,
    });

    const family = await Database.query(
      `INSERT INTO families (church_id, family_name, family_type)
       VALUES (?, 'River Family', 'local_visitor')`,
      [churchId]
    );
    await Database.query(
      `INSERT INTO individuals
         (church_id, first_name, last_name, family_id, people_type, is_active)
       VALUES (?, 'Jamie', 'River', ?, 'regular', 1)`,
      [churchId, Number(family.insertId)]
    );

    await individualsRouter.syncFamilyTypeIfUnified(Number(family.insertId), churchId);

    const rows = await Database.query(
      'SELECT family_type FROM families WHERE id = ? AND church_id = ?',
      [Number(family.insertId), churchId]
    );
    assert.equal(rows[0].family_type, 'regular');
  });
});
