const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { beginAuthoritySwitch, commitAuthoritySwitch } = require('../peopleSync/authority');
const {
  isPcoModeActive,
  isBackgroundCheckTrackingEnabled,
  isIndividualLocked,
} = require('./mode');

test('isPcoModeActive reads the provider-neutral authority instead of the legacy indicator', async () => {
  await withTestChurchDb(async (churchId) => {
    await Database.query(
      `UPDATE church_settings SET planning_center_sync_indicator = 1 WHERE church_id = ?`,
      [churchId]
    );
    await beginAuthoritySwitch(churchId, 'elvanto');
    await commitAuthoritySwitch(churchId, 'elvanto');

    assert.strictEqual(await isPcoModeActive(churchId), false);

    await beginAuthoritySwitch(churchId, 'planning_center');
    await commitAuthoritySwitch(churchId, 'planning_center');
    assert.strictEqual(await isPcoModeActive(churchId), true);
  });
});

test('isIndividualLocked remains compatible with legacy PCO-shaped records', () => {
  assert.strictEqual(isIndividualLocked({ planning_center_id: 'pco-1' }), true);
  assert.strictEqual(isIndividualLocked({ planningCenterId: 'pco-2' }), true);
  assert.strictEqual(isIndividualLocked({ planning_center_id: '' }), false);
  assert.strictEqual(isIndividualLocked(null), false);
});

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
