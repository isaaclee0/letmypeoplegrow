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

async function seedGathering(churchId, userId, attendanceType, name, { assigned = true } = {}) {
  const result = await Database.query(
    `INSERT INTO gathering_types (name, attendance_type, church_id, created_by)
     VALUES (?, ?, ?, ?)`,
    [name, attendanceType, churchId, userId],
  );
  if (assigned) {
    await Database.query(
      `INSERT INTO user_gathering_assignments
         (user_id, gathering_type_id, assigned_by, church_id)
       VALUES (?, ?, ?, ?)`,
      [userId, result.insertId, userId, churchId],
    );
  }
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

test('WebSocket attendance edits preserve a non-null historical people type', async () => {
  await withTestChurchDb(async (churchId) => {
    webSocketService.recentUpdates.clear();
    const userId = await seedUser(churchId);
    const gatheringId = await seedGathering(churchId, userId, 'standard', 'Historical type');
    const individualId = await seedIndividual(churchId, 'FormerVisitor');
    await Database.query(
      `UPDATE individuals SET people_type = 'local_visitor'
       WHERE id = ? AND church_id = ?`,
      [individualId, churchId],
    );
    const session = await Database.query(
      `INSERT INTO attendance_sessions
         (gathering_type_id, session_date, created_by, session_status,
          roster_provenance_version, church_id)
       VALUES (?, '2025-08-17', ?, 'held', 0, ?)`,
      [gatheringId, userId, churchId],
    );
    await Database.query(
      `INSERT INTO attendance_records
         (session_id, individual_id, present, people_type_at_time, church_id)
       VALUES (?, ?, 0, 'local_visitor', ?)`,
      [session.insertId, individualId, churchId],
    );
    await Database.query(
      `UPDATE individuals SET people_type = 'regular'
       WHERE id = ? AND church_id = ?`,
      [individualId, churchId],
    );

    const socket = fakeSocket(userId, churchId);
    await webSocketService.handleRecordAttendance(socket, {
      gatheringId,
      date: '2025-08-17',
      records: [{
        individualId,
        present: true,
        clientTimestamp: '2099-08-17T00:00:00.000Z',
      }],
    });

    assert.deepEqual(await Database.query(
      `SELECT present, people_type_at_time
       FROM attendance_records
       WHERE session_id = ? AND individual_id = ? AND church_id = ?`,
      [session.insertId, individualId, churchId],
    ), [{ present: 1, people_type_at_time: 'local_visitor' }]);
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

test('WebSocket attendance and headcount mutations require a current gathering assignment', async () => {
  await withTestChurchDb(async (churchId) => {
    webSocketService.recentUpdates.clear();
    const userId = await seedUser(churchId);
    const individualId = await seedIndividual(churchId, 'Denied');
    const standardId = await seedGathering(
      churchId,
      userId,
      'standard',
      'Unassigned standard',
      { assigned: false },
    );
    const headcountId = await seedGathering(
      churchId,
      userId,
      'headcount',
      'Unassigned headcount',
      { assigned: false },
    );
    const socket = fakeSocket(userId, churchId);

    await webSocketService.handleRecordAttendance(socket, {
      gatheringId: standardId,
      date: '2026-08-18',
      records: [{ individualId, present: true, clientTimestamp: Date.now() }],
    });
    await webSocketService.handleUpdateHeadcount(socket, {
      gatheringId: headcountId,
      date: '2026-08-18',
      headcount: 12,
      mode: 'separate',
    });
    await webSocketService.handleUpdateHeadcountMode(socket, {
      gatheringId: headcountId,
      date: '2026-08-18',
      mode: 'combined',
    });

    assert.equal(socket.emitted.some(({ event }) => event === 'attendance_update_error'), true);
    assert.equal(socket.emitted.some(({ event }) => event === 'attendance_update_success'), false);
    assert.equal(socket.emitted.some(({ event }) => event === 'headcount_update_error'), true);
    assert.equal(socket.emitted.some(({ event }) => event === 'headcount_update_success'), false);
    assert.equal(socket.emitted.some(({ event }) => event === 'headcount_mode_update_error'), true);
    assert.equal(socket.emitted.some(({ event }) => event === 'headcount_mode_update_success'), false);
    assert.deepEqual(await Database.query(
      `SELECT id FROM attendance_sessions WHERE church_id = ?`,
      [churchId],
    ), []);

    const admin = await Database.query(
      `INSERT INTO users (church_id, email, role, first_name, last_name)
       VALUES (?, 'socket-admin@test.com', 'admin', 'Socket', 'Admin')`,
      [churchId],
    );
    const adminGatheringId = await seedGathering(
      churchId,
      admin.insertId,
      'standard',
      'Admin unassigned',
      { assigned: false },
    );
    const adminSocket = fakeSocket(admin.insertId, churchId);
    await webSocketService.handleRecordAttendance(adminSocket, {
      gatheringId: adminGatheringId,
      date: '2026-08-19',
      records: [{ individualId, present: true, clientTimestamp: Date.now() }],
    });
    assert.equal(adminSocket.emitted.some(({ event }) => event === 'attendance_update_success'), true);
  });
});

test('WebSocket headcount rejects invalid values and never acknowledges a failed transaction', async () => {
  await withTestChurchDb(async (churchId) => {
    webSocketService.recentUpdates.clear();
    const broadcasts = [];
    const originalBroadcastToChurch = webSocketService.broadcastToChurch;
    webSocketService.broadcastToChurch = (...args) => broadcasts.push(args);
    const userId = await seedUser(churchId);
    const gatheringId = await seedGathering(churchId, userId, 'headcount', 'Validated headcount');
    try {
      const negativeSocket = fakeSocket(userId, churchId);
      await webSocketService.handleUpdateHeadcount(negativeSocket, {
        gatheringId,
        date: '2026-08-19',
        headcount: -1,
        mode: 'separate',
      });
      assert.equal(negativeSocket.emitted.some(({ event }) => event === 'headcount_update_error'), true);
      assert.equal(negativeSocket.emitted.some(({ event }) => event === 'headcount_update_success'), false);

      const invalidModeSocket = fakeSocket(userId, churchId);
      await webSocketService.handleUpdateHeadcount(invalidModeSocket, {
        gatheringId,
        date: '2026-08-20',
        headcount: 1,
        mode: 'invented',
      });
      assert.equal(invalidModeSocket.emitted.some(({ event }) => event === 'headcount_update_error'), true);
      assert.equal(invalidModeSocket.emitted.some(({ event }) => event === 'headcount_update_success'), false);

      const cancelled = await Database.query(
        `INSERT INTO attendance_sessions
           (gathering_type_id, session_date, created_by, session_status, church_id)
         VALUES (?, '2026-08-21', ?, 'cancelled', ?)`,
        [gatheringId, userId, churchId],
      );
      const cancelledSocket = fakeSocket(userId, churchId);
      await webSocketService.handleUpdateHeadcount(cancelledSocket, {
        gatheringId,
        date: '2026-08-21',
        headcount: 4,
        mode: 'separate',
      });
      await webSocketService.handleUpdateHeadcount(cancelledSocket, {
        gatheringId,
        date: '2026-08-21',
        headcount: 4,
        mode: 'separate',
      });
      assert.equal(
        cancelledSocket.emitted.filter(({ event }) => event === 'headcount_update_error').length,
        2,
      );
      assert.equal(cancelledSocket.emitted.some(({ event }) => event === 'headcount_update_success'), false);
      assert.deepEqual(broadcasts, []);
      assert.deepEqual(await Database.query(
        `SELECT id FROM headcount_records WHERE session_id = ? AND church_id = ?`,
        [cancelled.insertId, churchId],
      ), []);

      assert.deepEqual(await Database.query(
        `SELECT session_date FROM attendance_sessions
         WHERE church_id = ? ORDER BY session_date`,
        [churchId],
      ), [{ session_date: '2026-08-21' }]);
    } finally {
      webSocketService.broadcastToChurch = originalBroadcastToChurch;
    }
  });
});
