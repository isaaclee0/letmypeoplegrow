const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeMedicalNoteColor,
  normalizeMedicalNotesInput,
  roleCanViewMedicalNotes,
} = require('./medicalNotesPolicy');

test('medical-note role threshold is hierarchical and fails closed', () => {
  assert.equal(roleCanViewMedicalNotes('admin', 'admin'), true);
  assert.equal(roleCanViewMedicalNotes('admin', 'coordinator'), false);
  assert.equal(roleCanViewMedicalNotes('coordinator', 'admin'), true);
  assert.equal(roleCanViewMedicalNotes('coordinator', 'attendance_taker'), false);
  assert.equal(roleCanViewMedicalNotes('attendance_taker', 'attendance_taker'), true);
  assert.equal(roleCanViewMedicalNotes('unknown', 'admin'), false);
});

test('medical-note settings normalize safe appearance and gathering values', () => {
  assert.equal(normalizeMedicalNoteColor('#FACC15'), '#facc15');
  assert.deepEqual(normalizeMedicalNotesInput({
    enabled: true,
    minimumRole: 'coordinator',
    gatheringTypeIds: [3, 1, 3],
    badgeIcon: 'heart',
    badgeColor: '#FACC15',
    adoptExistingAppearance: true,
  }), {
    enabled: true,
    minimumRole: 'coordinator',
    gatheringTypeIds: [1, 3],
    badgeIcon: 'heart',
    badgeColor: '#facc15',
    adoptExistingAppearance: true,
  });
});

test('medical-note settings reject invalid or incomplete enabled values', () => {
  assert.throws(() => normalizeMedicalNoteColor('yellow'), /MEDICAL_NOTES_COLOR_INVALID/);
  assert.throws(() => normalizeMedicalNoteColor('#fff'), /MEDICAL_NOTES_COLOR_INVALID/);
  assert.throws(() => normalizeMedicalNotesInput({ enabled: true, minimumRole: 'admin', gatheringTypeIds: [1], badgeIcon: 'cross', badgeColor: '#facc15' }), /MEDICAL_NOTES_ICON_INVALID/);
  assert.throws(() => normalizeMedicalNotesInput({ enabled: true, minimumRole: 'admin', gatheringTypeIds: [], badgeIcon: 'heart', badgeColor: '#facc15' }), /MEDICAL_NOTES_GATHERINGS_REQUIRED/);
});
