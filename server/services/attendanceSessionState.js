const Database = require('../config/database');

const SESSION_NOT_FOUND = 'SESSION_NOT_FOUND';
const INVALID_SESSION_TRANSITION = 'INVALID_SESSION_TRANSITION';
const SESSION_HAS_ACTIVITY = 'SESSION_HAS_ACTIVITY';

function sessionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function notFoundError() {
  return sessionError(SESSION_NOT_FOUND, 'Attendance session or gathering was not found.');
}

function invalidTransitionError(fromStatus, toStatus) {
  return sessionError(
    INVALID_SESSION_TRANSITION,
    `Attendance session cannot change from ${fromStatus} to ${toStatus}.`,
  );
}

function activityError() {
  return sessionError(
    SESSION_HAS_ACTIVITY,
    'Correct present attendance, headcount submissions, and check-in activity before cancelling this session.',
  );
}

function mapSession(row) {
  return {
    id: row.id,
    gatheringTypeId: row.gathering_type_id,
    sessionDate: row.session_date,
    status: row.session_status,
    rosterProvenanceVersion: row.roster_provenance_version,
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by,
  };
}

async function findGatheringWithConnection(conn, { churchId, gatheringTypeId }) {
  const rows = await conn.query(
    `SELECT id, attendance_type
     FROM gathering_types
     WHERE id = ? AND church_id = ?`,
    [gatheringTypeId, churchId],
  );
  if (rows.length === 0) throw notFoundError();
  return rows[0];
}

async function findSessionWithConnection(conn, { churchId, gatheringTypeId, sessionDate }) {
  const rows = await conn.query(
    `SELECT id, gathering_type_id, session_date, session_status,
            roster_provenance_version, cancelled_at, cancelled_by
     FROM attendance_sessions
     WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?`,
    [gatheringTypeId, sessionDate, churchId],
  );
  return rows[0] || null;
}

async function loadSessionByIdWithConnection(conn, { churchId, sessionId, gatheringTypeId }) {
  const params = [sessionId, churchId];
  let gatheringClause = '';
  if (gatheringTypeId !== undefined) {
    gatheringClause = ' AND gathering_type_id = ?';
    params.push(gatheringTypeId);
  }
  const rows = await conn.query(
    `SELECT id, gathering_type_id, session_date, session_status,
            roster_snapshotted, roster_provenance_version,
            cancelled_at, cancelled_by
     FROM attendance_sessions
     WHERE id = ? AND church_id = ?${gatheringClause}`,
    params,
  );
  if (rows.length === 0) throw notFoundError();
  return rows[0];
}

async function ensureSessionWithConnection(conn, {
  churchId,
  gatheringTypeId,
  sessionDate,
  actorId,
  headcountMode,
}) {
  await findGatheringWithConnection(conn, { churchId, gatheringTypeId });

  let session = await findSessionWithConnection(conn, {
    churchId,
    gatheringTypeId,
    sessionDate,
  });
  if (!session) {
    const columns = ['church_id', 'gathering_type_id', 'session_date', 'created_by'];
    const values = [churchId, gatheringTypeId, sessionDate, actorId];
    if (headcountMode !== undefined) {
      columns.push('headcount_mode');
      values.push(headcountMode);
    }
    const result = await conn.query(
      `INSERT INTO attendance_sessions (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`,
      values,
    );
    session = (await conn.query(
      `SELECT id, gathering_type_id, session_date, session_status,
              roster_provenance_version, cancelled_at, cancelled_by
       FROM attendance_sessions
       WHERE id = ? AND church_id = ?`,
      [result.insertId, churchId],
    ))[0];
  }
  return mapSession(session);
}

async function finalizeStandardSessionWithConnection(conn, {
  churchId,
  sessionId,
  gatheringTypeId,
}) {
  const gathering = await findGatheringWithConnection(conn, { churchId, gatheringTypeId });
  if (gathering.attendance_type !== 'standard') throw notFoundError();

  const session = await loadSessionByIdWithConnection(conn, {
    churchId,
    sessionId,
    gatheringTypeId,
  });
  if (session.session_status === 'cancelled') {
    throw invalidTransitionError('cancelled', 'held');
  }

  if (session.roster_provenance_version !== 1) {
    await conn.query(
      `INSERT INTO attendance_records
         (church_id, session_id, individual_id, present,
          eligible_at_snapshot, people_type_at_time)
       SELECT ?, ?, i.id, 0, 1, i.people_type
       FROM gathering_lists gl
       JOIN individuals i
         ON i.id = gl.individual_id AND i.church_id = ?
       WHERE gl.gathering_type_id = ?
         AND gl.church_id = ?
         AND i.is_active = 1
       ON CONFLICT(session_id, individual_id) DO NOTHING`,
      [churchId, sessionId, churchId, gatheringTypeId, churchId],
    );
    await conn.query(
      `UPDATE attendance_records
       SET eligible_at_snapshot = 1,
           people_type_at_time = COALESCE(
             people_type_at_time,
             (SELECT i.people_type FROM individuals i
              WHERE i.id = attendance_records.individual_id AND i.church_id = ?)
           )
       WHERE session_id = ?
         AND church_id = ?
         AND individual_id IN (
           SELECT gl.individual_id
           FROM gathering_lists gl
           JOIN individuals i
             ON i.id = gl.individual_id AND i.church_id = ?
           WHERE gl.gathering_type_id = ?
             AND gl.church_id = ?
             AND i.is_active = 1
         )`,
      [churchId, sessionId, churchId, churchId, gatheringTypeId, churchId],
    );
  }

  await conn.query(
    `UPDATE attendance_sessions
     SET roster_snapshotted = 1,
         roster_provenance_version = 1,
         session_status = 'held',
         updated_at = datetime('now')
     WHERE id = ? AND church_id = ?`,
    [sessionId, churchId],
  );
  return mapSession(await loadSessionByIdWithConnection(conn, { churchId, sessionId }));
}

async function finalizeHeadcountSessionWithConnection(conn, { churchId, sessionId }) {
  const session = await loadSessionByIdWithConnection(conn, { churchId, sessionId });
  const gathering = await findGatheringWithConnection(conn, {
    churchId,
    gatheringTypeId: session.gathering_type_id,
  });
  if (gathering.attendance_type !== 'headcount') throw notFoundError();
  if (session.session_status === 'cancelled') {
    throw invalidTransitionError('cancelled', 'held');
  }

  await conn.query(
    `UPDATE attendance_sessions
     SET session_status = 'held', updated_at = datetime('now')
     WHERE id = ? AND church_id = ?`,
    [sessionId, churchId],
  );
  return mapSession(await loadSessionByIdWithConnection(conn, { churchId, sessionId }));
}

async function assertHeldSessionHasNoActivity(conn, session, churchId) {
  const attendance = await conn.query(
    `SELECT 1
     FROM attendance_records
     WHERE session_id = ? AND church_id = ? AND present = 1
     LIMIT 1`,
    [session.id, churchId],
  );
  const headcount = await conn.query(
    `SELECT 1
     FROM headcount_records
     WHERE session_id = ? AND church_id = ?
     LIMIT 1`,
    [session.id, churchId],
  );
  const checkins = await conn.query(
    `SELECT 1
     FROM kiosk_checkins
     WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?
     LIMIT 1`,
    [session.gathering_type_id, session.session_date, churchId],
  );
  if (attendance.length > 0 || headcount.length > 0 || checkins.length > 0) {
    throw activityError();
  }
}

async function setSessionState({ churchId, gatheringTypeId, sessionDate, actorId, status }) {
  if (!['open', 'held', 'cancelled'].includes(status)) {
    throw invalidTransitionError('unknown', status);
  }

  return Database.transactionForChurch(churchId, async (conn) => {
    const gathering = await findGatheringWithConnection(conn, { churchId, gatheringTypeId });
    let session = await findSessionWithConnection(conn, {
      churchId,
      gatheringTypeId,
      sessionDate,
    });

    if (!session) {
      if (status === 'open') throw notFoundError();
      await ensureSessionWithConnection(conn, {
        churchId,
        gatheringTypeId,
        sessionDate,
        actorId,
      });
      session = await findSessionWithConnection(conn, {
        churchId,
        gatheringTypeId,
        sessionDate,
      });
    }

    if (status === 'held') {
      if (session.session_status !== 'open') {
        throw invalidTransitionError(session.session_status, status);
      }
      if (gathering.attendance_type === 'headcount') {
        return finalizeHeadcountSessionWithConnection(conn, { churchId, sessionId: session.id });
      }
      return finalizeStandardSessionWithConnection(conn, {
        churchId,
        sessionId: session.id,
        gatheringTypeId,
      });
    }

    if (status === 'cancelled') {
      if (!['open', 'held'].includes(session.session_status)) {
        throw invalidTransitionError(session.session_status, status);
      }
      if (session.session_status === 'held') {
        await assertHeldSessionHasNoActivity(conn, session, churchId);
      }
      await conn.query(
        `UPDATE attendance_sessions
         SET session_status = 'cancelled',
             cancelled_at = datetime('now'),
             cancelled_by = ?,
             updated_at = datetime('now')
         WHERE id = ? AND church_id = ?`,
        [actorId, session.id, churchId],
      );
      return mapSession(await loadSessionByIdWithConnection(conn, {
        churchId,
        sessionId: session.id,
      }));
    }

    if (session.session_status !== 'cancelled') {
      throw invalidTransitionError(session.session_status, status);
    }
    await conn.query(
      `UPDATE attendance_sessions
       SET session_status = 'open',
           cancelled_at = NULL,
           cancelled_by = NULL,
           updated_at = datetime('now')
       WHERE id = ? AND church_id = ?`,
      [session.id, churchId],
    );
    return mapSession(await loadSessionByIdWithConnection(conn, {
      churchId,
      sessionId: session.id,
    }));
  });
}

module.exports = {
  SESSION_NOT_FOUND,
  INVALID_SESSION_TRANSITION,
  SESSION_HAS_ACTIVITY,
  ensureSessionWithConnection,
  finalizeStandardSessionWithConnection,
  finalizeHeadcountSessionWithConnection,
  setSessionState,
};
