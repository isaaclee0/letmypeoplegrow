'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const {
  createBatch, getBatch, saveSourceDraft, promoteSourceDraftWithConnection,
} = require('./batchRepository');
const { digestSourceIdentity } = require('./sourceModel');
const {
  recordActiveSourceAvailable, recordActiveSourceFailure,
} = require('./sourceHealth');

const ACTIVE_SOURCE = { kind: 'planning_center_list', externalId: 'list-secret-42', name: 'Sunday Attendance' };
const REPLACEMENT_SOURCE = { kind: 'planning_center_list', externalId: 'list-43', name: 'Evening Attendance' };

async function seedActiveBatch(churchId, source = ACTIVE_SOURCE) {
  const batch = await createBatch({
    churchId, provider: 'planning_center', name: 'Members', initialDraftSource: source,
  });
  await promoteSourceDraftWithConnection(Database.getChurchDb(churchId), {
    churchId, provider: 'planning_center', batchId: batch.id, expectedBaseRevision: 1,
    expectedDraftDigest: digestSourceIdentity(source),
  });
  return getBatch(churchId, 'planning_center', batch.id);
}

async function seedUser(churchId, { role = 'admin', isActive = 1, label = role } = {}) {
  const result = await Database.query(
    `INSERT INTO users (church_id, email, role, first_name, last_name, is_active)
     VALUES (?, ?, ?, 'Source', 'Health', ?)`,
    [churchId, `${label}-${Math.random().toString(36).slice(2)}@example.com`, role, isActive]
  );
  return Number(result.insertId);
}

async function notificationsFor(churchId, userId) {
  return Database.query(
    `SELECT title, message, notification_type FROM notifications
     WHERE church_id = ? AND user_id = ? ORDER BY id`,
    [churchId, userId]
  );
}

test('a successful active-source read refreshes display metadata and clears health errors without changing revision', async () => {
  await withTestChurchDb(async (churchId) => {
    const batch = await seedActiveBatch(churchId);
    await recordActiveSourceFailure({
      churchId, provider: 'planning_center', batchId: batch.id, expectedSource: ACTIVE_SOURCE,
      code: 'SYNC_SOURCE_INCOMPLETE', checkedAt: '2026-07-29T00:00:00.000Z',
    });

    const observed = { ...ACTIVE_SOURCE, name: 'Sunday Gathering' };
    const result = await recordActiveSourceAvailable({
      churchId, provider: 'planning_center', batchId: batch.id, expectedSource: ACTIVE_SOURCE,
      observedSource: observed, checkedAt: '2026-07-29T01:00:00.000Z',
    });
    const updated = await getBatch(churchId, 'planning_center', batch.id);

    assert.equal(result.updated, true);
    assert.deepEqual(updated.source, observed);
    assert.equal(updated.sourceRevision, batch.sourceRevision);
    assert.equal(updated.sourceStatus, 'available');
    assert.equal(updated.sourceStatusCheckedAt, '2026-07-29T01:00:00.000Z');
    assert.equal(updated.sourceStatusErrorCode, null);
  });
});

test('a stable-ID rename changes no active source identity or draft state', async () => {
  await withTestChurchDb(async (churchId) => {
    const batch = await seedActiveBatch(churchId);
    const draft = await saveSourceDraft({
      churchId, provider: 'planning_center', batchId: batch.id, source: REPLACEMENT_SOURCE,
    });
    const renamed = { ...ACTIVE_SOURCE, name: 'Sunday Service' };

    await recordActiveSourceAvailable({
      churchId, provider: 'planning_center', batchId: batch.id, expectedSource: ACTIVE_SOURCE,
      observedSource: renamed, checkedAt: '2026-07-29T01:00:00.000Z',
    });
    const updated = await getBatch(churchId, 'planning_center', batch.id);

    assert.deepEqual(updated.source, renamed);
    assert.equal(updated.sourceRevision, batch.sourceRevision);
    assert.deepEqual(updated.draftSource, REPLACEMENT_SOURCE);
    assert.equal(updated.draftSourceBaseRevision, draft.draftSourceBaseRevision);
  });
});

test('a missing active source notifies exactly active admins once and never exposes its ID', async () => {
  await withTestChurchDb(async (churchId) => {
    const batch = await seedActiveBatch(churchId);
    const activeAdmin = await seedUser(churchId, { label: 'active-admin' });
    const coordinator = await seedUser(churchId, { role: 'coordinator', label: 'coordinator' });
    const inactiveAdmin = await seedUser(churchId, { isActive: 0, label: 'inactive-admin' });

    const first = await recordActiveSourceFailure({
      churchId, provider: 'planning_center', batchId: batch.id, expectedSource: ACTIVE_SOURCE,
      code: 'SYNC_SOURCE_UNAVAILABLE', checkedAt: '2026-07-29T01:00:00.000Z',
    });
    const second = await recordActiveSourceFailure({
      churchId, provider: 'planning_center', batchId: batch.id, expectedSource: ACTIVE_SOURCE,
      code: 'SYNC_SOURCE_UNAVAILABLE', checkedAt: '2026-07-29T02:00:00.000Z',
    });
    const updated = await getBatch(churchId, 'planning_center', batch.id);
    const notices = await notificationsFor(churchId, activeAdmin);

    assert.equal(first.updated, true);
    assert.equal(first.notified, true);
    assert.equal(first.adminCount, 1);
    assert.equal(second.updated, true);
    assert.equal(second.notified, false);
    assert.equal(updated.sourceStatus, 'missing');
    assert.equal(updated.sourceStatusCheckedAt, '2026-07-29T02:00:00.000Z');
    assert.equal(updated.sourceStatusErrorCode, 'SYNC_SOURCE_UNAVAILABLE');
    assert.deepEqual(notices, [{
      title: 'Planning Center sync source missing',
      message: 'The source “Sunday Attendance” for batch “Members” is no longer available. Select a replacement in Settings → Integrations.',
      notification_type: 'system',
    }]);
    assert.equal((await notificationsFor(churchId, coordinator)).length, 0);
    assert.equal((await notificationsFor(churchId, inactiveAdmin)).length, 0);
    assert.equal(notices[0].message.includes(ACTIVE_SOURCE.externalId), false);
  });
});

test('a recovered active source can notify again when it becomes missing again', async () => {
  await withTestChurchDb(async (churchId) => {
    const batch = await seedActiveBatch(churchId);
    const admin = await seedUser(churchId);
    const unavailable = (checkedAt) => recordActiveSourceFailure({
      churchId, provider: 'planning_center', batchId: batch.id, expectedSource: ACTIVE_SOURCE,
      code: 'SYNC_SOURCE_UNAVAILABLE', checkedAt,
    });

    await unavailable('2026-07-29T01:00:00.000Z');
    await recordActiveSourceAvailable({
      churchId, provider: 'planning_center', batchId: batch.id, expectedSource: ACTIVE_SOURCE,
      observedSource: ACTIVE_SOURCE, checkedAt: '2026-07-29T02:00:00.000Z',
    });
    const second = await unavailable('2026-07-29T03:00:00.000Z');

    assert.equal(second.notified, true);
    assert.equal((await notificationsFor(churchId, admin)).length, 2);
  });
});

test('transient, incomplete, and authentication failures are safe errors that never notify admins', async () => {
  await withTestChurchDb(async (churchId) => {
    const batch = await seedActiveBatch(churchId);
    const admin = await seedUser(churchId);
    const checks = [
      ['SYNC_SOURCE_RATE_LIMIT', 'SYNC_SOURCE_RATE_LIMIT'],
      ['SYNC_SOURCE_INCOMPLETE', 'SYNC_SOURCE_INCOMPLETE'],
      ['SYNC_SOURCE_AUTH', 'SYNC_SOURCE_AUTH'],
      ['provider password rejected: top-secret', 'SYNC_SOURCE_CHECK_FAILED'],
    ];

    for (const [index, [code, expectedCode]] of checks.entries()) {
      const result = await recordActiveSourceFailure({
        churchId, provider: 'planning_center', batchId: batch.id, expectedSource: ACTIVE_SOURCE,
        code, checkedAt: `2026-07-29T0${index}:00:00.000Z`,
      });
      assert.equal(result.notified, false);
      assert.equal((await getBatch(churchId, 'planning_center', batch.id)).sourceStatusErrorCode, expectedCode);
    }

    const updated = await getBatch(churchId, 'planning_center', batch.id);
    assert.equal(updated.sourceStatus, 'error');
    assert.equal((await notificationsFor(churchId, admin)).length, 0);
  });
});

test('a Planning Center authentication failure clears after a later successful source read without notifying admins', async () => {
  await withTestChurchDb(async (churchId) => {
    const batch = await seedActiveBatch(churchId);
    const admin = await seedUser(churchId);

    await recordActiveSourceFailure({
      churchId, provider: 'planning_center', batchId: batch.id, expectedSource: ACTIVE_SOURCE,
      code: 'SYNC_SOURCE_AUTH', checkedAt: '2026-07-29T01:00:00.000Z',
    });
    let updated = await getBatch(churchId, 'planning_center', batch.id);

    assert.equal(updated.sourceStatus, 'error');
    assert.equal(updated.sourceStatusErrorCode, 'SYNC_SOURCE_AUTH');
    assert.equal((await notificationsFor(churchId, admin)).length, 0);

    await recordActiveSourceAvailable({
      churchId, provider: 'planning_center', batchId: batch.id, expectedSource: ACTIVE_SOURCE,
      observedSource: ACTIVE_SOURCE, checkedAt: '2026-07-29T02:00:00.000Z',
    });
    updated = await getBatch(churchId, 'planning_center', batch.id);

    assert.equal(updated.sourceStatus, 'available');
    assert.equal(updated.sourceStatusErrorCode, null);
  });
});

test('a late health result cannot update an active source that was replaced after the fetch began', async () => {
  await withTestChurchDb(async (churchId) => {
    const batch = await seedActiveBatch(churchId);
    const draft = await saveSourceDraft({
      churchId, provider: 'planning_center', batchId: batch.id, source: REPLACEMENT_SOURCE,
    });
    await promoteSourceDraftWithConnection(Database.getChurchDb(churchId), {
      churchId, provider: 'planning_center', batchId: batch.id,
      expectedBaseRevision: draft.draftSourceBaseRevision,
      expectedDraftDigest: digestSourceIdentity(REPLACEMENT_SOURCE),
    });

    const result = await recordActiveSourceAvailable({
      churchId, provider: 'planning_center', batchId: batch.id, expectedSource: ACTIVE_SOURCE,
      observedSource: { ...ACTIVE_SOURCE, name: 'Late old name' }, checkedAt: '2026-07-29T01:00:00.000Z',
    });
    const current = await getBatch(churchId, 'planning_center', batch.id);

    assert.equal(result.updated, false);
    assert.deepEqual(current.source, REPLACEMENT_SOURCE);
    assert.equal(current.sourceStatus, 'unknown');
  });
});

test('saving or failing to preview a draft leaves active source health unchanged', async () => {
  await withTestChurchDb(async (churchId) => {
    const batch = await seedActiveBatch(churchId);
    await recordActiveSourceAvailable({
      churchId, provider: 'planning_center', batchId: batch.id, expectedSource: ACTIVE_SOURCE,
      observedSource: ACTIVE_SOURCE, checkedAt: '2026-07-29T01:00:00.000Z',
    });

    await saveSourceDraft({
      churchId, provider: 'planning_center', batchId: batch.id, source: REPLACEMENT_SOURCE,
    });
    const current = await getBatch(churchId, 'planning_center', batch.id);

    assert.deepEqual(current.source, ACTIVE_SOURCE);
    assert.equal(current.sourceStatus, 'available');
    assert.equal(current.sourceStatusErrorCode, null);
    assert.deepEqual(current.draftSource, REPLACEMENT_SOURCE);
  });
});
