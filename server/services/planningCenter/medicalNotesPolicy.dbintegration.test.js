const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const {
  getMedicalNotesSettings,
  listAdoptableBadgeAppearances,
  saveMedicalNotesSettings,
  disableMedicalNotesWithConnection,
} = require('./medicalNotesPolicy');

async function addPerson(churchId, values) {
  return Database.query(
    `INSERT INTO individuals
       (first_name, last_name, church_id, is_active, badge_icon, badge_color, badge_text, pco_has_medical_notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [values.firstName, 'Person', churchId, values.active ? 1 : 0,
      values.icon, values.color, values.text, values.medical ? 1 : 0]
  );
}

test('appearance discovery groups active and archived icon-only badges', async () => {
  await withTestChurchDb(async (churchId) => {
    await addPerson(churchId, { firstName: 'Active', active: true, icon: 'heart', color: '#FACC15', text: null });
    await addPerson(churchId, { firstName: 'Archived', active: false, icon: 'heart', color: '#facc15', text: ' ' });
    await addPerson(churchId, { firstName: 'Text', active: true, icon: 'heart', color: '#facc15', text: 'VIP' });
    await addPerson(churchId, { firstName: 'Invalid', active: true, icon: 'heart', color: 'yellow', text: null });
    await addPerson(churchId, { firstName: 'Star', active: true, icon: 'star', color: '#ef4444', text: null });

    assert.deepEqual(await listAdoptableBadgeAppearances(churchId), [
      { icon: 'heart', color: '#facc15', count: 2 },
      { icon: 'star', color: '#ef4444', count: 1 },
    ]);
  });
});

test('confirmed adoption atomically clears exact badges and stores scoped settings', async () => {
  await withTestChurchDb(async (churchId) => {
    const gathering = await Database.query(
      `INSERT INTO gathering_types (name, attendance_type, is_active, church_id)
       VALUES ('Sunday', 'standard', 1, ?)`, [churchId]
    );
    await addPerson(churchId, { firstName: 'Active', active: true, icon: 'heart', color: '#FACC15', text: null, medical: true });
    await addPerson(churchId, { firstName: 'Archived', active: false, icon: 'heart', color: '#facc15', text: '', medical: true });
    await addPerson(churchId, { firstName: 'Text', active: true, icon: 'heart', color: '#facc15', text: 'Keep', medical: true });

    const result = await saveMedicalNotesSettings(churchId, { userId: null, ipAddress: '127.0.0.1', userAgent: 'test' }, {
      enabled: true,
      minimumRole: 'coordinator',
      gatheringTypeIds: [gathering.insertId],
      badgeIcon: 'heart',
      badgeColor: '#FACC15',
      adoptExistingAppearance: true,
    });
    assert.equal(result.adoptedCount, 2);
    assert.equal(result.settings.badgeColor, '#facc15');

    const people = await Database.query('SELECT first_name, badge_icon, badge_color FROM individuals WHERE church_id = ? ORDER BY id', [churchId]);
    assert.deepEqual(people, [
      { first_name: 'Active', badge_icon: null, badge_color: null },
      { first_name: 'Archived', badge_icon: null, badge_color: null },
      { first_name: 'Text', badge_icon: 'heart', badge_color: '#facc15' },
    ]);
    const [audit] = await Database.query("SELECT new_values FROM audit_log WHERE church_id = ? AND action = 'ADOPT_PCO_MEDICAL_BADGE'", [churchId]);
    assert.deepEqual(JSON.parse(audit.new_values), { icon: 'heart', color: '#facc15', affectedCount: 2 });
  });
});

test('disable clears booleans while retaining appearance and scope', async () => {
  await withTestChurchDb(async (churchId) => {
    const gathering = await Database.query("INSERT INTO gathering_types (name, church_id) VALUES ('Sunday', ?)", [churchId]);
    await Database.query(
      `UPDATE church_settings SET planning_center_medical_notes_enabled = 1,
       planning_center_medical_notes_badge_icon = 'heart', planning_center_medical_notes_badge_color = '#facc15'
       WHERE church_id = ?`, [churchId]
    );
    await Database.query('INSERT INTO planning_center_medical_note_gatherings (church_id, gathering_type_id) VALUES (?, ?)', [churchId, gathering.insertId]);
    await addPerson(churchId, { firstName: 'Medical', active: true, icon: null, color: null, text: null, medical: true });

    await Database.transactionForChurch(churchId, (conn) => disableMedicalNotesWithConnection(conn, churchId));

    const settings = await getMedicalNotesSettings(churchId);
    assert.equal(settings.enabled, false);
    assert.equal(settings.badgeIcon, 'heart');
    assert.deepEqual(settings.gatheringTypeIds, [gathering.insertId]);
    const [person] = await Database.query('SELECT pco_has_medical_notes AS medical FROM individuals WHERE church_id = ?', [churchId]);
    assert.equal(person.medical, 0);
  });
});
