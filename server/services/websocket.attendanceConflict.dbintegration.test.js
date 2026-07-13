const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const webSocketService = require('./websocket');

// Minimal fake socket: only the fields handleRecordAttendance actually reads.
function fakeSocket(userId, churchId) {
  const emitted = [];
  return {
    userId,
    churchId,
    emit: (event, payload) => emitted.push({ event, payload }),
    emitted
  };
}

async function seedUser(churchId) {
  const res = await Database.query(
    `INSERT INTO users (church_id, email, role, first_name, last_name) VALUES (?, 'taker@test.com', 'attendance_taker', 'Test', 'Taker')`,
    [churchId]
  );
  return res.insertId;
}

async function seedGatheringType(churchId, createdBy) {
  const res = await Database.query(
    `INSERT INTO gathering_types (name, church_id, created_by) VALUES ('Sunday Service', ?, ?)`,
    [churchId, createdBy]
  );
  return res.insertId;
}

async function seedIndividual(churchId) {
  const res = await Database.query(
    `INSERT INTO individuals (first_name, last_name, church_id, is_active) VALUES ('Jane', 'Doe', ?, 1)`,
    [churchId]
  );
  return res.insertId;
}

function getAttendanceRecord(individualId) {
  return Database.query(
    `SELECT ar.present, ar.updated_at FROM attendance_records ar
     JOIN attendance_sessions s ON s.id = ar.session_id
     WHERE ar.individual_id = ?`,
    [individualId]
  ).then((rows) => rows[0]);
}

test('handleRecordAttendance: first write applies with no conflict reported', async () => {
  await withTestChurchDb(async (churchId) => {
    webSocketService.recentUpdates.clear();
    const userId = await seedUser(churchId);
    const gatheringTypeId = await seedGatheringType(churchId, userId);
    const individualId = await seedIndividual(churchId);
    const socket = fakeSocket(userId, churchId);
    const date = new Date().toISOString().split('T')[0];

    await webSocketService.handleRecordAttendance(socket, {
      gatheringId: gatheringTypeId,
      date,
      records: [{ individualId, present: true, clientTimestamp: Date.now() }]
    });

    const row = await getAttendanceRecord(individualId);
    assert.strictEqual(!!row.present, true);

    const ack = socket.emitted.find(e => e.event === 'attendance_update_success');
    assert.ok(ack, 'expected an attendance_update_success ack');
    assert.ok(!ack.payload || !ack.payload.hasConflicts, 'first write should not report a conflict');
  });
});

test('handleRecordAttendance: a write with an older clientTimestamp than the existing row is skipped (matches REST behavior)', async () => {
  await withTestChurchDb(async (churchId) => {
    webSocketService.recentUpdates.clear();
    const userId = await seedUser(churchId);
    const gatheringTypeId = await seedGatheringType(churchId, userId);
    const individualId = await seedIndividual(churchId);
    const socket = fakeSocket(userId, churchId);
    const date = new Date().toISOString().split('T')[0];

    // Establish the current server value: present = true, updated "now".
    await webSocketService.handleRecordAttendance(socket, {
      gatheringId: gatheringTypeId,
      date,
      records: [{ individualId, present: true, clientTimestamp: Date.now() }]
    });

    webSocketService.recentUpdates.clear();

    // A stale/delayed message tries to flip it back to false, stamped with an
    // old clientTimestamp (e.g. queued during a slow connection/reconnect).
    await webSocketService.handleRecordAttendance(socket, {
      gatheringId: gatheringTypeId,
      date,
      records: [{ individualId, present: false, clientTimestamp: new Date('2020-01-01T00:00:00Z').getTime() }]
    });

    const row = await getAttendanceRecord(individualId);
    assert.strictEqual(!!row.present, true, 'server value must not be overwritten by a stale WebSocket update');

    const ack = socket.emitted.filter(e => e.event === 'attendance_update_success').pop();
    assert.ok(ack, 'expected an attendance_update_success ack');
    assert.ok(ack.payload && ack.payload.hasConflicts, 'stale update should be reported as a conflict');
    assert.strictEqual(ack.payload.skippedRecords.length, 1);
    assert.strictEqual(ack.payload.skippedRecords[0].individualId, individualId);
    assert.strictEqual(ack.payload.skippedRecords[0].reason, 'stale_data');
  });
});

test('handleRecordAttendance: a write with a newer clientTimestamp than the existing row is applied', async () => {
  await withTestChurchDb(async (churchId) => {
    webSocketService.recentUpdates.clear();
    const userId = await seedUser(churchId);
    const gatheringTypeId = await seedGatheringType(churchId, userId);
    const individualId = await seedIndividual(churchId);
    const socket = fakeSocket(userId, churchId);
    const date = new Date().toISOString().split('T')[0];

    await webSocketService.handleRecordAttendance(socket, {
      gatheringId: gatheringTypeId,
      date,
      records: [{ individualId, present: true, clientTimestamp: Date.now() }]
    });

    webSocketService.recentUpdates.clear();

    await webSocketService.handleRecordAttendance(socket, {
      gatheringId: gatheringTypeId,
      date,
      records: [{ individualId, present: false, clientTimestamp: Date.now() + 60000 }]
    });

    const row = await getAttendanceRecord(individualId);
    assert.strictEqual(!!row.present, false, 'a genuinely newer update should still apply');

    const ack = socket.emitted.filter(e => e.event === 'attendance_update_success').pop();
    assert.ok(ack, 'expected an attendance_update_success ack');
    assert.ok(!ack.payload || !ack.payload.hasConflicts, 'non-stale write should not report a conflict');
  });
});
