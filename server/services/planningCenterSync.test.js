const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const pcoSync = require('./planningCenterSync');

test('isDueToday retains daily, weekly, and monthly scheduling semantics', () => {
  assert.equal(pcoSync.isDueToday('daily', 1, new Date('2026-07-06T02:00:00')), true);
  assert.equal(pcoSync.isDueToday('weekly', 1, new Date('2026-07-06T02:00:00')), true);
  assert.equal(pcoSync.isDueToday('weekly', 1, new Date('2026-07-07T02:00:00')), false);
  assert.equal(pcoSync.isDueToday('monthly', 31, new Date('2026-04-30T02:00:00')), true);
});

test('Planning Center batches persist only a provider-owned source draft', async () => {
  await withTestChurchDb(async (churchId) => {
    const created = await pcoSync.createBatch(churchId, {
      name: 'Youth',
      initialDraftSource: { kind: 'planning_center_list', externalId: 'list-1', name: 'Youth list' },
      defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
      scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1,
    });
    assert.deepEqual(created.draftSource, { kind: 'planning_center_list', externalId: 'list-1', name: 'Youth list' });
    assert.equal(created.needsSourceReview, true);
    const row = (await Database.query(
      'SELECT source_kind, draft_source_kind FROM people_sync_batches WHERE id = ? AND church_id = ?', [created.id, churchId]
    ))[0];
    assert.equal(row.source_kind, null);
    assert.equal(row.draft_source_kind, 'planning_center_list');
  });
});
