const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { startRun, finishRun, findLatestReviewNotificationFingerprint } = require('./runRepository');
const { notifyReviewRequired, buildReviewMessage } = require('./reviewNotification');

async function seedAdmin(churchId, overrides = {}) {
  const result = await Database.query(
    `INSERT INTO users (church_id, email, role, first_name, last_name, is_active)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [churchId, overrides.email || `admin-${Math.random().toString(36).slice(2)}@example.com`,
      overrides.role || 'admin', overrides.firstName || 'Admin', overrides.lastName || 'User']
  );
  return Number(result.insertId);
}

async function seedRun(churchId, provider = 'elvanto') {
  const run = await startRun({ churchId, provider, batchId: null, trigger: 'scheduled', fetchMode: 'full' });
  await finishRun({
    churchId, provider, runId: run.id, status: 'review_required',
    counts: { ambiguousPeople: 1 },
  });
  return run.id;
}

async function notificationsFor(churchId, userId) {
  return Database.query(
    `SELECT title, message, notification_type FROM notifications WHERE church_id = ? AND user_id = ? ORDER BY id`,
    [churchId, userId]
  );
}

test('unchanged pending counts notify once per admin; changed counts notify again', async () => {
  await withTestChurchDb(async (churchId) => {
    const admin1 = await seedAdmin(churchId, { role: 'admin' });
    const admin2 = await seedAdmin(churchId, { role: 'coordinator' });

    const run1 = await seedRun(churchId, 'elvanto');
    const first = await notifyReviewRequired({
      churchId, provider: 'elvanto', runId: run1,
      counts: { ambiguousPeople: 2, familyConflicts: 0, unmatchedLocalRegulars: 0, renameFamily: 0 },
    });
    assert.equal(first.notified, true);
    assert.equal(first.adminCount, 2);
    assert.equal((await notificationsFor(churchId, admin1)).length, 1);
    assert.equal((await notificationsFor(churchId, admin2)).length, 1);

    // Same counts, a different (later) run -> no new notification for either admin.
    const run2 = await seedRun(churchId, 'elvanto');
    const second = await notifyReviewRequired({
      churchId, provider: 'elvanto', runId: run2,
      counts: { ambiguousPeople: 2, familyConflicts: 0, unmatchedLocalRegulars: 0, renameFamily: 0 },
    });
    assert.equal(second.notified, false);
    assert.equal((await notificationsFor(churchId, admin1)).length, 1, 'unchanged counts must not create a second notice');
    assert.equal((await notificationsFor(churchId, admin2)).length, 1);

    // Changed counts -> exactly one new notice per admin.
    const run3 = await seedRun(churchId, 'elvanto');
    const third = await notifyReviewRequired({
      churchId, provider: 'elvanto', runId: run3,
      counts: { ambiguousPeople: 3, familyConflicts: 0, unmatchedLocalRegulars: 0, renameFamily: 0 },
    });
    assert.equal(third.notified, true);
    assert.equal((await notificationsFor(churchId, admin1)).length, 2, 'changed counts must create exactly one new notice');
    assert.equal((await notificationsFor(churchId, admin2)).length, 2);

    // The notified admin's message names the provider, links to Settings,
    // and never leaks a person name or raw payload.
    const [{ message, title }] = await notificationsFor(churchId, admin1).then((rows) => rows.slice(-1));
    assert.match(title, /Elvanto/);
    assert.match(message, /Elvanto/);
    assert.match(message, /Settings.*Integrations/);
    assert.equal(/[{[]/.test(message), false, 'message must never look like a serialized payload');
  });
});

test('all-zero counts never notify and never touch the fingerprint', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedAdmin(churchId);
    const run = await seedRun(churchId, 'elvanto');
    const result = await notifyReviewRequired({
      churchId, provider: 'elvanto', runId: run,
      counts: { ambiguousPeople: 0, familyConflicts: 0, unmatchedLocalRegulars: 0, renameFamily: 0 },
    });
    assert.equal(result.notified, false);
    assert.equal(result.adminCount, 0);
    assert.equal(await findLatestReviewNotificationFingerprint(churchId, 'elvanto'), null);
  });
});

test('an all-zero call after a real notification never clears the existing fingerprint', async () => {
  // This is the exact property this whole notification system exists to
  // protect (see this file's history / the Task 10 scheduler bug this
  // generalizes away from): a subsequent all-zero-count call (e.g. a run
  // that legitimately found nothing pending) must never reset a still-
  // valid, still-unresolved fingerprint back to null — doing so would make
  // the SAME still-unresolved items look "new" again the next time a real
  // review-required run recurs, re-notifying admins who already saw them.
  await withTestChurchDb(async (churchId) => {
    await seedAdmin(churchId);
    const firstRun = await seedRun(churchId, 'elvanto');
    await notifyReviewRequired({ churchId, provider: 'elvanto', runId: firstRun, counts: { ambiguousPeople: 2 } });
    const fingerprintAfterRealNotify = await findLatestReviewNotificationFingerprint(churchId, 'elvanto');
    assert.ok(fingerprintAfterRealNotify, 'a real notification must have set a fingerprint');

    const secondRun = await seedRun(churchId, 'elvanto');
    const result = await notifyReviewRequired({
      churchId, provider: 'elvanto', runId: secondRun,
      counts: { ambiguousPeople: 0, familyConflicts: 0, unmatchedLocalRegulars: 0, renameFamily: 0 },
    });
    assert.equal(result.notified, false);
    assert.equal(
      await findLatestReviewNotificationFingerprint(churchId, 'elvanto'),
      fingerprintAfterRealNotify,
      'an all-zero call must never clear an existing, still-unresolved fingerprint'
    );
  });
});

test('dedup fingerprint is scoped per provider, not shared across providers', async () => {
  await withTestChurchDb(async (churchId) => {
    const admin = await seedAdmin(churchId);
    const elvantoRun = await seedRun(churchId, 'elvanto');
    const pcoRun = await seedRun(churchId, 'planning_center');

    await notifyReviewRequired({ churchId, provider: 'elvanto', runId: elvantoRun, counts: { ambiguousPeople: 1 } });
    const pcoResult = await notifyReviewRequired({ churchId, provider: 'planning_center', runId: pcoRun, counts: { ambiguousPeople: 1 } });

    // Same counts, but a DIFFERENT provider -> its own independent fingerprint, so it still notifies.
    assert.equal(pcoResult.notified, true);
    assert.equal((await notificationsFor(churchId, admin)).length, 2);
  });
});

test('inactive users and attendance takers are never notified', async () => {
  await withTestChurchDb(async (churchId) => {
    const admin = await seedAdmin(churchId, { role: 'admin' });
    await Database.query(
      `INSERT INTO users (church_id, email, role, first_name, last_name, is_active) VALUES (?, ?, 'admin', 'Inactive', 'Admin', 0)`,
      [churchId, `inactive-${Math.random().toString(36).slice(2)}@example.com`]
    );
    await Database.query(
      `INSERT INTO users (church_id, email, role, first_name, last_name, is_active) VALUES (?, ?, 'attendance_taker', 'Taker', 'User', 1)`,
      [churchId, `taker-${Math.random().toString(36).slice(2)}@example.com`]
    );
    const run = await seedRun(churchId, 'elvanto');
    const result = await notifyReviewRequired({ churchId, provider: 'elvanto', runId: run, counts: { ambiguousPeople: 1 } });
    assert.equal(result.adminCount, 1);
    assert.equal((await notificationsFor(churchId, admin)).length, 1);
  });
});

test('buildReviewMessage contains no raw payload shape and reflects only nonzero counts', () => {
  const message = buildReviewMessage('planning_center', {
    ambiguousPeople: 1, familyConflicts: 0, unmatchedLocalRegulars: 2, renameFamily: 0,
  });
  assert.match(message, /Planning Center/);
  assert.match(message, /1 person match\b/);
  assert.match(message, /2 unmatched local regulars/);
  assert.equal(/family conflict|family rename/.test(message), false);
});
