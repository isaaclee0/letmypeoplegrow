const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('./database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');

test('fresh church databases default medical-note indicators off and cascade gathering scope', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualColumns = await Database.query('PRAGMA table_info(individuals)');
    const medicalColumn = individualColumns.find(({ name }) => name === 'pco_has_medical_notes');
    assert.ok(medicalColumn);
    assert.equal(medicalColumn.notnull, 1);
    assert.equal(medicalColumn.dflt_value, '0');

    const [settings] = await Database.query(
      `SELECT planning_center_medical_notes_enabled AS enabled,
              planning_center_medical_notes_minimum_role AS minimumRole,
              planning_center_medical_notes_badge_icon AS badgeIcon,
              planning_center_medical_notes_badge_color AS badgeColor,
              planning_center_medical_notes_last_refreshed_at AS refreshedAt,
              planning_center_medical_notes_last_refresh_result AS refreshResult
         FROM church_settings WHERE church_id = ?`,
      [churchId]
    );
    assert.deepEqual(settings, {
      enabled: 0,
      minimumRole: 'admin',
      badgeIcon: null,
      badgeColor: null,
      refreshedAt: null,
      refreshResult: null,
    });

    const gathering = await Database.query(
      `INSERT INTO gathering_types (name, church_id) VALUES ('Sunday', ?)`,
      [churchId]
    );
    await Database.query(
      `INSERT INTO planning_center_medical_note_gatherings (church_id, gathering_type_id)
       VALUES (?, ?)`,
      [churchId, gathering.insertId]
    );
    await Database.query('DELETE FROM gathering_types WHERE id = ? AND church_id = ?', [gathering.insertId, churchId]);
    const [{ count }] = await Database.query(
      'SELECT COUNT(*) AS count FROM planning_center_medical_note_gatherings WHERE church_id = ?',
      [churchId]
    );
    assert.equal(count, 0);
  });
});
