const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const webSocketService = require('./websocket');

function fakeSocket(userId, churchId) {
  const emitted = [];
  return {
    userId,
    churchId,
    emit: (event, payload) => emitted.push({ event, payload }),
    emitted,
  };
}

test('WebSocket kiosk check-in records the action and marks attendance present', async () => {
  await withTestChurchDb(async (churchId) => {
    const user = await Database.query(
      `INSERT INTO users (church_id, email, role, first_name, last_name)
       VALUES (?, 'kiosk@test.com', 'attendance_taker', 'Kiosk', 'Taker')`,
      [churchId]
    );
    const gathering = await Database.query(
      `INSERT INTO gathering_types (name, church_id, created_by)
       VALUES ('Sunday Service', ?, ?)`,
      [churchId, user.insertId]
    );
    const individual = await Database.query(
      `INSERT INTO individuals (first_name, last_name, people_type, church_id, is_active)
       VALUES ('Jane', 'Doe', 'regular', ?, 1)`,
      [churchId]
    );
    const socket = fakeSocket(user.insertId, churchId);
    const date = '2026-08-06';

    await webSocketService.handleRecordKioskAction(socket, {
      gatheringId: gathering.insertId,
      date,
      individualIds: [individual.insertId],
      action: 'checkin',
      signerName: 'Jane Doe',
    });

    const checkins = await Database.query(
      `SELECT action FROM kiosk_checkins
       WHERE gathering_type_id = ? AND session_date = ? AND individual_id = ? AND church_id = ?`,
      [gathering.insertId, date, individual.insertId, churchId]
    );
    const attendance = await Database.query(
      `SELECT ar.present, ar.people_type_at_time
       FROM attendance_records ar
       JOIN attendance_sessions session ON session.id = ar.session_id
       WHERE session.gathering_type_id = ? AND session.session_date = ?
         AND ar.individual_id = ? AND ar.church_id = ?`,
      [gathering.insertId, date, individual.insertId, churchId]
    );

    assert.deepEqual(checkins, [{ action: 'checkin' }]);
    assert.equal(attendance.length, 1);
    assert.equal(Boolean(attendance[0].present), true);
    assert.equal(attendance[0].people_type_at_time, 'regular');
    assert.equal(socket.emitted.some(({ event }) => event === 'kiosk_action_success'), true);
    assert.equal(socket.emitted.some(({ event }) => event === 'kiosk_action_error'), false);
  });
});
