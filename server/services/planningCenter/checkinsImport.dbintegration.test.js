const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const {
  PCO_CHECKIN_SESSION_CANCELLED,
  ensureHeldImportSessionWithConnection,
} = require('./checkinsImport');

test('PCO present-only imports create or transition held provenance-v0 sessions and reject cancelled sessions', async () => {
  await withTestChurchDb(async (churchId) => {
    const actor = await Database.query(
      `INSERT INTO users (email, role, first_name, last_name, church_id)
       VALUES ('pco-checkins@test.example', 'admin', 'PCO', 'Admin', ?)`,
      [churchId],
    );
    const gathering = await Database.query(
      `INSERT INTO gathering_types (name, attendance_type, church_id)
       VALUES ('PCO gathering', 'standard', ?)`,
      [churchId],
    );
    const person = await Database.query(
      `INSERT INTO individuals (first_name, last_name, people_type, church_id)
       VALUES ('PCO', 'Person', 'regular', ?)`,
      [churchId],
    );

    const created = await Database.transaction((conn) => ensureHeldImportSessionWithConnection(conn, {
      churchId,
      gatheringTypeId: gathering.insertId,
      sessionDate: '2026-08-02',
      actorId: actor.insertId,
    }));
    assert.deepEqual(created, { id: created.id, created: true });

    const open = await Database.query(
      `INSERT INTO attendance_sessions
         (gathering_type_id, session_date, created_by, session_status,
          roster_snapshotted, roster_provenance_version, church_id)
       VALUES (?, '2026-08-09', ?, 'open', 0, 0, ?)`,
      [gathering.insertId, actor.insertId, churchId],
    );
    const transitioned = await Database.transaction((conn) => ensureHeldImportSessionWithConnection(conn, {
      churchId,
      gatheringTypeId: gathering.insertId,
      sessionDate: '2026-08-09',
      actorId: actor.insertId,
    }));
    assert.deepEqual(transitioned, { id: open.insertId, created: false });

    const reliableOpen = await Database.query(
      `INSERT INTO attendance_sessions
         (gathering_type_id, session_date, created_by, session_status,
          roster_snapshotted, roster_provenance_version, church_id)
       VALUES (?, '2026-08-10', ?, 'open', 1, 1, ?)`,
      [gathering.insertId, actor.insertId, churchId],
    );
    await Database.transaction((conn) => ensureHeldImportSessionWithConnection(conn, {
      churchId,
      gatheringTypeId: gathering.insertId,
      sessionDate: '2026-08-10',
      actorId: actor.insertId,
    }));

    assert.deepEqual(await Database.query(
      `SELECT session_date, session_status, roster_snapshotted, roster_provenance_version
       FROM attendance_sessions
       WHERE id IN (?, ?, ?) AND church_id = ? ORDER BY session_date`,
      [created.id, open.insertId, reliableOpen.insertId, churchId],
    ), [
      {
        session_date: '2026-08-02',
        session_status: 'held',
        roster_snapshotted: 0,
        roster_provenance_version: 0,
      },
      {
        session_date: '2026-08-09',
        session_status: 'held',
        roster_snapshotted: 0,
        roster_provenance_version: 0,
      },
      {
        session_date: '2026-08-10',
        session_status: 'held',
        roster_snapshotted: 1,
        roster_provenance_version: 1,
      },
    ]);

    const cancelled = await Database.query(
      `INSERT INTO attendance_sessions
         (gathering_type_id, session_date, created_by, session_status, church_id)
       VALUES (?, '2026-08-16', ?, 'cancelled', ?)`,
      [gathering.insertId, actor.insertId, churchId],
    );
    await assert.rejects(
      Database.transaction(async (conn) => {
        const session = await ensureHeldImportSessionWithConnection(conn, {
          churchId,
          gatheringTypeId: gathering.insertId,
          sessionDate: '2026-08-16',
          actorId: actor.insertId,
        });
        await conn.query(
          `INSERT INTO attendance_records
             (session_id, individual_id, present, people_type_at_time, church_id)
           VALUES (?, ?, 1, 'regular', ?)`,
          [session.id, person.insertId, churchId],
        );
      }),
      (error) => error.code === PCO_CHECKIN_SESSION_CANCELLED && error.statusCode === 409,
    );
    assert.deepEqual(await Database.query(
      `SELECT id FROM attendance_records WHERE session_id = ? AND church_id = ?`,
      [cancelled.insertId, churchId],
    ), []);
  });
});
