const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const Database = require('../config/database');
const logger = require('../config/logger');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const webSocketService = require('./websocket');
const kioskRouter = require('../routes/kiosk');

const TEST_SECRET = 'websocket-kiosk-session-state-test';

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

async function seedKioskScenario(churchId) {
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
  const rosterMember = await Database.query(
    `INSERT INTO individuals (first_name, last_name, people_type, church_id, is_active)
     VALUES ('Roster', 'Member', 'regular', ?, 1)`,
    [churchId]
  );
  const adHocAttendee = await Database.query(
    `INSERT INTO individuals (first_name, last_name, people_type, church_id, is_active)
     VALUES ('AdHoc', 'Attendee', 'regular', ?, 1)`,
    [churchId]
  );
  await Database.query(
    `INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id)
     VALUES (?, ?, ?)`,
    [gathering.insertId, rosterMember.insertId, churchId],
  );
  return {
    userId: Number(user.insertId),
    gatheringId: Number(gathering.insertId),
    rosterId: Number(rosterMember.insertId),
    adHocId: Number(adHocAttendee.insertId),
  };
}

async function assertFinalisedKioskProvenance(churchId, scenario, date) {
  const sessions = await Database.query(
    `SELECT id, session_status, roster_snapshotted, roster_provenance_version
     FROM attendance_sessions
     WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?`,
    [scenario.gatheringId, date, churchId],
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

  const attendance = await Database.query(
    `SELECT individual_id, present, eligible_at_snapshot, people_type_at_time
     FROM attendance_records
     WHERE session_id = ? AND church_id = ?
     ORDER BY individual_id`,
    [sessions[0].id, churchId],
  );
  assert.deepEqual(attendance, [
    {
      individual_id: scenario.rosterId,
      present: 0,
      eligible_at_snapshot: 1,
      people_type_at_time: 'regular',
    },
    {
      individual_id: scenario.adHocId,
      present: 1,
      eligible_at_snapshot: 0,
      people_type_at_time: 'regular',
    },
  ]);
}

test('WebSocket kiosk check-in records the action and finalises version-1 roster provenance', async () => {
  await withTestChurchDb(async (churchId) => {
    const scenario = await seedKioskScenario(churchId);
    const socket = fakeSocket(scenario.userId, churchId);
    const date = '2026-08-06';

    await webSocketService.handleRecordKioskAction(socket, {
      gatheringId: scenario.gatheringId,
      date,
      individualIds: [scenario.adHocId],
      action: 'checkin',
      signerName: 'AdHoc Attendee',
    });

    const checkins = await Database.query(
      `SELECT action FROM kiosk_checkins
       WHERE gathering_type_id = ? AND session_date = ? AND individual_id = ? AND church_id = ?`,
      [scenario.gatheringId, date, scenario.adHocId, churchId]
    );

    assert.deepEqual(checkins, [{ action: 'checkin' }]);
    await assertFinalisedKioskProvenance(churchId, scenario, date);
    assert.equal(socket.emitted.some(({ event }) => event === 'kiosk_action_success'), true);
    assert.equal(socket.emitted.some(({ event }) => event === 'kiosk_action_error'), false);
  });
});

test('HTTP kiosk check-in records the action and finalises version-1 roster provenance', async () => {
  await withTestChurchDb(async (churchId) => {
    const scenario = await seedKioskScenario(churchId);
    Database.getRegistryDb().prepare(
      `INSERT INTO churches (church_id, church_name, is_approved)
       VALUES (?, 'Kiosk Test', 1)`,
    ).run(churchId);

    const previousSecret = process.env.JWT_SECRET;
    const previousKioskFlag = process.env.KIOSK_MODE_ENABLED;
    process.env.JWT_SECRET = TEST_SECRET;
    process.env.KIOSK_MODE_ENABLED = 'true';
    const token = jwt.sign({ userId: scenario.userId, churchId }, TEST_SECRET);
    const app = express();
    app.use(express.json());
    app.use('/api/kiosk', kioskRouter);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const date = '2026-08-07';
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/kiosk/${scenario.gatheringId}/${date}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            individualIds: [scenario.adHocId],
            action: 'checkin',
            signerName: 'AdHoc Attendee',
          }),
        },
      );
      assert.equal(response.status, 200, await response.text());
      assert.deepEqual(await Database.query(
        `SELECT action FROM kiosk_checkins
         WHERE gathering_type_id = ? AND session_date = ? AND individual_id = ? AND church_id = ?`,
        [scenario.gatheringId, date, scenario.adHocId, churchId],
      ), [{ action: 'checkin' }]);
      await assertFinalisedKioskProvenance(churchId, scenario, date);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
      if (previousKioskFlag === undefined) delete process.env.KIOSK_MODE_ENABLED;
      else process.env.KIOSK_MODE_ENABLED = previousKioskFlag;
    }
  });
});
