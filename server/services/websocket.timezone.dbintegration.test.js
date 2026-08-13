const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const webSocketService = require('./websocket');

const boundaryInstant = new Date('2026-08-13T14:30:00Z');

test('WebSocket roster snapshots use the church timezone at a UTC boundary', async () => {
  await withTestChurchDb(async (churchId) => {
    await Database.query(
      "UPDATE church_settings SET timezone = 'Australia/Hobart' WHERE church_id = ?",
      [churchId]
    );

    assert.equal(
      await webSocketService.loadChurchTimeZone(churchId),
      'Australia/Hobart'
    );
    assert.equal(
      webSocketService.canSnapshotRoster('2026-08-14', 'Australia/Hobart', boundaryInstant),
      true
    );
    assert.equal(
      webSocketService.canSnapshotRoster('2026-08-15', 'Australia/Hobart', boundaryInstant),
      false
    );
  });
});
