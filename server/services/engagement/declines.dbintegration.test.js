'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../../config/logger');

logger.exceptions?.unhandle();
logger.rejections?.unhandle();

const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const declines = require('./declines');

const {
  evaluateEngagementDeclines,
  createEligibleDeliveryRowsWithConnection,
} = declines;

const SUNDAY = '2026-08-16';
const AS_OF = '2026-08-17T12:00:00.000Z';

async function seedChurch(churchId) {
  await Database.query('UPDATE church_settings SET timezone = ? WHERE church_id = ?', [
    'UTC', churchId,
  ]);
  const actor = await Database.query(
    `INSERT INTO users
       (church_id, email, role, first_name, last_name, is_active, email_notifications)
     VALUES (?, ?, 'admin', 'Test', 'Admin', 1, 1)`,
    [churchId, `admin-${churchId}@example.test`],
  );
  const primary = await Database.query(
    `INSERT INTO gathering_types
       (name, attendance_type, is_active, engagement_role, church_id)
     VALUES ('Primary', 'standard', 1, 'primary', ?)`,
    [churchId],
  );
  return { actorId: actor.insertId, primaryId: primary.insertId };
}

async function seedFamily(churchId, name = 'Example') {
  return (await Database.query(
    'INSERT INTO families (family_name, church_id) VALUES (?, ?)',
    [name, churchId],
  )).insertId;
}

async function seedPerson(churchId, fixture, { firstName = 'Person', familyId = null } = {}) {
  const person = await Database.query(
    `INSERT INTO individuals
       (first_name, last_name, family_id, people_type, is_active, church_id)
     VALUES (?, 'Example', ?, 'regular', 1, ?)`,
    [firstName, familyId, churchId],
  );
  await Database.query(
    `INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id)
     VALUES (?, ?, ?)`,
    [fixture.primaryId, person.insertId, churchId],
  );
  return person.insertId;
}

async function assignUser(churchId, familyId, options = {}) {
  const user = await Database.query(
    `INSERT INTO users
       (church_id, email, primary_contact_method, role, first_name, last_name,
        is_active, email_notifications)
     VALUES (?, ?, ?, 'coordinator', ?, 'Caregiver', ?, ?)`,
    [
      churchId,
      Object.hasOwn(options, 'email') ? options.email : `user-${Math.random()}@example.test`,
      options.primaryContactMethod || 'email',
      options.firstName || 'User',
      options.isActive === undefined ? 1 : options.isActive,
      options.emailNotifications === undefined ? 1 : options.emailNotifications,
    ],
  );
  const assignment = await Database.query(
    `INSERT INTO family_caregivers
       (church_id, family_id, caregiver_type, user_id)
     VALUES (?, ?, 'user', ?)`,
    [churchId, familyId, user.insertId],
  );
  return { recipientId: user.insertId, assignmentId: assignment.insertId };
}

async function assignContact(churchId, familyId, creatorId, options = {}) {
  const contact = await Database.query(
    `INSERT INTO contacts
       (church_id, first_name, last_name, email, primary_contact_method, is_active, created_by)
     VALUES (?, ?, 'Caregiver', ?, ?, ?, ?)`,
    [
      churchId,
      options.firstName || 'Contact',
      Object.hasOwn(options, 'email') ? options.email : `contact-${Math.random()}@example.test`,
      options.primaryContactMethod || 'email',
      options.isActive === undefined ? 1 : options.isActive,
      creatorId,
    ],
  );
  const assignment = await Database.query(
    `INSERT INTO family_caregivers
       (church_id, family_id, caregiver_type, contact_id)
     VALUES (?, ?, 'contact', ?)`,
    [churchId, familyId, contact.insertId],
  );
  return { recipientId: contact.insertId, assignmentId: assignment.insertId };
}

async function seedTransition(churchId, individualId, overrides = {}) {
  const row = {
    axis: 'primary',
    fromTier: 'core',
    toTier: 'casual',
    candidateStartedWeekEnd: '2026-05-24',
    confirmedWeekEnd: SUNDAY,
    rulesVersion: 1,
    longTermAttended: 7,
    longTermOpportunities: 13,
    longTermRate: 7 / 13,
    confirmationAttended: 3,
    confirmationOpportunities: 8,
    confirmationRate: 0.375,
    ...overrides,
  };
  return (await Database.query(
    `INSERT INTO engagement_tier_transitions
       (church_id, individual_id, axis, from_tier, to_tier,
        candidate_started_week_end, confirmed_week_end, rules_version,
        long_term_attended, long_term_opportunities, long_term_rate,
        confirmation_attended, confirmation_opportunities, confirmation_rate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      churchId, individualId, row.axis, row.fromTier, row.toTier,
      row.candidateStartedWeekEnd, row.confirmedWeekEnd, row.rulesVersion,
      row.longTermAttended, row.longTermOpportunities, row.longTermRate,
      row.confirmationAttended, row.confirmationOpportunities, row.confirmationRate,
    ],
  )).insertId;
}

async function events(churchId) {
  return Database.query(
    `SELECT id, individual_id AS individualId,
            family_at_detection_id AS familyAtDetectionId,
            from_tier AS fromTier, to_tier AS toTier,
            effective_week_end AS effectiveWeekEnd,
            rules_version AS rulesVersion, recovered_at AS recoveredAt,
            primary_attended_at_detection AS longTermAttended,
            primary_opportunities_at_detection AS longTermOpportunities,
            primary_rate_at_detection AS longTermRate,
            confirmation_attended_at_detection AS confirmationAttended,
            confirmation_opportunities_at_detection AS confirmationOpportunities,
            confirmation_rate_at_detection AS confirmationRate
     FROM engagement_decline_events
     WHERE church_id = ? ORDER BY id`,
    [churchId],
  );
}

async function transitionState(churchId, transitionId) {
  return (await Database.query(
    `SELECT pastoral_processed_at AS pastoralProcessedAt,
            decline_event_id AS declineEventId
     FROM engagement_tier_transitions
     WHERE church_id = ? AND id = ?`,
    [churchId, transitionId],
  ))[0];
}

test('exports the durable Primary transition processor', () => {
  assert.equal(typeof declines.processConfirmedPrimaryTransitions, 'function');
});

test('raw calculated movement and an active lower candidate create no decline event', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedChurch(churchId);
    const individualId = await seedPerson(churchId, fixture);
    await Database.query(
      `INSERT INTO engagement_evaluation_state
         (church_id, individual_id, rules_version, last_evaluated_week_end,
          current_tier, active_lowest_decline_tier, baseline_suppressed)
       VALUES (?, ?, 1, ?, 'casual', 'casual', 0)`,
      [churchId, individualId, SUNDAY],
    );
    await Database.query(
      `INSERT INTO engagement_tier_state
         (church_id, individual_id, axis, rules_version, established_tier,
          candidate_tier, candidate_direction, candidate_started_week_end,
          candidate_final_week_end, last_evaluated_week_end)
       VALUES (?, ?, 'primary', 1, 'core', 'casual', 'lower',
               '2026-08-09', '2026-11-01', ?)`,
      [churchId, individualId, SUNDAY],
    );

    assert.deepEqual(await declines.processConfirmedPrimaryTransitions(churchId), {
      transitionsProcessed: 0,
      eventsCreated: 0,
      eventsRecovered: 0,
      deliveriesCreated: 0,
    });
    assert.equal((await events(churchId)).length, 0);
  });
});

test('processes only durable Primary declines in confirmation order and copies both evidence windows', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedChurch(churchId);
    const familyId = await seedFamily(churchId, 'Confirmed');
    const individualId = await seedPerson(churchId, fixture, { familyId });
    const caregiver = await assignUser(churchId, familyId);
    const laterId = await seedTransition(churchId, individualId, {
      fromTier: 'casual', toTier: 'irregular', candidateStartedWeekEnd: '2026-06-07',
      confirmedWeekEnd: '2026-08-23', longTermAttended: 2,
      longTermOpportunities: 13, longTermRate: 2 / 13,
      confirmationAttended: 1, confirmationOpportunities: 8, confirmationRate: 0.125,
    });
    const communityId = await seedTransition(churchId, individualId, {
      axis: 'community', confirmedWeekEnd: '2026-08-09',
    });
    const earlierId = await seedTransition(churchId, individualId);

    assert.deepEqual(await declines.processConfirmedPrimaryTransitions(churchId, {
      throughWeekEnd: SUNDAY,
    }), {
      transitionsProcessed: 1,
      eventsCreated: 1,
      eventsRecovered: 0,
      deliveriesCreated: 1,
    });
    const firstEvent = (await events(churchId))[0];
    assert.deepEqual({
      fromTier: firstEvent.fromTier,
      toTier: firstEvent.toTier,
      effectiveWeekEnd: firstEvent.effectiveWeekEnd,
      longTermAttended: firstEvent.longTermAttended,
      longTermOpportunities: firstEvent.longTermOpportunities,
      longTermRate: firstEvent.longTermRate,
      confirmationAttended: firstEvent.confirmationAttended,
      confirmationOpportunities: firstEvent.confirmationOpportunities,
      confirmationRate: firstEvent.confirmationRate,
    }, {
      fromTier: 'core', toTier: 'casual', effectiveWeekEnd: SUNDAY,
      longTermAttended: 7, longTermOpportunities: 13, longTermRate: 7 / 13,
      confirmationAttended: 3, confirmationOpportunities: 8, confirmationRate: 0.375,
    });
    const earlierState = await transitionState(churchId, earlierId);
    assert.equal(earlierState.pastoralProcessedAt != null, true);
    assert.equal(earlierState.declineEventId, firstEvent.id);
    assert.deepEqual(await transitionState(churchId, laterId), {
      pastoralProcessedAt: null, declineEventId: null,
    });
    assert.deepEqual(await transitionState(churchId, communityId), {
      pastoralProcessedAt: null, declineEventId: null,
    });
    assert.deepEqual(await Database.query(
      `SELECT recipient_id AS recipientId
       FROM engagement_decline_deliveries
       WHERE church_id = ? AND event_id = ?`,
      [churchId, firstEvent.id],
    ), [{ recipientId: caregiver.recipientId }]);

    assert.equal((await declines.processConfirmedPrimaryTransitions(churchId)).eventsCreated, 1);
    assert.deepEqual((await events(churchId)).map((event) => event.effectiveWeekEnd), [
      SUNDAY, '2026-08-23',
    ]);
  });
});

test('an upward Primary transition recovers only surpassed open tiers and resolves pending work', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedChurch(churchId);
    const familyId = await seedFamily(churchId, 'Recovery');
    const individualId = await seedPerson(churchId, fixture, { familyId });
    await assignUser(churchId, familyId);
    await seedTransition(churchId, individualId, { confirmedWeekEnd: '2026-08-02' });
    await seedTransition(churchId, individualId, {
      fromTier: 'casual', toTier: 'irregular', confirmedWeekEnd: '2026-08-09',
    });
    await declines.processConfirmedPrimaryTransitions(churchId);
    const [casualEvent, irregularEvent] = await events(churchId);
    for (const event of [casualEvent, irregularEvent]) {
      await Database.query(
        `INSERT INTO pastoral_insight_states
           (church_id, insight_type, subject_id, episode_key, decline_event_id, workflow_state)
         VALUES (?, 'primary_decline', ?, ?, ?, 'open')`,
        [churchId, individualId, `primary_decline:event:${event.id}`, event.id],
      );
    }
    const recoveryId = await seedTransition(churchId, individualId, {
      fromTier: 'irregular', toTier: 'casual', confirmedWeekEnd: SUNDAY,
    });

    assert.deepEqual(await declines.processConfirmedPrimaryTransitions(churchId), {
      transitionsProcessed: 1,
      eventsCreated: 0,
      eventsRecovered: 1,
      deliveriesCreated: 0,
    });
    const recovered = await events(churchId);
    assert.equal(recovered[0].recoveredAt, null);
    assert.equal(recovered[1].recoveredAt != null, true);
    assert.deepEqual(await Database.query(
      `SELECT decline_event_id AS eventId, workflow_state AS workflowState
       FROM pastoral_insight_states
       WHERE church_id = ? ORDER BY decline_event_id`,
      [churchId],
    ), [
      { eventId: casualEvent.id, workflowState: 'open' },
      { eventId: irregularEvent.id, workflowState: 'resolved' },
    ]);
    assert.deepEqual(await Database.query(
      `SELECT event_id AS eventId, state, cancellation_reason AS cancellationReason
       FROM engagement_decline_deliveries
       WHERE church_id = ? ORDER BY event_id`,
      [churchId],
    ), [
      { eventId: casualEvent.id, state: 'pending', cancellationReason: null },
      { eventId: irregularEvent.id, state: 'cancelled', cancellationReason: 'event_recovered' },
    ]);
    assert.equal((await transitionState(churchId, recoveryId)).pastoralProcessedAt != null, true);
  });
});

test('a deeper decline after recovery creates a distinct next pastoral episode', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedChurch(churchId);
    const individualId = await seedPerson(churchId, fixture);
    await seedTransition(churchId, individualId, {
      fromTier: 'casual', toTier: 'irregular', confirmedWeekEnd: '2026-08-02',
    });
    await declines.processConfirmedPrimaryTransitions(churchId);
    await seedTransition(churchId, individualId, {
      fromTier: 'irregular', toTier: 'casual', confirmedWeekEnd: '2026-08-09',
    });
    await declines.processConfirmedPrimaryTransitions(churchId);
    await seedTransition(churchId, individualId, {
      fromTier: 'casual', toTier: 'irregular', confirmedWeekEnd: SUNDAY,
    });

    assert.equal((await declines.processConfirmedPrimaryTransitions(churchId)).eventsCreated, 1);
    const persisted = await events(churchId);
    assert.equal(persisted.length, 2);
    assert.equal(persisted[0].recoveredAt != null, true);
    assert.equal(persisted[1].recoveredAt, null);
    assert.notEqual(persisted[0].id, persisted[1].id);
  });
});

test('recipient snapshot begins only when retry successfully creates the decline event', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedChurch(churchId);
    const familyId = await seedFamily(churchId, 'Retry');
    const individualId = await seedPerson(churchId, fixture, { familyId });
    const originalCaregiver = await assignUser(churchId, familyId, { firstName: 'Original' });
    const transitionId = await seedTransition(churchId, individualId);
    const originalExecuteQuery = Database._executeQuery;
    const originalConsoleError = console.error;
    Database._executeQuery = (db, sql, params) => {
      if (sql.includes('UPDATE engagement_tier_transitions')
          && sql.includes('pastoral_processed_at')) {
        throw new Error('injected pastoral persistence failure');
      }
      return originalExecuteQuery.call(Database, db, sql, params);
    };
    console.error = () => {};
    try {
      await assert.rejects(
        declines.processConfirmedPrimaryTransitions(churchId),
        /injected pastoral persistence failure/,
      );
    } finally {
      Database._executeQuery = originalExecuteQuery;
      console.error = originalConsoleError;
    }

    assert.equal((await events(churchId)).length, 0);
    assert.equal((await Database.query(
      `SELECT COUNT(*) AS count
       FROM engagement_decline_deliveries
       WHERE church_id = ?`,
      [churchId],
    ))[0].count, 0);
    assert.deepEqual(await transitionState(churchId, transitionId), {
      pastoralProcessedAt: null, declineEventId: null,
    });
    const retryCaregiver = await assignUser(churchId, familyId, {
      firstName: 'Before successful retry',
    });
    assert.deepEqual(await declines.processConfirmedPrimaryTransitions(churchId), {
      transitionsProcessed: 1,
      eventsCreated: 1,
      eventsRecovered: 0,
      deliveriesCreated: 2,
    });
    const event = (await events(churchId))[0];
    const processed = await transitionState(churchId, transitionId);
    assert.equal(processed.pastoralProcessedAt != null, true);
    assert.equal(processed.declineEventId, event.id);

    await assignUser(churchId, familyId, { firstName: 'After event creation' });
    assert.equal((await declines.processConfirmedPrimaryTransitions(churchId)).transitionsProcessed, 0);
    assert.deepEqual(await Database.transactionForChurch(churchId, (conn) =>
      createEligibleDeliveryRowsWithConnection(
        conn,
        detectionInput(churchId, individualId, familyId),
      )), {
      eventId: null,
      eventCreated: 0,
      deliveriesCreated: 0,
    });
    assert.deepEqual(await Database.query(
      `SELECT recipient_id AS recipientId
       FROM engagement_decline_deliveries
       WHERE church_id = ? AND event_id = ?
       ORDER BY recipient_id`,
      [churchId, event.id],
    ), [
      { recipientId: originalCaregiver.recipientId },
      { recipientId: retryCaregiver.recipientId },
    ]);
  });
});

test('rules-version rollover retires only this church old-rule pastoral and delivery work', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedChurch(churchId);
    const familyId = await seedFamily(churchId, 'Rules rollover');
    const individualId = await seedPerson(churchId, fixture, { familyId });
    const caregiver = await assignUser(churchId, familyId);
    const oldEvent = await Database.query(
      `INSERT INTO engagement_decline_events
         (church_id, individual_id, family_at_detection_id, from_tier, to_tier,
          effective_week_end, rules_version, detected_at)
       VALUES (?, ?, ?, 'core', 'casual', '2026-08-09', 1, '2026-08-10 08:00:00')`,
      [churchId, individualId, familyId],
    );
    await Database.query(
      `INSERT INTO engagement_decline_deliveries
         (church_id, event_id, recipient_type, recipient_id, family_caregiver_id)
       VALUES (?, ?, 'user', ?, ?)`,
      [churchId, oldEvent.insertId, caregiver.recipientId, caregiver.assignmentId],
    );
    await Database.query(
      `INSERT INTO pastoral_insight_states
         (church_id, insight_type, subject_id, episode_key, decline_event_id,
          workflow_state, snoozed_until)
       VALUES (?, 'primary_decline', ?, ?, ?, 'snoozed', '2026-09-30')`,
      [
        churchId,
        individualId,
        `primary_decline:event:${oldEvent.insertId}`,
        oldEvent.insertId,
      ],
    );

    const otherChurchId = `${churchId}-other`;
    const otherEvent = await Database.query(
      `INSERT INTO engagement_decline_events
         (church_id, individual_id, family_at_detection_id, from_tier, to_tier,
          effective_week_end, rules_version, detected_at)
       VALUES (?, ?, ?, 'core', 'casual', '2026-08-09', 1, '2026-08-10 08:00:00')`,
      [otherChurchId, individualId, familyId],
    );
    await Database.query(
      `INSERT INTO engagement_decline_deliveries
         (church_id, event_id, recipient_type, recipient_id, family_caregiver_id)
       VALUES (?, ?, 'user', ?, ?)`,
      [otherChurchId, otherEvent.insertId, caregiver.recipientId, caregiver.assignmentId],
    );
    await Database.query(
      `INSERT INTO pastoral_insight_states
         (church_id, insight_type, subject_id, episode_key, decline_event_id, workflow_state)
       VALUES (?, 'primary_decline', ?, ?, ?, 'open')`,
      [
        otherChurchId,
        individualId,
        `primary_decline:event:${otherEvent.insertId}`,
        otherEvent.insertId,
      ],
    );
    await Database.query(
      `INSERT INTO engagement_settings (church_id, calculation_rules_version)
       VALUES (?, 2)
       ON CONFLICT(church_id) DO UPDATE SET calculation_rules_version = 2`,
      [churchId],
    );

    assert.equal((await Database.query(
      `SELECT COUNT(*) AS count
       FROM engagement_evaluation_state
       WHERE church_id = ?`,
      [churchId],
    ))[0].count, 0);
    await declines.processConfirmedPrimaryTransitions(churchId);
    const afterFirstRun = await Database.query(
      `SELECT event.church_id AS churchId,
              event.recovered_at AS recoveredAt,
              state.workflow_state AS workflowState,
              state.snoozed_until AS snoozedUntil,
              state.resolved_at AS resolvedAt,
              delivery.state AS deliveryState,
              delivery.cancellation_reason AS cancellationReason
       FROM engagement_decline_events event
       JOIN pastoral_insight_states state ON state.decline_event_id = event.id
       JOIN engagement_decline_deliveries delivery ON delivery.event_id = event.id
       WHERE event.id IN (?, ?)
       ORDER BY event.id`,
      [oldEvent.insertId, otherEvent.insertId],
    );
    assert.equal(afterFirstRun[0].churchId, churchId);
    assert.equal(afterFirstRun[0].recoveredAt, null);
    assert.equal(afterFirstRun[0].workflowState, 'resolved');
    assert.equal(afterFirstRun[0].snoozedUntil, null);
    assert.equal(afterFirstRun[0].resolvedAt != null, true);
    assert.equal(afterFirstRun[0].deliveryState, 'cancelled');
    assert.equal(afterFirstRun[0].cancellationReason, 'rules_version_retired');
    assert.deepEqual(afterFirstRun[1], {
      churchId: otherChurchId,
      recoveredAt: null,
      workflowState: 'open',
      snoozedUntil: null,
      resolvedAt: null,
      deliveryState: 'pending',
      cancellationReason: null,
    });

    await declines.processConfirmedPrimaryTransitions(churchId);
    assert.deepEqual(await Database.query(
      `SELECT workflow_state AS workflowState,
              snoozed_until AS snoozedUntil,
              resolved_at AS resolvedAt
       FROM pastoral_insight_states
       WHERE church_id = ? AND decline_event_id = ?`,
      [churchId, oldEvent.insertId],
    ), [{
      workflowState: 'resolved',
      snoozedUntil: null,
      resolvedAt: afterFirstRun[0].resolvedAt,
    }]);
    assert.deepEqual(await Database.query(
      `SELECT state, cancellation_reason AS cancellationReason
       FROM engagement_decline_deliveries
       WHERE church_id = ? AND event_id = ?`,
      [churchId, oldEvent.insertId],
    ), [{ state: 'cancelled', cancellationReason: 'rules_version_retired' }]);
  });
});

test('stale Primary transitions retire durably while current rules process and Other stays pending', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedChurch(churchId);
    const familyId = await seedFamily(churchId, 'Stale transitions');
    const individualId = await seedPerson(churchId, fixture, { familyId });
    await assignUser(churchId, familyId);
    await Database.query(
      `INSERT INTO engagement_settings (church_id, calculation_rules_version)
       VALUES (?, 2)
       ON CONFLICT(church_id) DO UPDATE SET calculation_rules_version = 2`,
      [churchId],
    );
    const staleEligibleId = await seedTransition(churchId, individualId, {
      confirmedWeekEnd: '2026-08-09',
      rulesVersion: 1,
    });
    const staleFutureId = await seedTransition(churchId, individualId, {
      fromTier: 'casual',
      toTier: 'irregular',
      confirmedWeekEnd: '2026-08-23',
      rulesVersion: 1,
    });
    const otherParticipationId = await seedTransition(churchId, individualId, {
      axis: 'community',
      confirmedWeekEnd: '2026-08-09',
      rulesVersion: 1,
    });
    const currentId = await seedTransition(churchId, individualId, {
      confirmedWeekEnd: SUNDAY,
      rulesVersion: 2,
    });

    assert.deepEqual(await declines.processConfirmedPrimaryTransitions(churchId, {
      throughWeekEnd: SUNDAY,
    }), {
      transitionsProcessed: 2,
      eventsCreated: 1,
      eventsRecovered: 0,
      deliveriesCreated: 1,
    });
    const persistedEvents = await events(churchId);
    assert.equal(persistedEvents.length, 1);
    assert.equal(persistedEvents[0].rulesVersion, 2);
    assert.equal(persistedEvents[0].effectiveWeekEnd, SUNDAY);
    const staleEligibleState = await transitionState(churchId, staleEligibleId);
    assert.equal(staleEligibleState.pastoralProcessedAt != null, true);
    assert.equal(staleEligibleState.declineEventId, null);
    const currentState = await transitionState(churchId, currentId);
    assert.equal(currentState.pastoralProcessedAt != null, true);
    assert.equal(currentState.declineEventId, persistedEvents[0].id);
    assert.deepEqual(await transitionState(churchId, staleFutureId), {
      pastoralProcessedAt: null,
      declineEventId: null,
    });
    assert.deepEqual(await transitionState(churchId, otherParticipationId), {
      pastoralProcessedAt: null,
      declineEventId: null,
    });
    assert.equal((await Database.query(
      `SELECT COUNT(*) AS count
       FROM engagement_decline_deliveries
       WHERE church_id = ?`,
      [churchId],
    ))[0].count, 1);

    assert.deepEqual(await declines.processConfirmedPrimaryTransitions(churchId, {
      throughWeekEnd: SUNDAY,
    }), {
      transitionsProcessed: 0,
      eventsCreated: 0,
      eventsRecovered: 0,
      deliveriesCreated: 0,
    });
    assert.deepEqual(await declines.processConfirmedPrimaryTransitions(churchId), {
      transitionsProcessed: 1,
      eventsCreated: 0,
      eventsRecovered: 0,
      deliveriesCreated: 0,
    });
    const staleFutureState = await transitionState(churchId, staleFutureId);
    assert.equal(staleFutureState.pastoralProcessedAt != null, true);
    assert.equal(staleFutureState.declineEventId, null);
    assert.deepEqual(await transitionState(churchId, otherParticipationId), {
      pastoralProcessedAt: null,
      declineEventId: null,
    });
    assert.equal((await events(churchId)).length, 1);
    assert.deepEqual(await declines.processConfirmedPrimaryTransitions(churchId), {
      transitionsProcessed: 0,
      eventsCreated: 0,
      eventsRecovered: 0,
      deliveriesCreated: 0,
    });
  });
});

test('the temporary wrapper confirms tiers before processing durable transitions', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedChurch(churchId);
    const individualId = await seedPerson(churchId, fixture);
    await seedTransition(churchId, individualId);

    const result = await evaluateEngagementDeclines(churchId, { asOf: AS_OF });

    assert.equal(result.completedWeekEnd, SUNDAY);
    assert.equal(result.transitionsProcessed, 1);
    assert.equal(result.eventsCreated, 1);
    assert.equal((await events(churchId)).length, 1);
  });
});

function detectionInput(churchId, individualId, familyId) {
  return {
    churchId,
    individualId,
    familyId,
    fromTier: 'core',
    toTier: 'casual',
    effectiveWeekEnd: SUNDAY,
    rulesVersion: 1,
  };
}

test('keeps the direct caregiver snapshot helper eligible and crash-safe', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedChurch(churchId);
    const familyId = await seedFamily(churchId);
    const individualId = await seedPerson(churchId, fixture, { familyId });
    const sharedEmail = `shared-${churchId}@example.test`;
    const eligibleUser = await assignUser(churchId, familyId, {
      email: sharedEmail, primaryContactMethod: 'sms',
    });
    const eligibleContact = await assignContact(churchId, familyId, fixture.actorId, {
      email: sharedEmail,
    });
    await assignUser(churchId, familyId, { emailNotifications: 0 });
    await assignUser(churchId, familyId, { isActive: 0 });
    await assignContact(churchId, familyId, fixture.actorId, { primaryContactMethod: 'sms' });
    const detection = detectionInput(churchId, individualId, familyId);

    const created = await Database.transactionForChurch(churchId, (conn) =>
      createEligibleDeliveryRowsWithConnection(conn, detection));

    assert.equal(created.eventCreated, 1);
    assert.equal(created.deliveriesCreated, 2);
    assert.deepEqual(await Database.query(
      `SELECT recipient_type AS recipientType, recipient_id AS recipientId
       FROM engagement_decline_deliveries
       WHERE church_id = ? AND event_id = ?
       ORDER BY recipient_type DESC`,
      [churchId, created.eventId],
    ), [
      { recipientType: 'user', recipientId: eligibleUser.recipientId },
      { recipientType: 'contact', recipientId: eligibleContact.recipientId },
    ]);
    assert.deepEqual(await Database.transactionForChurch(churchId, (conn) =>
      createEligibleDeliveryRowsWithConnection(conn, detection)), {
      eventId: null,
      eventCreated: 0,
      deliveriesCreated: 0,
    });
  });
});
