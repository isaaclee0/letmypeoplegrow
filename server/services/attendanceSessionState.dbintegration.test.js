const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ensureSessionWithConnection,
  finalizeStandardSessionWithConnection,
  finalizeHeadcountSessionWithConnection,
  setSessionState,
} = require('./attendanceSessionState');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');

async function seedActor(churchId, suffix = 'local') {
  const result = await Database.query(
    `INSERT INTO users (church_id, email, role, first_name, last_name, is_active)
     VALUES (?, ?, 'admin', 'Admin', 'User', 1)`,
    [churchId, `${suffix}-${Date.now()}-${Math.random()}@example.com`],
  );
  return result.insertId;
}

async function seedGathering(churchId, actorId, attendanceType = 'standard', name = 'Sunday') {
  const result = await Database.query(
    `INSERT INTO gathering_types
       (church_id, name, frequency, attendance_type, is_active, created_by)
     VALUES (?, ?, 'weekly', ?, 1, ?)`,
    [churchId, name, attendanceType, actorId],
  );
  return result.insertId;
}

async function seedIndividual(churchId, suffix, peopleType = 'regular') {
  const result = await Database.query(
    `INSERT INTO individuals
       (church_id, first_name, last_name, people_type, is_active)
     VALUES (?, ?, 'Person', ?, 1)`,
    [churchId, suffix, peopleType],
  );
  return result.insertId;
}

async function loadSession(churchId, sessionId) {
  const rows = await Database.query(
    `SELECT id, gathering_type_id, session_date, session_status,
            roster_snapshotted, roster_provenance_version,
            cancelled_at, cancelled_by
     FROM attendance_sessions
     WHERE id = ? AND church_id = ?`,
    [sessionId, churchId],
  );
  return rows[0];
}

test('standard finalisation captures version-1 eligibility without changing present or admitting ad-hoc attendees', async () => {
  await withTestChurchDb(async (churchId) => {
    const actorId = await seedActor(churchId);
    const gatheringTypeId = await seedGathering(churchId, actorId);
    const existingRosterId = await seedIndividual(churchId, 'Existing');
    const missingRosterId = await seedIndividual(churchId, 'Missing', 'local_visitor');
    const adHocId = await seedIndividual(churchId, 'AdHoc');

    for (const individualId of [existingRosterId, missingRosterId]) {
      await Database.query(
        `INSERT INTO gathering_lists
           (church_id, gathering_type_id, individual_id, added_by)
         VALUES (?, ?, ?, ?)`,
        [churchId, gatheringTypeId, individualId, actorId],
      );
    }

    const sessionId = await Database.transaction(async (conn) => {
      const session = await ensureSessionWithConnection(conn, {
        churchId,
        gatheringTypeId,
        sessionDate: '2026-08-16',
        actorId,
      });
      await conn.query(
        `INSERT INTO attendance_records
           (church_id, session_id, individual_id, present, eligible_at_snapshot, people_type_at_time)
         VALUES (?, ?, ?, 1, 0, 'regular'), (?, ?, ?, 1, 0, 'regular')`,
        [churchId, session.id, existingRosterId, churchId, session.id, adHocId],
      );
      await finalizeStandardSessionWithConnection(conn, {
        churchId,
        sessionId: session.id,
        gatheringTypeId,
      });
      return session.id;
    });

    assert.deepEqual(await loadSession(churchId, sessionId), {
      id: sessionId,
      gathering_type_id: gatheringTypeId,
      session_date: '2026-08-16',
      session_status: 'held',
      roster_snapshotted: 1,
      roster_provenance_version: 1,
      cancelled_at: null,
      cancelled_by: null,
    });
    assert.deepEqual(
      await Database.query(
        `SELECT individual_id, present, eligible_at_snapshot, people_type_at_time
         FROM attendance_records
         WHERE session_id = ? AND church_id = ?
         ORDER BY individual_id`,
        [sessionId, churchId],
      ),
      [
        {
          individual_id: existingRosterId,
          present: 1,
          eligible_at_snapshot: 1,
          people_type_at_time: 'regular',
        },
        {
          individual_id: missingRosterId,
          present: 0,
          eligible_at_snapshot: 1,
          people_type_at_time: 'local_visitor',
        },
        {
          individual_id: adHocId,
          present: 1,
          eligible_at_snapshot: 0,
          people_type_at_time: 'regular',
        },
      ],
    );
  });
});

test('standard finalisation captures inactive people who remain on the persisted roster', async () => {
  await withTestChurchDb(async (churchId) => {
    const actorId = await seedActor(churchId);
    const gatheringTypeId = await seedGathering(churchId, actorId);
    const existingPresentId = await seedIndividual(churchId, 'InactivePresent');
    const missingRecordId = await seedIndividual(churchId, 'InactiveMissing');

    for (const individualId of [existingPresentId, missingRecordId]) {
      await Database.query(
        `INSERT INTO gathering_lists
           (church_id, gathering_type_id, individual_id, added_by)
         VALUES (?, ?, ?, ?)`,
        [churchId, gatheringTypeId, individualId, actorId],
      );
      await Database.query(
        'UPDATE individuals SET is_active = 0 WHERE id = ? AND church_id = ?',
        [individualId, churchId],
      );
    }

    const sessionId = await Database.transaction(async (conn) => {
      const session = await ensureSessionWithConnection(conn, {
        churchId,
        gatheringTypeId,
        sessionDate: '2026-08-15',
        actorId,
      });
      await conn.query(
        `INSERT INTO attendance_records
           (church_id, session_id, individual_id, present, eligible_at_snapshot, people_type_at_time)
         VALUES (?, ?, ?, 1, 0, 'regular')`,
        [churchId, session.id, existingPresentId],
      );
      await finalizeStandardSessionWithConnection(conn, {
        churchId,
        sessionId: session.id,
        gatheringTypeId,
      });
      return session.id;
    });

    assert.deepEqual(
      await Database.query(
        `SELECT individual_id, present, eligible_at_snapshot
         FROM attendance_records
         WHERE session_id = ? AND church_id = ?
         ORDER BY individual_id`,
        [sessionId, churchId],
      ),
      [
        { individual_id: existingPresentId, present: 1, eligible_at_snapshot: 1 },
        { individual_id: missingRecordId, present: 0, eligible_at_snapshot: 1 },
      ],
    );
  });
});

test('standard finalisation is idempotent and does not expand a completed roster snapshot', async () => {
  await withTestChurchDb(async (churchId) => {
    const actorId = await seedActor(churchId);
    const gatheringTypeId = await seedGathering(churchId, actorId);
    const originalRosterId = await seedIndividual(churchId, 'Original');
    await Database.query(
      `INSERT INTO gathering_lists (church_id, gathering_type_id, individual_id, added_by)
       VALUES (?, ?, ?, ?)`,
      [churchId, gatheringTypeId, originalRosterId, actorId],
    );

    const sessionId = await Database.transaction(async (conn) => {
      const session = await ensureSessionWithConnection(conn, {
        churchId,
        gatheringTypeId,
        sessionDate: '2026-08-09',
        actorId,
      });
      await finalizeStandardSessionWithConnection(conn, {
        churchId,
        sessionId: session.id,
        gatheringTypeId,
      });
      return session.id;
    });

    const laterRosterId = await seedIndividual(churchId, 'Later');
    await Database.query(
      `INSERT INTO gathering_lists (church_id, gathering_type_id, individual_id, added_by)
       VALUES (?, ?, ?, ?)`,
      [churchId, gatheringTypeId, laterRosterId, actorId],
    );
    await Database.transaction((conn) => finalizeStandardSessionWithConnection(conn, {
      churchId,
      sessionId,
      gatheringTypeId,
    }));

    assert.deepEqual(
      await Database.query(
        `SELECT individual_id FROM attendance_records
         WHERE session_id = ? AND church_id = ? ORDER BY individual_id`,
        [sessionId, churchId],
      ),
      [{ individual_id: originalRosterId }],
    );
  });
});

test('manual held state records a standard gathering with nobody present', async () => {
  await withTestChurchDb(async (churchId) => {
    const actorId = await seedActor(churchId);
    const gatheringTypeId = await seedGathering(churchId, actorId);
    const rosterId = await seedIndividual(churchId, 'Absent');
    await Database.query(
      `INSERT INTO gathering_lists (church_id, gathering_type_id, individual_id, added_by)
       VALUES (?, ?, ?, ?)`,
      [churchId, gatheringTypeId, rosterId, actorId],
    );

    const state = await setSessionState({
      churchId,
      gatheringTypeId,
      sessionDate: '2026-08-02',
      actorId,
      status: 'held',
    });

    assert.deepEqual(state, {
      id: state.id,
      gatheringTypeId,
      sessionDate: '2026-08-02',
      status: 'held',
      rosterProvenanceVersion: 1,
      cancelledAt: null,
      cancelledBy: null,
    });
    assert.deepEqual(
      await Database.query(
        `SELECT individual_id, present, eligible_at_snapshot
         FROM attendance_records WHERE session_id = ? AND church_id = ?`,
        [state.id, churchId],
      ),
      [{ individual_id: rosterId, present: 0, eligible_at_snapshot: 1 }],
    );
  });
});

test('a submitted zero headcount finalises the session as held', async () => {
  await withTestChurchDb(async (churchId) => {
    const actorId = await seedActor(churchId);
    const gatheringTypeId = await seedGathering(churchId, actorId, 'headcount', 'Headcount');

    const sessionId = await Database.transaction(async (conn) => {
      const session = await ensureSessionWithConnection(conn, {
        churchId,
        gatheringTypeId,
        sessionDate: '2026-07-26',
        actorId,
        headcountMode: 'combined',
      });
      await conn.query(
        `INSERT INTO headcount_records (church_id, session_id, headcount, updated_by)
         VALUES (?, ?, 0, ?)`,
        [churchId, session.id, actorId],
      );
      await finalizeHeadcountSessionWithConnection(conn, { churchId, sessionId: session.id });
      return session.id;
    });

    const session = await loadSession(churchId, sessionId);
    assert.equal(session.session_status, 'held');
    assert.equal(session.roster_provenance_version, 0);
    assert.deepEqual(
      await Database.query(
        'SELECT headcount FROM headcount_records WHERE session_id = ? AND church_id = ?',
        [sessionId, churchId],
      ),
      [{ headcount: 0 }],
    );
  });
});

test('cancelling before a session exists upserts a cancelled session with audit details', async () => {
  await withTestChurchDb(async (churchId) => {
    const actorId = await seedActor(churchId);
    const gatheringTypeId = await seedGathering(churchId, actorId);

    const state = await setSessionState({
      churchId,
      gatheringTypeId,
      sessionDate: '2026-07-19',
      actorId,
      status: 'cancelled',
    });

    assert.equal(state.status, 'cancelled');
    assert.equal(state.cancelledBy, actorId);
    assert.match(state.cancelledAt, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    assert.equal(state.rosterProvenanceVersion, 0);
  });
});

test('restoring a cancelled session preserves its roster snapshot and clears cancellation audit', async () => {
  await withTestChurchDb(async (churchId) => {
    const actorId = await seedActor(churchId);
    const gatheringTypeId = await seedGathering(churchId, actorId);
    const rosterId = await seedIndividual(churchId, 'Roster');
    await Database.query(
      `INSERT INTO gathering_lists (church_id, gathering_type_id, individual_id, added_by)
       VALUES (?, ?, ?, ?)`,
      [churchId, gatheringTypeId, rosterId, actorId],
    );

    const held = await setSessionState({
      churchId,
      gatheringTypeId,
      sessionDate: '2026-07-12',
      actorId,
      status: 'held',
    });
    await setSessionState({
      churchId,
      gatheringTypeId,
      sessionDate: '2026-07-12',
      actorId,
      status: 'cancelled',
    });
    const restored = await setSessionState({
      churchId,
      gatheringTypeId,
      sessionDate: '2026-07-12',
      actorId,
      status: 'open',
    });

    assert.deepEqual(restored, {
      id: held.id,
      gatheringTypeId,
      sessionDate: '2026-07-12',
      status: 'open',
      rosterProvenanceVersion: 1,
      cancelledAt: null,
      cancelledBy: null,
    });
    const stored = await loadSession(churchId, held.id);
    assert.equal(stored.roster_snapshotted, 1);
    assert.equal(stored.roster_provenance_version, 1);
    assert.deepEqual(
      await Database.query(
        `SELECT individual_id, eligible_at_snapshot FROM attendance_records
         WHERE session_id = ? AND church_id = ?`,
        [held.id, churchId],
      ),
      [{ individual_id: rosterId, eligible_at_snapshot: 1 }],
    );
  });
});

test('held sessions cannot be cancelled while present attendance, any headcount, or a kiosk action remains', async () => {
  await withTestChurchDb(async (churchId) => {
    const actorId = await seedActor(churchId);
    const individualId = await seedIndividual(churchId, 'Active');
    const cases = [
      { activity: 'present attendance', attendanceType: 'standard', date: '2026-06-21' },
      { activity: 'zero headcount', attendanceType: 'headcount', date: '2026-06-28' },
      { activity: 'kiosk action', attendanceType: 'standard', date: '2026-07-05' },
    ];

    for (const scenario of cases) {
      const gatheringTypeId = await seedGathering(
        churchId,
        actorId,
        scenario.attendanceType,
        scenario.activity,
      );
      const held = await setSessionState({
        churchId,
        gatheringTypeId,
        sessionDate: scenario.date,
        actorId,
        status: 'held',
      });

      if (scenario.activity === 'present attendance') {
        await Database.query(
          `INSERT INTO attendance_records (church_id, session_id, individual_id, present)
           VALUES (?, ?, ?, 1)`,
          [churchId, held.id, individualId],
        );
      } else if (scenario.activity === 'zero headcount') {
        await Database.query(
          `INSERT INTO headcount_records (church_id, session_id, headcount, updated_by)
           VALUES (?, ?, 0, ?)`,
          [churchId, held.id, actorId],
        );
      } else {
        await Database.query(
          `INSERT INTO kiosk_checkins
             (church_id, gathering_type_id, session_date, individual_id, action, user_id)
           VALUES (?, ?, ?, ?, 'checkin', ?)`,
          [churchId, gatheringTypeId, scenario.date, individualId, actorId],
        );
      }

      await assert.rejects(
        setSessionState({
          churchId,
          gatheringTypeId,
          sessionDate: scenario.date,
          actorId,
          status: 'cancelled',
        }),
        (error) => error.code === 'SESSION_HAS_ACTIVITY',
        scenario.activity,
      );
      assert.equal((await loadSession(churchId, held.id)).session_status, 'held');
    }
  });
});

test('state transitions fail closed for invalid transitions and non-church gatherings', async () => {
  await withTestChurchDb(async (churchId) => {
    const actorId = await seedActor(churchId);
    const gatheringTypeId = await seedGathering(churchId, actorId);
    const foreignChurchId = `${churchId}_foreign`;
    const foreignActorId = await seedActor(foreignChurchId, 'foreign');
    const foreignGatheringId = await seedGathering(foreignChurchId, foreignActorId, 'standard', 'Foreign');

    await assert.rejects(
      setSessionState({
        churchId,
        gatheringTypeId: foreignGatheringId,
        sessionDate: '2026-06-14',
        actorId,
        status: 'cancelled',
      }),
      (error) => error.code === 'SESSION_NOT_FOUND',
    );

    const cancelled = await setSessionState({
      churchId,
      gatheringTypeId,
      sessionDate: '2026-06-14',
      actorId,
      status: 'cancelled',
    });
    await assert.rejects(
      setSessionState({
        churchId,
        gatheringTypeId,
        sessionDate: '2026-06-14',
        actorId,
        status: 'held',
      }),
      (error) => error.code === 'INVALID_SESSION_TRANSITION',
    );
    assert.equal((await loadSession(churchId, cancelled.id)).session_status, 'cancelled');
  });
});
