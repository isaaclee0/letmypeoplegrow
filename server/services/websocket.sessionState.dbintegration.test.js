const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../config/database');
const logger = require('../config/logger');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const webSocketService = require('./websocket');

logger.exceptions?.unhandle();
logger.rejections?.unhandle();

function fakeSocket(userId, churchId) {
  const emitted = [];
  return {
    userId,
    churchId,
    emit: (event, payload) => emitted.push({ event, payload }),
    emitted,
  };
}

async function seedUser(churchId) {
  const result = await Database.query(
    `INSERT INTO users (church_id, email, role, first_name, last_name)
     VALUES (?, 'socket-session@test.com', 'attendance_taker', 'Socket', 'Taker')`,
    [churchId],
  );
  return Number(result.insertId);
}

async function seedGathering(churchId, userId, attendanceType, name) {
  const result = await Database.query(
    `INSERT INTO gathering_types (name, attendance_type, church_id, created_by)
     VALUES (?, ?, ?, ?)`,
    [name, attendanceType, churchId, userId],
  );
  return Number(result.insertId);
}

async function seedIndividual(churchId, firstName) {
  const result = await Database.query(
    `INSERT INTO individuals (first_name, last_name, people_type, church_id, is_active)
     VALUES (?, 'Person', 'regular', ?, 1)`,
    [firstName, churchId],
  );
  return Number(result.insertId);
}

test('WebSocket standard attendance finalises version-1 roster provenance without admitting an ad-hoc attendee', async () => {
  await withTestChurchDb(async (churchId) => {
    webSocketService.recentUpdates.clear();
    const userId = await seedUser(churchId);
    const gatheringId = await seedGathering(churchId, userId, 'standard', 'Standard');
    const rosterId = await seedIndividual(churchId, 'Roster');
    const adHocId = await seedIndividual(churchId, 'AdHoc');
    await Database.query(
      `INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id)
       VALUES (?, ?, ?)`,
      [gatheringId, rosterId, churchId],
    );

    const socket = fakeSocket(userId, churchId);
    await webSocketService.handleRecordAttendance(socket, {
      gatheringId,
      date: '2026-08-17',
      records: [{ individualId: adHocId, present: true, clientTimestamp: Date.now() }],
    });

    const sessions = await Database.query(
      `SELECT id, session_status, roster_snapshotted, roster_provenance_version
       FROM attendance_sessions
       WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?`,
      [gatheringId, '2026-08-17', churchId],
    );
    assert.deepEqual(sessions.map(({ session_status, roster_snapshotted, roster_provenance_version }) => ({
      session_status,
      roster_snapshotted,
      roster_provenance_version,
    })), [{
      session_status: 'held',
      roster_snapshotted: 1,
      roster_provenance_version: 1,
    }]);

    const records = await Database.query(
      `SELECT individual_id, present, eligible_at_snapshot
       FROM attendance_records
       WHERE session_id = ? AND church_id = ?
       ORDER BY individual_id`,
      [sessions[0].id, churchId],
    );
    assert.deepEqual(records, [
      { individual_id: rosterId, present: 0, eligible_at_snapshot: 1 },
      { individual_id: adHocId, present: 1, eligible_at_snapshot: 0 },
    ]);
    assert.equal(socket.emitted.some(({ event }) => event === 'attendance_update_success'), true);
  });
});

test('WebSocket zero headcount finalises the session as held', async () => {
  await withTestChurchDb(async (churchId) => {
    webSocketService.recentUpdates.clear();
    const userId = await seedUser(churchId);
    const gatheringId = await seedGathering(churchId, userId, 'headcount', 'Headcount');
    const socket = fakeSocket(userId, churchId);

    await webSocketService.handleUpdateHeadcount(socket, {
      gatheringId,
      date: '2026-08-17',
      headcount: 0,
      mode: 'separate',
    });

    const sessions = await Database.query(
      `SELECT id, session_status
       FROM attendance_sessions
       WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?`,
      [gatheringId, '2026-08-17', churchId],
    );
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].session_status, 'held');
    assert.deepEqual(await Database.query(
      `SELECT headcount FROM headcount_records
       WHERE session_id = ? AND updated_by = ? AND church_id = ?`,
      [sessions[0].id, userId, churchId],
    ), [{ headcount: 0 }]);
    assert.equal(socket.emitted.some(({ event }) => event === 'headcount_update_success'), true);
  });
});
