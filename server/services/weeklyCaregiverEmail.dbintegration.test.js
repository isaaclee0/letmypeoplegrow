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
          `INSERT INTO attendance_sessions
             (church_id, gathering_type_id, session_date, created_by,
              session_status, roster_provenance_version)
           VALUES (?, ?, ?, ?, 'held', 1)`, [churchId, gatheringId, date, admin.insertId]
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

test('delayed decline retries render Primary evidence from the event effective week', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedDeclineFixture(churchId, { email: 'historical@example.test' });
    const gathering = await Database.query(
      `INSERT INTO gathering_types
         (church_id, name, attendance_type, engagement_role, is_active, created_by)
       VALUES (?, 'Primary', 'standard', 'primary', 1, ?)`,
      [churchId, fixture.adminId],
    );
    await Database.query(
      `INSERT INTO gathering_lists
         (church_id, gathering_type_id, individual_id, added_by)
       VALUES (?, ?, ?, ?)`,
      [churchId, gathering.insertId, fixture.personId, fixture.adminId],
    );
    const dates = [
      '2026-06-21', '2026-06-28', '2026-07-05', '2026-07-12', '2026-07-19',
      '2026-07-26', '2026-08-02', '2026-08-09', '2026-08-16',
    ];
    for (const date of dates) {
      const session = await Database.query(
        `INSERT INTO attendance_sessions
           (church_id, gathering_type_id, session_date, created_by,
            session_status, roster_provenance_version, roster_snapshotted)
         VALUES (?, ?, ?, ?, 'held', 1, 1)`,
        [churchId, gathering.insertId, date, fixture.adminId],
      );
      await Database.query(
        `INSERT INTO attendance_records
           (church_id, session_id, individual_id, present,
            eligible_at_snapshot, people_type_at_time)
         VALUES (?, ?, ?, 1, 1, 'regular')`,
        [churchId, session.insertId, fixture.personId],
      );
    }

    const [digest] = await generateCaregiverDigests(churchId, { now: NOW });
    const evidence = digest.entries[0].reasons[0].opportunityEvidence;

    assert.deepEqual(evidence, {
      status: 'core',
      attended: 8,
      opportunities: 8,
      rate: 1,
    });
  });
});

test('delayed retry preserves detection evidence after Primary assignment and role changes', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedDeclineFixture(churchId, { email: 'immutable@example.test' });
    const gathering = await Database.query(
      `INSERT INTO gathering_types
         (church_id, name, attendance_type, engagement_role, is_active, created_by)
       VALUES (?, 'Primary at detection', 'standard', 'primary', 1, ?)`,
      [churchId, fixture.adminId],
    );
    await Database.query(
      `INSERT INTO gathering_lists
         (church_id, gathering_type_id, individual_id, added_by)
       VALUES (?, ?, ?, ?)`,
      [churchId, gathering.insertId, fixture.personId, fixture.adminId],
    );
    const dates = [
      '2026-06-21', '2026-06-28', '2026-07-05', '2026-07-12',
      '2026-07-19', '2026-07-26', '2026-08-02', '2026-08-09',
    ];
    for (const [index, date] of dates.entries()) {
      const session = await Database.query(
        `INSERT INTO attendance_sessions
           (church_id, gathering_type_id, session_date, created_by,
            session_status, roster_provenance_version, roster_snapshotted)
         VALUES (?, ?, ?, ?, 'held', 1, 1)`,
        [churchId, gathering.insertId, date, fixture.adminId],
      );
      await Database.query(
        `INSERT INTO attendance_records
           (church_id, session_id, individual_id, present,
            eligible_at_snapshot, people_type_at_time)
         VALUES (?, ?, ?, ?, 1, 'regular')`,
        [churchId, session.insertId, fixture.personId, index < 3 ? 1 : 0],
      );
    }
    await Database.query(
      `UPDATE engagement_decline_events
       SET primary_attended_at_detection = 3,
           primary_opportunities_at_detection = 8,
           primary_rate_at_detection = 0.375
       WHERE church_id = ? AND id = ?`,
      [churchId, fixture.eventId],
    );
    const attempts = [];

    assert.equal(await sendWeeklyCaregiverDigests(churchId, {
      now: NOW,
      includeAbsences: false,
      sendEmail: async (_email, _firstName, _churchName, entries) => {
        attempts.push(entries[0].reasons[0].opportunityEvidence);
        throw new Error('retry later');
      },
    }), 0);

    await Database.query(
      `DELETE FROM gathering_lists
       WHERE church_id = ? AND gathering_type_id = ? AND individual_id = ?`,
      [churchId, gathering.insertId, fixture.personId],
    );
    await Database.query(
      `UPDATE gathering_types SET engagement_role = 'community'
       WHERE church_id = ? AND id = ?`,
      [churchId, gathering.insertId],
    );

    assert.equal(await sendWeeklyCaregiverDigests(churchId, {
      now: NOW,
      includeAbsences: false,
      sendEmail: async (_email, _firstName, _churchName, entries) => {
        attempts.push(entries[0].reasons[0].opportunityEvidence);
      },
    }), 1);

    assert.deepEqual(attempts, [
      { status: 'casual', attended: 3, opportunities: 8, rate: 0.375 },
      { status: 'casual', attended: 3, opportunities: 8, rate: 0.375 },
    ]);
    assert.deepEqual(await Database.query(
      `SELECT state, attempts FROM engagement_decline_deliveries
       WHERE church_id = ? AND id = ?`,
      [churchId, fixture.deliveryId],
    ), [{ state: 'delivered', attempts: 2 }]);
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
         (church_id, gathering_type_id, session_date, created_by,
          session_status, roster_provenance_version)
       VALUES (?, ?, '2026-08-09', ?, 'held', 1)`,
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

test('caregiver digests use the church main admin as the reply-to address', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedDeclineFixture(churchId, { email: 'caregiver@example.test' });
    const sends = [];

    assert.equal(await sendWeeklyCaregiverDigests(churchId, {
      now: NOW,
      sendEmail: async (_email, _firstName, _churchName, _entries, options) => {
        sends.push(options.replyTo);
      },
    }), 1);

    assert.equal(sends.length, 1);
    assert.match(sends[0], /^admin-.*@example\.test$/);
  });
});

test('revalidates each queued recipient immediately before its provider call', async (t) => {
  const scenarios = [
    {
      name: 'opt-out',
      expectedReason: 'recipient_ineligible',
      mutate: (churchId, fixture) => Database.query(
        `UPDATE users SET email_notifications = 0 WHERE church_id = ? AND id = ?`,
        [churchId, fixture.recipientId],
      ),
    },
    {
      name: 'assignment removal',
      expectedReason: 'assignment_removed',
      mutate: (churchId, fixture) => Database.query(
        `DELETE FROM family_caregivers WHERE church_id = ? AND id = ?`,
        [churchId, fixture.assignmentId],
      ),
    },
    {
      name: 'pastoral dismissal',
      expectedReason: 'pastoral_dismissed',
      mutate: (churchId, fixture) => Database.query(
        `UPDATE pastoral_insight_states
         SET workflow_state = 'dismissed', updated_at = datetime('now')
         WHERE church_id = ? AND decline_event_id = ?`,
        [churchId, fixture.eventId],
      ),
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      await withTestChurchDb(async (churchId) => {
        await seedDeclineFixture(churchId, { email: `first-${scenario.name}@example.test` });
        const later = await seedDeclineFixture(churchId, {
          email: `later-${scenario.name}@example.test`,
        });
        const calls = [];

        assert.equal(await sendWeeklyCaregiverDigests(churchId, {
          now: NOW,
          includeAbsences: false,
          sendEmail: async (email) => {
            calls.push(email);
            if (calls.length === 1) await scenario.mutate(churchId, later);
          },
        }), 1);

        assert.deepEqual(calls, [`first-${scenario.name}@example.test`]);
        assert.deepEqual(await Database.query(
          `SELECT state, cancellation_reason AS reason
           FROM engagement_decline_deliveries WHERE church_id = ? AND id = ?`,
          [churchId, later.deliveryId],
        ), [{ state: 'cancelled', reason: scenario.expectedReason }]);
      });
    });
  }
});

test('revalidates a same-email group again after it splits before either provider call', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedDeclineFixture(churchId, { email: 'trigger@example.test' });
    const sharedEmail = `shared-split-${churchId}@example.test`;
    await seedDeclineFixture(churchId, { email: sharedEmail });
    const contact = await seedDeclineFixture(churchId, {
      email: sharedEmail,
      caregiverType: 'contact',
    });
    const calls = [];

    assert.equal(await sendWeeklyCaregiverDigests(churchId, {
      now: NOW,
      includeAbsences: false,
      sendEmail: async (email) => {
        calls.push(email);
        if (calls.length === 1) {
          await Database.query(
            `UPDATE contacts SET email = 'moved-after-queue@example.test'
             WHERE church_id = ? AND id = ?`,
            [churchId, contact.recipientId],
          );
        } else if (calls.length === 2) {
          await Database.query(
            `UPDATE contacts SET primary_contact_method = 'sms'
             WHERE church_id = ? AND id = ?`,
            [churchId, contact.recipientId],
          );
        }
      },
    }), 2);

    assert.deepEqual(calls, ['trigger@example.test', sharedEmail]);
    assert.deepEqual(await Database.query(
      `SELECT state, attempts, cancellation_reason AS reason
       FROM engagement_decline_deliveries WHERE church_id = ? AND id = ?`,
      [churchId, contact.deliveryId],
    ), [{ state: 'cancelled', attempts: 0, reason: 'recipient_ineligible' }]);
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

test('sender independently cancels pending deliveries created under retired rules', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedDeclineFixture(churchId, { email: 'retired@example.test' });
    await Database.query(
      `INSERT INTO engagement_settings (church_id, calculation_rules_version)
       VALUES (?, 2)
       ON CONFLICT(church_id) DO UPDATE SET calculation_rules_version = 2`,
      [churchId],
    );
    const sent = [];

    assert.equal(await sendWeeklyCaregiverDigests(churchId, {
      now: NOW,
      includeAbsences: false,
      sendEmail: async (email) => sent.push(email),
    }), 0);
    assert.deepEqual(sent, []);
    assert.deepEqual(await Database.query(
      `SELECT state, cancellation_reason AS reason
       FROM engagement_decline_deliveries WHERE church_id = ? AND id = ?`,
      [churchId, fixture.deliveryId],
    ), [{ state: 'cancelled', reason: 'rules_version_retired' }]);
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

async function seedAbsenceOnlyFixture(churchId, threshold) {
  const admin = await Database.query(
    `INSERT INTO users (church_id, email, role, first_name, last_name, is_active)
     VALUES (?, 'absence-admin@example.test', 'admin', 'Admin', 'Example', 1)`,
    [churchId],
  );
  const caregiver = await Database.query(
    `INSERT INTO users
       (church_id, email, role, first_name, last_name, is_active, email_notifications)
     VALUES (?, 'absence-caregiver@example.test', 'coordinator', 'Care', 'Giver', 1, 1)`,
    [churchId],
  );
  const family = await Database.query(
    `INSERT INTO families (church_id, family_name, created_by)
     VALUES (?, 'ABSENCE, A', ?)`,
    [churchId, admin.insertId],
  );
  const person = await Database.query(
    `INSERT INTO individuals
       (church_id, first_name, last_name, family_id, people_type, is_active, created_by)
     VALUES (?, 'Absent', 'Example', ?, 'regular', 1, ?)`,
    [churchId, family.insertId, admin.insertId],
  );
  await Database.query(
    `INSERT INTO family_caregivers (church_id, family_id, caregiver_type, user_id)
     VALUES (?, ?, 'user', ?)`,
    [churchId, family.insertId, caregiver.insertId],
  );
  await Database.query(
    `UPDATE church_settings SET caregiver_absence_threshold = ? WHERE church_id = ?`,
    [threshold, churchId],
  );
  const gathering = await Database.query(
    `INSERT INTO gathering_types
       (church_id, name, frequency, attendance_type, is_active, created_by)
     VALUES (?, 'Sunday', 'weekly', 'standard', 1, ?)`,
    [churchId, admin.insertId],
  );
  return {
    adminId: admin.insertId,
    personId: person.insertId,
    gatheringId: gathering.insertId,
  };
}

async function seedAbsenceSession(churchId, fixture, date, {
  status = 'held',
  provenanceVersion = 1,
  rosterSnapshotted = 0,
  present = 0,
} = {}) {
  const session = await Database.query(
    `INSERT INTO attendance_sessions
       (church_id, gathering_type_id, session_date, created_by, session_status,
        roster_provenance_version, roster_snapshotted)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      churchId,
      fixture.gatheringId,
      date,
      fixture.adminId,
      status,
      provenanceVersion,
      rosterSnapshotted,
    ],
  );
  await Database.query(
    `INSERT INTO attendance_records
       (church_id, session_id, individual_id, present, eligible_at_snapshot)
     VALUES (?, ?, ?, ?, 1)`,
    [churchId, session.insertId, fixture.personId, present],
  );
}

test('absence reasons ignore cancelled open and unreliable sessions', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedAbsenceOnlyFixture(churchId, 2);
    await seedAbsenceSession(churchId, fixture, '2026-07-19');
    await seedAbsenceSession(churchId, fixture, '2026-07-26', { status: 'cancelled' });
    await seedAbsenceSession(churchId, fixture, '2026-08-02', { status: 'open' });
    await seedAbsenceSession(churchId, fixture, '2026-08-09', {
      provenanceVersion: 0,
      rosterSnapshotted: 0,
    });

    const digests = await generateCaregiverDigests(churchId, {
      now: NOW,
      includePendingDeclines: false,
    });

    assert.deepEqual(digests, []);
  });
});

test('last-present evidence excludes ineligible sessions but retains disclosed version-zero snapshots', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedAbsenceOnlyFixture(churchId, 1);
    await seedAbsenceSession(churchId, fixture, '2026-07-05', {
      provenanceVersion: 0,
      rosterSnapshotted: 1,
      present: 1,
    });
    await seedAbsenceSession(churchId, fixture, '2026-07-12', {
      provenanceVersion: 0,
      rosterSnapshotted: 0,
      present: 1,
    });
    await seedAbsenceSession(churchId, fixture, '2026-07-19', {
      status: 'cancelled',
      present: 1,
    });
    await seedAbsenceSession(churchId, fixture, '2026-07-26', {
      status: 'open',
      present: 1,
    });
    await seedAbsenceSession(churchId, fixture, '2026-08-02', { present: 0 });

    const [digest] = await generateCaregiverDigests(churchId, {
      now: NOW,
      includePendingDeclines: false,
    });

    assert.deepEqual(digest.entries[0].reasons[0], {
      type: 'consecutive_absence',
      streak: 1,
      gatheringName: 'Sunday',
      lastPresentDates: ['2026-07-05'],
    });
  });
});

test('pastoral enrichment failure still sends the established absence-only digest', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedAbsenceOnlyFixture(churchId, 1);
    await seedAbsenceSession(churchId, fixture, '2026-08-09');
    await Database.query('DROP TABLE pastoral_insight_states');
    const sends = [];

    assert.equal(await sendWeeklyCaregiverDigests(churchId, {
      now: NOW,
      sendEmail: async (email, _firstName, _churchName, entries) => sends.push({ email, entries }),
    }), 1);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].email, 'absence-caregiver@example.test');
    assert.deepEqual(sends[0].entries[0].reasons.map((reason) => reason.type), [
      'consecutive_absence',
    ]);
  });
});
