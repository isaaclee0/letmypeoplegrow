const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const attendanceRouter = require('./attendance');

const boundaryInstant = new Date('2026-08-13T14:30:00Z');

test('attendance church-date decisions use the church timezone at a UTC boundary', async () => {
  await withTestChurchDb(async (churchId) => {
    await Database.query(
      "UPDATE church_settings SET timezone = 'Australia/Hobart' WHERE church_id = ?",
      [churchId]
    );

    assert.equal(
      await attendanceRouter.loadChurchTimeZone(churchId),
      'Australia/Hobart'
    );
    assert.equal(
      attendanceRouter.classifyChurchDate('2026-08-14', 'Australia/Hobart', boundaryInstant),
      'today'
    );
    assert.equal(
      attendanceRouter.classifyChurchDate('2026-08-13', 'Australia/Hobart', boundaryInstant),
      'past'
    );
    assert.equal(
      attendanceRouter.getRecentVisitorsAnchor('Australia/Hobart', boundaryInstant),
      '2026-08-14'
    );
  });
});
