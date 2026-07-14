const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { isBackgroundCheckTrackingEnabled } = require('./mode');

test('isBackgroundCheckTrackingEnabled: false by default for a new church', async () => {
  await withTestChurchDb(async (churchId) => {
    assert.strictEqual(await isBackgroundCheckTrackingEnabled(churchId), false);
  });
});

test('isBackgroundCheckTrackingEnabled: true once the church_settings flag is set', async () => {
  await withTestChurchDb(async (churchId) => {
    await Database.query(
      `UPDATE church_settings SET planning_center_track_background_checks = 1 WHERE church_id = ?`,
      [churchId]
    );
    assert.strictEqual(await isBackgroundCheckTrackingEnabled(churchId), true);
  });
});

test('isBackgroundCheckTrackingEnabled: is scoped per church (church isolation)', async () => {
  await withTestChurchDb(async (churchIdA) => {
    await withTestChurchDb(async (churchIdB) => {
      await Database.query(
        `UPDATE church_settings SET planning_center_track_background_checks = 1 WHERE church_id = ?`,
        [churchIdB]
      );
      assert.strictEqual(await isBackgroundCheckTrackingEnabled(churchIdA), false);
      assert.strictEqual(await isBackgroundCheckTrackingEnabled(churchIdB), true);
    });
  });
});
