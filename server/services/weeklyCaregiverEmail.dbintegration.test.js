const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../config/database');
const logger = require('../config/logger');
logger.exceptions?.unhandle();
logger.rejections?.unhandle();
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const {
  generateCaregiverDigests,
  sendWeeklyCaregiverDigests,
} = require('./weeklyCaregiverEmail');

const NOW = new Date('2026-08-19T02:00:00.000Z');

async function seedDeclineFixture(churchId, {
  email = 'caregiver@example.test',
  caregiverType = 'user',
  firstName = 'Jamie',
  familyName = 'EXAMPLE, J',
  workflowState = null,
  recoveredAt = null,
} = {}) {
  const admin = await Database.query(
    `INSERT INTO users (church_id, email, role, first_name, last_name, is_active)
     VALUES (?, ?, 'admin', 'Admin', 'Creator', 1)`,
    [churchId, `admin-${Math.random()}@example.test`],
  );
  const family = await Database.query(
    `INSERT INTO families (church_id, family_name, created_by) VALUES (?, ?, ?)`,
    [churchId, familyName, admin.insertId],
  );
  const person = await Database.query(
    `INSERT INTO individuals
       (church_id, first_name, last_name, family_id, people_type, is_active, created_by)
     VALUES (?, ?, 'Example', ?, 'regular', 1, ?)`,
    [churchId, firstName, family.insertId, admin.insertId],
  );
  let recipient;
  let assignment;
  if (caregiverType === 'user') {
    recipient = await Database.query(
      `INSERT INTO users
         (church_id, email, role, first_name, last_name, is_active, email_notifications)
       VALUES (?, ?, 'coordinator', 'Care', 'Giver', 1, 1)`,
      [churchId, email],
    );
    assignment = await Database.query(
      `INSERT INTO family_caregivers (church_id, family_id, caregiver_type, user_id)
       VALUES (?, ?, 'user', ?)`,
      [churchId, family.insertId, recipient.insertId],
    );
  } else {
    recipient = await Database.query(
      `INSERT INTO contacts
         (church_id, first_name, last_name, email, primary_contact_method, is_active, created_by)
       VALUES (?, 'Care', 'Giver', ?, 'email', 1, ?)`,
      [churchId, email, admin.insertId],
    );
    assignment = await Database.query(
      `INSERT INTO family_caregivers (church_id, family_id, caregiver_type, contact_id)
       VALUES (?, ?, 'contact', ?)`,
      [churchId, family.insertId, recipient.insertId],
    );
  }
  const event = await Database.query(
    `INSERT INTO engagement_decline_events
       (church_id, individual_id, family_at_detection_id, from_tier, to_tier,
        effective_week_end, rules_version, detected_at, recovered_at)
     VALUES (?, ?, ?, 'core', 'casual', '2026-08-09', 1, '2026-08-10 08:00:00', ?)`,
    [churchId, person.insertId, family.insertId, recoveredAt],
  );
  const delivery = await Database.query(
    `INSERT INTO engagement_decline_deliveries
       (church_id, event_id, recipient_type, recipient_id, family_caregiver_id)
     VALUES (?, ?, ?, ?, ?)`,
    [churchId, event.insertId, caregiverType, recipient.insertId, assignment.insertId],
  );
  if (workflowState) {
    await Database.query(
      `INSERT INTO pastoral_insight_states
         (church_id, insight_type, subject_id, episode_key, decline_event_id,
          workflow_state, snoozed_until)
       VALUES (?, 'primary_decline', ?, ?, ?, ?, ?)`,
      [
        churchId,
        person.insertId,
        `primary_decline:event:${event.insertId}`,
        event.insertId,
        workflowState,
        workflowState === 'snoozed' ? '2026-08-30' : null,
      ],
    );
  }
  return {
    adminId: admin.insertId,
    familyId: family.insertId,
    personId: person.insertId,
    recipientId: recipient.insertId,
    assignmentId: assignment.insertId,
    eventId: event.insertId,
    deliveryId: delivery.insertId,
  };
}

test('generateCaregiverDigests counts two missed weekly gatherings as one absence period', async () => {
  await withTestChurchDb(async (churchId) => {
    const caregiver = await Database.query(
      `INSERT INTO users (church_id, email, role, first_name, last_name, is_active)
       VALUES (?, 'caregiver@example.com', 'coordinator', 'Care', 'Giver', 1)`, [churchId]
    );
    const admin = await Database.query(
      `INSERT INTO users (church_id, email, role, first_name, last_name, is_active)
       VALUES (?, 'admin@example.com', 'admin', 'Admin', 'Creator', 1)`, [churchId]
    );
    const family = await Database.query(
      `INSERT INTO families (church_id, family_name) VALUES (?, 'EXAMPLE, J')`, [churchId]
    );
    const person = await Database.query(
      `INSERT INTO individuals (church_id, first_name, last_name, family_id, people_type, is_active)
       VALUES (?, 'Jamie', 'Example', ?, 'regular', 1)`, [churchId, family.insertId]
    );
    await Database.query(
      `INSERT INTO family_caregivers (church_id, family_id, caregiver_type, user_id)
       VALUES (?, ?, 'user', ?)`, [churchId, family.insertId, caregiver.insertId]
    );
    await Database.query(
      `UPDATE church_settings SET caregiver_absence_threshold = 3 WHERE church_id = ?`, [churchId]
    );

    const amGathering = await Database.query(
      `INSERT INTO gathering_types (church_id, name, frequency, attendance_type, is_active, created_by)
       VALUES (?, 'Sunday AM', 'weekly', 'standard', 1, ?)`, [churchId, admin.insertId]
    );
    const pmGathering = await Database.query(
      `INSERT INTO gathering_types (church_id, name, frequency, attendance_type, is_active, created_by)
       VALUES (?, 'Sunday PM', 'weekly', 'standard', 1, ?)`, [churchId, admin.insertId]
    );

    for (const date of ['2026-07-12', '2026-07-19', '2026-07-26']) {
      for (const gatheringId of [amGathering.insertId, pmGathering.insertId]) {
        const session = await Database.query(
          `INSERT INTO attendance_sessions (church_id, gathering_type_id, session_date, created_by)
           VALUES (?, ?, ?, ?)`, [churchId, gatheringId, date, admin.insertId]
        );
        await Database.query(
          `INSERT INTO attendance_records (church_id, session_id, individual_id, present)
           VALUES (?, ?, ?, 0)`, [churchId, session.insertId, person.insertId]
        );
      }
    }

    const digests = await generateCaregiverDigests(churchId);

    assert.equal(digests.length, 1);
    assert.equal(digests[0].entries.length, 1);
    assert.equal(digests[0].entries[0].type, 'individual');
    assert.equal(digests[0].entries[0].streak, 3);
  });
});

test('generateCaregiverDigests excludes caregiver assignments and members from another church', async () => {
  let foreignChurchId;
  await withTestChurchDb(async (churchId) => {
    foreignChurchId = churchId;
  });

  await withTestChurchDb(async (churchId) => {
    const caregiver = await Database.query(
      `INSERT INTO users (church_id, email, role, first_name, last_name, is_active)
       VALUES (?, 'isolation-caregiver@example.com', 'coordinator', 'Care', 'Giver', 1)`, [churchId]
    );
    const admin = await Database.query(
      `INSERT INTO users (church_id, email, role, first_name, last_name, is_active)
       VALUES (?, 'isolation-admin@example.com', 'admin', 'Admin', 'Creator', 1)`, [churchId]
    );
    const localFamily = await Database.query(
      `INSERT INTO families (church_id, family_name) VALUES (?, 'LOCAL, J')`, [churchId]
    );
    const localPerson = await Database.query(
      `INSERT INTO individuals (church_id, first_name, last_name, family_id, people_type, is_active)
       VALUES (?, 'Jamie', 'Local', ?, 'regular', 1)`, [churchId, localFamily.insertId]
    );
    const foreignFamily = await Database.query(
      `INSERT INTO families (church_id, family_name) VALUES (?, 'FOREIGN, J')`, [foreignChurchId]
    );
    const foreignPerson = await Database.query(
      `INSERT INTO individuals (church_id, first_name, last_name, family_id, people_type, is_active)
       VALUES (?, 'Jamie', 'Foreign', ?, 'regular', 1)`, [foreignChurchId, foreignFamily.insertId]
    );

    await Database.query(
      `INSERT INTO family_caregivers (church_id, family_id, caregiver_type, user_id)
       VALUES (?, ?, 'user', ?)`, [foreignChurchId, localFamily.insertId, caregiver.insertId]
    );
    await Database.query(
      `INSERT INTO family_caregivers (church_id, family_id, caregiver_type, user_id)
       VALUES (?, ?, 'user', ?)`, [churchId, foreignFamily.insertId, caregiver.insertId]
    );
    await Database.query(
      `UPDATE church_settings SET caregiver_absence_threshold = 1 WHERE church_id = ?`, [churchId]
    );

    const gathering = await Database.query(
      `INSERT INTO gathering_types (church_id, name, frequency, attendance_type, is_active, created_by)
       VALUES (?, 'Sunday', 'weekly', 'standard', 1, ?)`, [churchId, admin.insertId]
    );
    const session = await Database.query(
      `INSERT INTO attendance_sessions (church_id, gathering_type_id, session_date, created_by)
       VALUES (?, ?, '2026-07-26', ?)`, [churchId, gathering.insertId, admin.insertId]
    );
    for (const individualId of [localPerson.insertId, foreignPerson.insertId]) {
      await Database.query(
        `INSERT INTO attendance_records (church_id, session_id, individual_id, present)
         VALUES (?, ?, ?, 0)`, [churchId, session.insertId, individualId]
      );
    }

    const digests = await generateCaregiverDigests(churchId);

    assert.equal(digests.length, 0);
  });
});

test('generateCaregiverDigests includes a decline-only person card with stable IDs and opportunity evidence', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedDeclineFixture(churchId);

    const digests = await generateCaregiverDigests(churchId, { now: NOW });

    assert.equal(digests.length, 1);
    assert.deepEqual(digests[0].recipientIds, [{ type: 'user', id: fixture.recipientId }]);
    assert.equal(digests[0].entries.length, 1);
    assert.deepEqual({
      personId: digests[0].entries[0].personId,
      familyId: digests[0].entries[0].familyId,
      eventId: digests[0].entries[0].eventId,
    }, {
      personId: fixture.personId,
      familyId: fixture.familyId,
      eventId: fixture.eventId,
    });
    assert.deepEqual(digests[0].entries[0].reasons, [{
      type: 'primary_tier_decline',
      eventId: fixture.eventId,
      fromTier: 'core',
      toTier: 'casual',
      effectiveWeekEnd: '2026-08-09',
      opportunityEvidence: {
        status: 'not_assigned',
        attended: 0,
        opportunities: 0,
        rate: null,
      },
    }]);
  });
});

test('generateCaregiverDigests combines absence and decline reasons for the same stable person', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedDeclineFixture(churchId);
    await Database.query(
      `UPDATE church_settings SET caregiver_absence_threshold = 1 WHERE church_id = ?`,
      [churchId],
    );
    const gathering = await Database.query(
      `INSERT INTO gathering_types
         (church_id, name, frequency, attendance_type, is_active, created_by)
       VALUES (?, 'Sunday', 'weekly', 'standard', 1, ?)`,
      [churchId, fixture.adminId],
    );
    const session = await Database.query(
      `INSERT INTO attendance_sessions
         (church_id, gathering_type_id, session_date, created_by)
       VALUES (?, ?, '2026-08-09', ?)`,
      [churchId, gathering.insertId, fixture.adminId],
    );
    await Database.query(
      `INSERT INTO attendance_records (church_id, session_id, individual_id, present)
       VALUES (?, ?, ?, 0)`,
      [churchId, session.insertId, fixture.personId],
    );

    const [entry] = (await generateCaregiverDigests(churchId, { now: NOW }))[0].entries;

    assert.equal(entry.personId, fixture.personId);
    assert.deepEqual(entry.reasons.map((reason) => reason.type), [
      'consecutive_absence',
      'primary_tier_decline',
    ]);
    assert.deepEqual(entry.reasons[0], {
      type: 'consecutive_absence',
      streak: 1,
      gatheringName: 'Sunday',
      lastPresentDates: [],
    });
  });
});

test('same-email recipients aggregate without losing either stable recipient identity', async () => {
  await withTestChurchDb(async (churchId) => {
    const shared = `shared-${churchId}@example.test`;
    const user = await seedDeclineFixture(churchId, { email: shared, firstName: 'User Subject' });
    const contact = await seedDeclineFixture(churchId, {
      email: shared,
      caregiverType: 'contact',
      firstName: 'Contact Subject',
    });

    const digests = await generateCaregiverDigests(churchId, { now: NOW });

    assert.equal(digests.length, 1);
    assert.deepEqual(digests[0].recipientIds, [
      { type: 'user', id: user.recipientId },
      { type: 'contact', id: contact.recipientId },
    ]);
    assert.deepEqual(digests[0].entries.map((entry) => entry.personId), [
      contact.personId,
      user.personId,
    ]);
  });
});

test('delivery success and failure are persisted per recipient and only the failure retries', async () => {
  await withTestChurchDb(async (churchId) => {
    const failed = await seedDeclineFixture(churchId, { email: 'fail@example.test' });
    const delivered = await seedDeclineFixture(churchId, {
      email: 'success@example.test',
      caregiverType: 'contact',
    });
    const calls = [];
    const firstAttempt = async (email, _firstName, _churchName, _entries, options) => {
      calls.push({ email, messageKey: options.messageKey });
      if (email === 'fail@example.test') throw new Error('provider unavailable');
    };

    assert.equal(await sendWeeklyCaregiverDigests(churchId, {
      now: NOW,
      sendEmail: firstAttempt,
    }), 1);
    assert.deepEqual(calls, [
      {
        email: 'fail@example.test',
        messageKey: `engagement-digest:${churchId}:user:${failed.recipientId}:2026-08-16`,
      },
      {
        email: 'success@example.test',
        messageKey: `engagement-digest:${churchId}:contact:${delivered.recipientId}:2026-08-16`,
      },
    ]);
    const firstStates = await Database.query(
      `SELECT id, state, attempts, last_error AS lastError,
              delivered_at AS deliveredAt
       FROM engagement_decline_deliveries WHERE church_id = ? ORDER BY id`,
      [churchId],
    );
    assert.deepEqual(firstStates.slice(0, 1), [
      {
        id: failed.deliveryId,
        state: 'pending',
        attempts: 1,
        lastError: 'provider unavailable',
        deliveredAt: null,
      },
    ]);
    assert.deepEqual({ ...firstStates[1], deliveredAt: '<timestamp>' }, {
      id: delivered.deliveryId,
      state: 'delivered',
      attempts: 1,
      lastError: null,
      deliveredAt: '<timestamp>',
    });
    assert.match(firstStates[1].deliveredAt, /^\d{4}-\d{2}-\d{2} /);

    const retryEmails = [];
    assert.equal(await sendWeeklyCaregiverDigests(churchId, {
      now: NOW,
      sendEmail: async (email) => retryEmails.push(email),
    }), 1);
    assert.deepEqual(retryEmails, ['fail@example.test']);
    assert.deepEqual(await Database.query(
      `SELECT id, state, attempts FROM engagement_decline_deliveries
       WHERE church_id = ? ORDER BY id`,
      [churchId],
    ), [
      { id: failed.deliveryId, state: 'delivered', attempts: 2 },
      { id: delivered.deliveryId, state: 'delivered', attempts: 1 },
    ]);
  });
});

test('stale family assignment and recipient eligibility cancel pending delivery before send', async () => {
  await withTestChurchDb(async (churchId) => {
    const moved = await seedDeclineFixture(churchId, { email: 'moved@example.test' });
    const removed = await seedDeclineFixture(churchId, { email: 'removed@example.test' });
    const inactive = await seedDeclineFixture(churchId, { email: 'inactive@example.test' });
    const otherFamily = await Database.query(
      `INSERT INTO families (church_id, family_name, created_by) VALUES (?, 'OTHER, O', ?)`,
      [churchId, moved.adminId],
    );
    await Database.query(`UPDATE individuals SET family_id = ? WHERE church_id = ? AND id = ?`,
      [otherFamily.insertId, churchId, moved.personId]);
    await Database.query(`DELETE FROM family_caregivers WHERE church_id = ? AND id = ?`,
      [churchId, removed.assignmentId]);
    await Database.query(`UPDATE users SET is_active = 0 WHERE church_id = ? AND id = ?`,
      [churchId, inactive.recipientId]);
    const sent = [];

    assert.equal(await sendWeeklyCaregiverDigests(churchId, {
      now: NOW,
      sendEmail: async (email) => sent.push(email),
    }), 0);
    assert.deepEqual(sent, []);
    assert.deepEqual(await Database.query(
      `SELECT id, state, cancellation_reason AS reason
       FROM engagement_decline_deliveries WHERE church_id = ? ORDER BY id`,
      [churchId],
    ), [
      { id: moved.deliveryId, state: 'cancelled', reason: 'family_changed' },
      { id: removed.deliveryId, state: 'cancelled', reason: 'assignment_removed' },
      { id: inactive.deliveryId, state: 'cancelled', reason: 'recipient_ineligible' },
    ]);
  });
});

test('recovered snoozed and dismissed declines are excluded and a test send consumes no rows', async () => {
  await withTestChurchDb(async (churchId) => {
    const recovered = await seedDeclineFixture(churchId, {
      email: 'recovered@example.test',
      recoveredAt: '2026-08-18 01:00:00',
    });
    const snoozed = await seedDeclineFixture(churchId, {
      email: 'snoozed@example.test',
      workflowState: 'snoozed',
    });
    const dismissed = await seedDeclineFixture(churchId, {
      email: 'dismissed@example.test',
      workflowState: 'dismissed',
    });
    const open = await seedDeclineFixture(churchId, { email: 'open@example.test' });
    const before = await Database.query(
      `SELECT id, state, attempts FROM engagement_decline_deliveries
       WHERE church_id = ? ORDER BY id`,
      [churchId],
    );
    const sends = [];

    assert.equal(await sendWeeklyCaregiverDigests(churchId, {
      now: NOW,
      testMode: true,
      sendEmail: async (email, _firstName, _church, entries, options) => sends.push({
        email,
        entries,
        testMode: options.testMode,
      }),
    }), 1);
    assert.deepEqual(sends.map((send) => ({ email: send.email, testMode: send.testMode })), [
      { email: 'open@example.test', testMode: true },
    ]);
    assert.equal(sends[0].entries[0].eventId, open.eventId);
    assert.deepEqual(await Database.query(
      `SELECT id, state, attempts FROM engagement_decline_deliveries
       WHERE church_id = ? ORDER BY id`,
      [churchId],
    ), before);
    assert.deepEqual(before.map((row) => row.id), [
      recovered.deliveryId,
      snoozed.deliveryId,
      dismissed.deliveryId,
      open.deliveryId,
    ]);
  });
});
