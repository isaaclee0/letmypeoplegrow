const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const logger = require('../config/logger');
logger.exceptions?.unhandle();
logger.rejections?.unhandle();
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const individualsRouter = require('./individuals');

async function withMergeFixture(fn, role = 'admin') {
  return withTestChurchDb(async () => {
    const churchId = `merge${Math.random().toString(36).slice(2, 12)}`;
    Database.getChurchDb(churchId);
    Database.getRegistryDb().prepare(
      "INSERT INTO churches (church_id, church_name, is_approved) VALUES (?, 'Merge test', 1)"
    ).run(churchId);
    await Database.setChurchContext(churchId, async () => {
      await Database.query("INSERT INTO church_settings (church_id, church_name) VALUES (?, 'Merge test')", [churchId]);
      const insert = async (sql, values = []) => Number((await Database.query(sql, values)).insertId);
      const userId = await insert("INSERT INTO users (email, role, first_name, last_name, church_id) VALUES ('admin@example.test', ?, 'Test', 'Admin', ?)", [role, churchId]);
      const familyId = await insert("INSERT INTO families (family_name, church_id) VALUES ('Retained family', ?)", [churchId]);
      const keepId = await insert("INSERT INTO individuals (first_name, last_name, family_id, church_id) VALUES ('Casey', 'Test', ?, ?)", [familyId, churchId]);
      const deleteId = await insert("INSERT INTO individuals (first_name, last_name, church_id) VALUES ('Duplicate', 'Test', ?)", [churchId]);
      const gatheringId = await insert("INSERT INTO gathering_types (name, church_id) VALUES ('Sunday', ?)", [churchId]);
      const session = (date, notes = null) => insert('INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by, church_id, notes) VALUES (?, ?, ?, ?, ?)', [gatheringId, date, userId, churchId, notes]);
      const attendance = (sessionId, individualId, present, eligible = 0, updatedAt = '2026-10-01 10:00:00') => insert(
        `INSERT INTO attendance_records (session_id, individual_id, present, eligible_at_snapshot, people_type_at_time, updated_by, updated_at, church_id)
         VALUES (?, ?, ?, ?, 'regular', ?, ?, ?)`, [sessionId, individualId, present, eligible, userId, updatedAt, churchId]);
      const link = (individualId, externalId, provider = 'planning_center') => insert(
        `INSERT INTO external_person_links (church_id, provider, external_person_id, individual_id, link_source, linked_at, last_seen_at)
         VALUES (?, ?, ?, ?, 'matched', '2026-01-01', '2026-10-04')`, [churchId, provider, externalId, individualId]);
      const previousSecret = process.env.JWT_SECRET;
      process.env.JWT_SECRET = 'merge-route-test-secret';
      const token = jwt.sign({ userId, churchId }, process.env.JWT_SECRET);
      const app = express();
      app.use(express.json());
      app.use('/api/individuals', individualsRouter);
      const server = http.createServer(app);
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const request = async (path, method, body) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/individuals${path}`, {
          method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      };
      const merge = (options = {}) => request('/deduplicate', 'POST', { keepId, deleteIds: [deleteId], mergeAssignments: true, ...options });
      try {
        await fn({ churchId, userId, familyId, keepId, deleteId, gatheringId, insert, session, attendance, link, merge, request });
      } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = previousSecret;
      }
    });
  });
}

test('duplicate merge keeps every session and present evidence wins overlaps without double counting', async () => {
  await withMergeFixture(async ({ churchId, keepId, deleteId, userId, familyId, session, attendance, merge }) => {
    const duplicateOnly = await session('2026-09-20', 'Historical session notes');
    const absentPresent = await session('2026-09-27');
    const presentAbsent = await session('2026-10-04');
    const untrackedPresent = await session('2026-10-11');
    const movedRecordId = await attendance(duplicateOnly, deleteId, 1);
    await attendance(absentPresent, keepId, 0, 1, '2026-10-02 10:00:00');
    await attendance(absentPresent, deleteId, 1, 0);
    await attendance(presentAbsent, keepId, 1);
    await attendance(presentAbsent, deleteId, 0, 1, '2026-10-02 10:00:00');
    await attendance(untrackedPresent, keepId, null);
    await attendance(untrackedPresent, deleteId, 1);

    const response = await merge();
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const records = await Database.query('SELECT * FROM attendance_records WHERE church_id = ? ORDER BY session_id', [churchId]);
    assert.equal(records.length, 4, 'both people contribute their attendance sessions');
    assert.equal(records[0].id, movedRecordId, 'a unique attendance record keeps its original provenance');
    assert.deepEqual(records.map(row => [row.individual_id, row.present, row.eligible_at_snapshot, row.updated_by, row.updated_at]), [
      [keepId, 1, 0, userId, '2026-10-01 10:00:00'],
      [keepId, 1, 1, userId, '2026-10-01 10:00:00'],
      [keepId, 1, 1, userId, '2026-10-01 10:00:00'],
      [keepId, 1, 0, userId, '2026-10-01 10:00:00'],
    ]);
    const [survivor] = await Database.query('SELECT family_id, last_attendance_date FROM individuals WHERE id = ? AND church_id = ?', [keepId, churchId]);
    assert.deepEqual(survivor, { family_id: familyId, last_attendance_date: '2026-10-11' });
    assert.equal((await Database.query('SELECT notes FROM attendance_sessions WHERE id = ? AND church_id = ?', [duplicateOnly, churchId]))[0].notes, 'Historical session notes');
    assert.equal((await Database.query('SELECT id FROM individuals WHERE id = ? AND church_id = ?', [deleteId, churchId])).length, 0);
  });
});

test('admin merge transfers a compatible locked provider identity while keeping ordinary editing locked', async () => {
  await withMergeFixture(async ({ churchId, keepId, deleteId, familyId, link, merge, request }) => {
    const linkId = await link(deleteId, 'pco-duplicate');
    await Database.query("UPDATE individuals SET planning_center_id = 'pco-duplicate', pco_has_medical_notes = 1, pco_background_check_cleared = 1 WHERE church_id = ? AND id = ?", [churchId, deleteId]);
    await Database.query("UPDATE people_sync_settings SET authority_provider = 'planning_center', people_editing_locked = 1 WHERE church_id = ?", [churchId]);
    const response = await merge();
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(await Database.query('SELECT id, individual_id, link_source, linked_at, last_seen_at FROM external_person_links WHERE church_id = ?', [churchId]), [
      { id: linkId, individual_id: keepId, link_source: 'matched', linked_at: '2026-01-01', last_seen_at: '2026-10-04' },
    ]);
    assert.deepEqual((await Database.query('SELECT first_name, family_id, planning_center_id, pco_has_medical_notes, pco_background_check_cleared FROM individuals WHERE church_id = ? AND id = ?', [churchId, keepId]))[0],
      { first_name: 'Casey', family_id: familyId, planning_center_id: 'pco-duplicate', pco_has_medical_notes: 1, pco_background_check_cleared: 1 });
    const edit = await request(`/${keepId}`, 'PUT', { firstName: 'Changed' });
    assert.equal(edit.status, 403, 'the admin merge exception must not unlock normal edits');
  });
});

test('merge preserves kiosk and notification history, match exclusions, and assignment provenance', async () => {
  await withMergeFixture(async ({ churchId, keepId, deleteId, gatheringId, userId, insert, merge }) => {
    const batchId = await insert("INSERT INTO people_sync_batches (church_id, provider, name) VALUES (?, 'planning_center', 'Members')", [churchId]);
    const assignmentId = await insert("INSERT INTO gathering_lists (church_id, gathering_type_id, individual_id, added_by, added_at, added_by_sync_batch_id) VALUES (?, ?, ?, ?, '2026-01-01', ?)", [churchId, gatheringId, deleteId, userId, batchId]);
    await insert("INSERT INTO kiosk_checkins (church_id, gathering_type_id, individual_id, session_date, action, signer_name) VALUES (?, ?, ?, '2026-10-04', 'checkin', 'Parent')", [churchId, gatheringId, deleteId]);
    const contactId = await insert("INSERT INTO contacts (church_id, first_name, last_name) VALUES (?, 'Contact', 'Test')", [churchId]);
    await insert("INSERT INTO contact_notifications (church_id, contact_id, individual_id, title, message) VALUES (?, ?, ?, 'Visit', 'Historical message')", [churchId, contactId, deleteId]);
    for (const personId of [keepId, deleteId]) {
      await insert("INSERT INTO people_sync_match_exclusions (church_id, provider, external_person_id, individual_id, created_by) VALUES (?, 'planning_center', 'different-person', ?, ?)", [churchId, personId, userId]);
      await insert('INSERT INTO absence_dismissals (church_id, gathering_type_id, individual_id, dismissed_at_streak, dismissed_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [churchId, gatheringId, personId, personId === keepId ? 2 : 4, userId, personId === keepId ? '2026-01-01' : '2026-02-01']);
    }
    const response = await merge();
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(await Database.query('SELECT id, individual_id, added_by, added_at, added_by_sync_batch_id FROM gathering_lists WHERE church_id = ?', [churchId]), [
      { id: assignmentId, individual_id: keepId, added_by: userId, added_at: '2026-01-01', added_by_sync_batch_id: batchId },
    ]);
    assert.deepEqual(await Database.query('SELECT individual_id, signer_name FROM kiosk_checkins WHERE church_id = ?', [churchId]), [{ individual_id: keepId, signer_name: 'Parent' }]);
    assert.deepEqual(await Database.query('SELECT individual_id, message FROM contact_notifications WHERE church_id = ?', [churchId]), [{ individual_id: keepId, message: 'Historical message' }]);
    assert.deepEqual(await Database.query('SELECT individual_id, external_person_id FROM people_sync_match_exclusions WHERE church_id = ?', [churchId]), [{ individual_id: keepId, external_person_id: 'different-person' }]);
    assert.deepEqual(await Database.query('SELECT individual_id, dismissed_at_streak, created_at FROM absence_dismissals WHERE church_id = ?', [churchId]), [{ individual_id: keepId, dismissed_at_streak: 4, created_at: '2026-02-01' }]);
  });
});

test('opting out of gathering assignments still preserves attendance and a legacy provider link', async () => {
  await withMergeFixture(async ({ churchId, keepId, deleteId, gatheringId, insert, session, attendance, merge }) => {
    await insert('INSERT INTO gathering_lists (church_id, gathering_type_id, individual_id) VALUES (?, ?, ?)', [churchId, gatheringId, deleteId]);
    await Database.query("UPDATE individuals SET planning_center_id = 'legacy-pco' WHERE church_id = ? AND id = ?", [churchId, deleteId]);
    await attendance(await session('2026-10-04'), deleteId, 1);
    const response = await merge({ mergeAssignments: false });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(await Database.query('SELECT individual_id, present FROM attendance_records WHERE church_id = ?', [churchId]), [{ individual_id: keepId, present: 1 }]);
    assert.equal((await Database.query('SELECT id FROM gathering_lists WHERE church_id = ?', [churchId])).length, 0);
    assert.equal((await Database.query('SELECT planning_center_id FROM individuals WHERE church_id = ? AND id = ?', [churchId, keepId]))[0].planning_center_id, 'legacy-pco');
    assert.deepEqual(await Database.query('SELECT individual_id, external_person_id FROM external_person_links WHERE church_id = ?', [churchId]), [{ individual_id: keepId, external_person_id: 'legacy-pco' }]);
  });
});

test('a compatible legacy and modern identity keeps known medical flags and existing manual assignment ownership', async () => {
  await withMergeFixture(async ({ churchId, keepId, deleteId, gatheringId, userId, insert, link, merge }) => {
    await link(deleteId, 'same-person');
    await Database.query("UPDATE individuals SET planning_center_id = 'same-person', pco_has_medical_notes = 1, pco_background_check_cleared = 0 WHERE church_id = ? AND id = ?", [churchId, keepId]);
    await Database.query('UPDATE individuals SET pco_background_check_cleared = 1 WHERE church_id = ? AND id = ?', [churchId, deleteId]);
    const manualId = await insert("INSERT INTO gathering_lists (church_id, gathering_type_id, individual_id, added_by, added_at) VALUES (?, ?, ?, ?, '2026-01-01')", [churchId, gatheringId, keepId, userId]);
    const batchId = await insert("INSERT INTO people_sync_batches (church_id, provider, name) VALUES (?, 'planning_center', 'Members')", [churchId]);
    await insert('INSERT INTO gathering_lists (church_id, gathering_type_id, individual_id, added_by_sync_batch_id) VALUES (?, ?, ?, ?)', [churchId, gatheringId, deleteId, batchId]);
    const response = await merge();
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual((await Database.query('SELECT planning_center_id, pco_has_medical_notes, pco_background_check_cleared FROM individuals WHERE church_id = ? AND id = ?', [churchId, keepId]))[0],
      { planning_center_id: 'same-person', pco_has_medical_notes: 1, pco_background_check_cleared: 0 });
    assert.deepEqual(await Database.query('SELECT id, individual_id, added_by, added_at, added_by_sync_batch_id FROM gathering_lists WHERE church_id = ?', [churchId]), [
      { id: manualId, individual_id: keepId, added_by: userId, added_at: '2026-01-01', added_by_sync_batch_id: null },
    ]);
  });
});

test('merging several duplicates retains one attendance record per session and each compatible provider identity', async () => {
  await withMergeFixture(async ({ churchId, keepId, deleteId, insert, session, attendance, link, merge }) => {
    const thirdId = await insert("INSERT INTO individuals (church_id, first_name, last_name) VALUES (?, 'Third', 'Duplicate')", [churchId]);
    await link(deleteId, 'pco-person');
    await link(thirdId, 'elvanto-person', 'elvanto');
    const commonSession = await session('2026-10-04');
    await attendance(commonSession, keepId, 0);
    await attendance(commonSession, deleteId, 0);
    await attendance(commonSession, thirdId, 1);
    const response = await merge({ deleteIds: [deleteId, thirdId] });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(await Database.query('SELECT individual_id, present FROM attendance_records WHERE church_id = ?', [churchId]), [{ individual_id: keepId, present: 1 }]);
    assert.deepEqual(await Database.query('SELECT provider, external_person_id, individual_id FROM external_person_links WHERE church_id = ? ORDER BY provider', [churchId]), [
      { provider: 'elvanto', external_person_id: 'elvanto-person', individual_id: keepId },
      { provider: 'planning_center', external_person_id: 'pco-person', individual_id: keepId },
    ]);
  });
});

test('overlapping gathering assignments retain manual protection regardless of which person is kept', async (t) => {
  for (const scenario of [
    { name: 'modern sync survivor and manual duplicate', retained: 'modern', duplicate: 'manual', expected: 'manual' },
    { name: 'legacy PCO survivor and manual duplicate', retained: 'legacy', duplicate: 'manual', expected: 'manual' },
    { name: 'both provenance columns on survivor and manual duplicate', retained: 'both', duplicate: 'manual', expected: 'manual' },
    { name: 'manual survivor and legacy PCO duplicate', retained: 'manual', duplicate: 'legacy', expected: 'manual' },
    { name: 'modern sync survivor and legacy PCO duplicate stay sync owned', retained: 'modern', duplicate: 'legacy', expected: 'modern' },
    { name: 'legacy PCO survivor and modern sync duplicate stay sync owned', retained: 'legacy', duplicate: 'modern', expected: 'legacy' },
    { name: 'opting out keeps survivor sync ownership', retained: 'modern', duplicate: 'manual', expected: 'modern', mergeAssignments: false },
  ]) {
    await t.test(scenario.name, () => withMergeFixture(async ({ churchId, keepId, deleteId, gatheringId, userId, insert, merge }) => {
      const syncBatchId = await insert("INSERT INTO people_sync_batches (church_id, provider, name) VALUES (?, 'planning_center', 'Members')", [churchId]);
      const legacyBatchId = await insert("INSERT INTO planning_center_sync_batches (church_id, name) VALUES (?, 'Legacy members')", [churchId]);
      const ownership = kind => [
        kind === 'modern' || kind === 'both' ? syncBatchId : null,
        kind === 'legacy' || kind === 'both' ? legacyBatchId : null,
      ];
      const retainedAssignmentId = await insert(`INSERT INTO gathering_lists
        (church_id, gathering_type_id, individual_id, added_by, added_at, added_by_sync_batch_id, added_by_pco_batch_id)
        VALUES (?, ?, ?, ?, '2026-01-01', ?, ?)`, [churchId, gatheringId, keepId, userId, ...ownership(scenario.retained)]);
      await insert(`INSERT INTO gathering_lists
        (church_id, gathering_type_id, individual_id, added_by, added_at, added_by_sync_batch_id, added_by_pco_batch_id)
        VALUES (?, ?, ?, NULL, '2026-02-01', ?, ?)`, [churchId, gatheringId, deleteId, ...ownership(scenario.duplicate)]);

      const response = await merge({ mergeAssignments: scenario.mergeAssignments !== false });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const [expectedSync, expectedLegacy] = ownership(scenario.expected);
      const adoptsManualDuplicate = scenario.expected === 'manual' && scenario.retained !== 'manual';
      assert.deepEqual(await Database.query(`SELECT id, individual_id, added_by, added_at,
        added_by_sync_batch_id, added_by_pco_batch_id FROM gathering_lists WHERE church_id = ?`, [churchId]), [{
        id: retainedAssignmentId,
        individual_id: keepId,
        added_by: adoptsManualDuplicate ? null : userId,
        added_at: adoptsManualDuplicate ? '2026-02-01' : '2026-01-01',
        added_by_sync_batch_id: expectedSync,
        added_by_pco_batch_id: expectedLegacy,
      }]);
    }));
  }
});

test('distinct provider identities reject the entire merge, including legacy and modern disagreement', async (t) => {
  for (const provider of ['planning_center', 'elvanto', 'legacy_disagreement']) {
    await t.test(provider, async () => withMergeFixture(async ({ churchId, keepId, deleteId, link, merge, session, attendance }) => {
      await link(deleteId, 'provider-B', provider === 'elvanto' ? 'elvanto' : 'planning_center');
      if (provider === 'legacy_disagreement') {
        await Database.query("UPDATE individuals SET planning_center_id = 'provider-A' WHERE church_id = ? AND id = ?", [churchId, deleteId]);
      } else {
        await link(keepId, 'provider-A', provider);
      }
      await attendance(await session('2026-10-04'), deleteId, 1);
      const before = await Database.query('SELECT * FROM external_person_links WHERE church_id = ? ORDER BY id', [churchId]);
      const response = await merge();
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.equal(response.body.code, 'INCOMPATIBLE_PROVIDER_IDENTITIES');
      assert.deepEqual(await Database.query('SELECT * FROM external_person_links WHERE church_id = ? ORDER BY id', [churchId]), before);
      assert.equal((await Database.query('SELECT id FROM individuals WHERE church_id = ?', [churchId])).length, 2);
      assert.deepEqual(await Database.query('SELECT individual_id FROM attendance_records WHERE church_id = ?', [churchId]), [{ individual_id: deleteId }]);
    }));
  }
});

test('foreign-church attendance references reject without deleting or rehoming any records', async () => {
  await withMergeFixture(async ({ churchId, keepId, deleteId, session, attendance, merge }) => {
    await attendance(await session('2026-10-04'), deleteId, 1);
    await attendance(await session('2026-10-11'), keepId, 0);
    await Database.query("UPDATE attendance_records SET church_id = 'otherchurch' WHERE individual_id = ? AND church_id = ?", [deleteId, churchId]);
    const before = await Database.query('SELECT * FROM attendance_records ORDER BY id');
    const response = await merge();
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.code, 'CROSS_CHURCH_MERGE_REFERENCE');
    assert.deepEqual(await Database.query('SELECT * FROM attendance_records ORDER BY id'), before);
    assert.equal((await Database.query('SELECT id FROM individuals WHERE church_id = ?', [churchId])).length, 2);
  });
});

test('a foreign-church session cannot be rehomed even when the attendance row claims the current church', async () => {
  await withMergeFixture(async ({ churchId, deleteId, session, attendance, merge }) => {
    const sessionId = await session('2026-10-04');
    await attendance(sessionId, deleteId, 1);
    await Database.query("UPDATE attendance_sessions SET church_id = 'otherchurch' WHERE id = ? AND church_id = ?", [sessionId, churchId]);
    const response = await merge();
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.code, 'CROSS_CHURCH_MERGE_REFERENCE');
    assert.deepEqual(await Database.query('SELECT individual_id FROM attendance_records WHERE church_id = ?', [churchId]), [{ individual_id: deleteId }]);
    assert.equal((await Database.query('SELECT id FROM individuals WHERE church_id = ?', [churchId])).length, 2);
  });
});

test('a late database failure rolls back attendance and transferred provider identities together', async () => {
  await withMergeFixture(async ({ churchId, keepId, deleteId, session, attendance, link, merge }) => {
    await link(deleteId, 'pco-rollback');
    await attendance(await session('2026-10-04'), deleteId, 1);
    Database.getChurchDb(churchId).exec("CREATE TRIGGER prevent_test_delete BEFORE DELETE ON individuals BEGIN SELECT RAISE(ABORT, 'test deletion failure'); END");
    const response = await merge();
    assert.equal(response.status, 500);
    assert.deepEqual(await Database.query('SELECT individual_id FROM attendance_records WHERE church_id = ?', [churchId]), [{ individual_id: deleteId }]);
    assert.deepEqual(await Database.query('SELECT individual_id FROM external_person_links WHERE church_id = ?', [churchId]), [{ individual_id: deleteId }]);
    assert.equal((await Database.query('SELECT planning_center_id FROM individuals WHERE church_id = ? AND id = ?', [churchId, keepId]))[0].planning_center_id, null);
  });
});

test('coordinators cannot invoke the admin duplicate correction', async () => {
  await withMergeFixture(async ({ churchId, merge }) => {
    assert.equal((await merge()).status, 403);
    assert.equal((await Database.query('SELECT id FROM individuals WHERE church_id = ?', [churchId])).length, 2);
  }, 'coordinator');
});
