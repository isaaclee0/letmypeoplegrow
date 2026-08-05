const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  projectMedicalNotePerson,
  fetchMedicalNoteSnapshot,
  refreshMedicalNoteStatuses,
  invalidateMedicalNoteStatusCache,
} = require('./medicalNotesSync');

const SENTINEL = 'MEDICAL_SENTINEL_DO_NOT_PERSIST_8F3A';

test('projection reduces medical text immediately to a boolean', () => {
  assert.deepEqual(projectMedicalNotePerson({ type: 'Person', id: 'p1', attributes: { medical_notes: SENTINEL } }), { id: 'p1', hasMedicalNotes: true });
  assert.deepEqual(projectMedicalNotePerson({ type: 'Person', id: 'p2', attributes: { medical_notes: '  ' } }), { id: 'p2', hasMedicalNotes: false });
  assert.equal(JSON.stringify(projectMedicalNotePerson({ type: 'Person', id: 'p1', attributes: { medical_notes: SENTINEL } })).includes(SENTINEL), false);
  assert.throws(() => projectMedicalNotePerson({ type: 'Person', id: '' }), /malformed Person/);
});

test('fetch requests only medical_notes and returns a complete normalized snapshot', async () => {
  let requestedUrl;
  const snapshot = await fetchMedicalNoteSnapshot({
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    client: {
      getAll: async (url, visit) => {
        requestedUrl = url;
        await visit({ data: [
          { type: 'Person', id: '2', attributes: { medical_notes: '' } },
          { type: 'Person', id: '1', attributes: { medical_notes: SENTINEL } },
        ] });
      },
    },
  });
  assert.match(requestedUrl, /fields%5BPerson%5D=medical_notes/);
  assert.deepEqual(snapshot, {
    fetchedAt: '2026-08-05T00:00:00.000Z',
    complete: true,
    people: [{ id: '1', hasMedicalNotes: true }, { id: '2', hasMedicalNotes: false }],
  });
  assert.equal(JSON.stringify(snapshot).includes(SENTINEL), false);
});

test('refresh skips all provider work while disabled', async () => {
  invalidateMedicalNoteStatusCache();
  let tokenReads = 0;
  const result = await refreshMedicalNoteStatuses('church', {
    isTrackingEnabled: async () => false,
    withToken: async () => { tokenReads += 1; },
  });
  assert.deepEqual(result, { skipped: 'tracking_disabled', updated: 0 });
  assert.equal(tokenReads, 0);
});
