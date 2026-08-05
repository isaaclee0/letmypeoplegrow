const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { applyMedicalNoteSnapshot } = require('./medicalNotesSync');

test('complete snapshots update linked booleans without changing person timestamps or persisting text', async () => {
  await withTestChurchDb(async (churchId) => {
    await Database.query(
      `INSERT INTO individuals
       (first_name, last_name, church_id, planning_center_id, is_active, pco_has_medical_notes, updated_at)
       VALUES ('Yes', 'Person', ?, 'p1', 1, 0, '2020-01-01'),
              ('Missing', 'Person', ?, 'p2', 1, 1, '2020-01-02'),
              ('Inactive', 'Person', ?, 'p3', 0, 1, '2020-01-03'),
              ('Unlinked', 'Person', ?, NULL, 1, 1, '2020-01-04')`,
      [churchId, churchId, churchId, churchId]
    );
    const result = await applyMedicalNoteSnapshot(churchId, {
      fetchedAt: '2026-08-05T00:00:00.000Z',
      complete: true,
      people: [{ id: 'p1', hasMedicalNotes: true }],
    });
    assert.deepEqual(result, { fetchedAt: '2026-08-05T00:00:00.000Z', updated: 2, present: 1, absent: 1, clearedStale: 2 });
    const rows = await Database.query(
      'SELECT first_name, pco_has_medical_notes AS medical, updated_at FROM individuals WHERE church_id = ? ORDER BY id', [churchId]
    );
    assert.deepEqual(rows, [
      { first_name: 'Yes', medical: 1, updated_at: '2020-01-01' },
      { first_name: 'Missing', medical: 0, updated_at: '2020-01-02' },
      { first_name: 'Inactive', medical: 0, updated_at: '2020-01-03' },
      { first_name: 'Unlinked', medical: 0, updated_at: '2020-01-04' },
    ]);
    const [settings] = await Database.query(
      'SELECT planning_center_medical_notes_last_refresh_result AS result FROM church_settings WHERE church_id = ?', [churchId]
    );
    assert.equal(settings.result.includes('MEDICAL_SENTINEL_DO_NOT_PERSIST_8F3A'), false);
  });
});

test('incomplete snapshots fail closed without mutating booleans', async () => {
  await withTestChurchDb(async (churchId) => {
    await Database.query(
      `INSERT INTO individuals (first_name, last_name, church_id, planning_center_id, pco_has_medical_notes)
       VALUES ('Keep', 'Person', ?, 'p1', 1)`, [churchId]
    );
    await assert.rejects(() => applyMedicalNoteSnapshot(churchId, { complete: false, people: [] }), /complete/);
    const [row] = await Database.query('SELECT pco_has_medical_notes AS medical FROM individuals WHERE church_id = ?', [churchId]);
    assert.equal(row.medical, 1);
  });
});
