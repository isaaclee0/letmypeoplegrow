'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Database = require('../../config/database');
const logger = require('../../config/logger');
logger.exceptions?.unhandle();
logger.rejections?.unhandle();
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const {
  getPastoralInsights,
  applyPastoralInsightAction,
} = require('./pastoral');

const AS_OF = new Date('2026-08-19T02:00:00.000Z');

async function measureDatabaseQueries(operation) {
  const originalExecuteQuery = Database._executeQuery;
  let queryCount = 0;
  Database._executeQuery = (...args) => {
    queryCount += 1;
    return originalExecuteQuery.call(Database, ...args);
  };
  try {
    return { result: await operation(), queryCount };
  } finally {
    Database._executeQuery = originalExecuteQuery;
  }
}

async function seedActor(churchId, role = 'admin') {
  const result = await Database.query(
    `INSERT INTO users
       (church_id, email, role, first_name, last_name, is_active, email_notifications)
     VALUES (?, ?, ?, 'Alex', 'Leader', 1, 1)`,
    [churchId, `${role}-${Math.random().toString(36).slice(2)}@example.com`, role],
  );
  return result.insertId;
}

async function seedFamilyPerson(churchId, actorId, {
  firstName,
  peopleType = 'regular',
  active = 1,
} = {}) {
  const family = await Database.query(
    `INSERT INTO families (family_name, created_by, church_id)
     VALUES (?, ?, ?)`,
    [`${firstName} Household`, actorId, churchId],
  );
  const person = await Database.query(
    `INSERT INTO individuals
       (first_name, last_name, people_type, family_id, is_active, created_by, church_id)
     VALUES (?, 'Example', ?, ?, ?, ?, ?)`,
    [firstName, peopleType, family.insertId, active, actorId, churchId],
  );
  return { familyId: family.insertId, personId: person.insertId };
}

async function seedGathering(churchId, actorId, name, role) {
  const result = await Database.query(
    `INSERT INTO gathering_types
       (name, attendance_type, engagement_role, is_active, created_by, church_id)
     VALUES (?, 'standard', ?, 1, ?, ?)`,
    [name, role, actorId, churchId],
  );
  return result.insertId;
}

async function assign(churchId, actorId, gatheringId, personId) {
  await Database.query(
    `INSERT INTO gathering_lists
       (gathering_type_id, individual_id, added_by, church_id)
     VALUES (?, ?, ?, ?)`,
    [gatheringId, personId, actorId, churchId],
  );
}

async function seedAttendance(churchId, actorId, gatheringId, personId, date, {
  present,
  peopleType = 'regular',
} = {}) {
  await Database.query(
    `INSERT INTO attendance_sessions
       (gathering_type_id, session_date, created_by, roster_snapshotted,
        session_status, roster_provenance_version, church_id)
     VALUES (?, ?, ?, 1, 'held', 1, ?)
     ON CONFLICT(gathering_type_id, session_date, church_id) DO NOTHING`,
    [gatheringId, date, actorId, churchId],
  );
  const [session] = await Database.query(
    `SELECT id FROM attendance_sessions
     WHERE church_id = ? AND gathering_type_id = ? AND session_date = ?`,
    [churchId, gatheringId, date],
  );
  await Database.query(
    `INSERT INTO attendance_records
       (session_id, individual_id, present, eligible_at_snapshot,
        people_type_at_time, church_id)
     VALUES (?, ?, ?, 1, ?, ?)`,
    [session.id, personId, present ? 1 : 0, peopleType, churchId],
  );
}

async function seedCaregiver(churchId, familyId) {
  const caregiver = await Database.query(
    `INSERT INTO users
       (church_id, email, role, first_name, last_name, is_active, email_notifications)
     VALUES (?, ?, 'coordinator', 'Casey', 'Caregiver', 1, 1)`,
    [churchId, `caregiver-${Math.random().toString(36).slice(2)}@example.com`],
  );
  const assignment = await Database.query(
    `INSERT INTO family_caregivers
       (church_id, family_id, caregiver_type, user_id)
     VALUES (?, ?, 'user', ?)`,
    [churchId, familyId, caregiver.insertId],
  );
  return { userId: caregiver.insertId, assignmentId: assignment.insertId };
}

async function seedDecline(churchId, subject, {
  fromTier = 'core',
  toTier = 'irregular',
  effectiveWeekEnd = '2026-08-09',
  detectedAt = '2026-08-10 08:00:00',
  recoveredAt = null,
} = {}) {
  const event = await Database.query(
    `INSERT INTO engagement_decline_events
       (church_id, individual_id, family_at_detection_id, from_tier, to_tier,
        effective_week_end, rules_version, detected_at, recovered_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      churchId,
      subject.personId,
      subject.familyId,
      fromTier,
      toTier,
      effectiveWeekEnd,
      detectedAt,
      recoveredAt,
    ],
  );
  return event.insertId;
}

function byType(response, type) {
  return response.insights.find((insight) => insight.type === type);
}

test('reconciles decline and re-engagement episodes from factual events without rewriting recovery', async () => {
  await withTestChurchDb(async (churchId) => {
    await Database.query(
      `UPDATE church_settings SET timezone = 'Australia/Hobart' WHERE church_id = ?`,
      [churchId],
    );
    const actorId = await seedActor(churchId);
    const subject = await seedFamilyPerson(churchId, actorId, { firstName: 'Drew' });
    const caregiver = await seedCaregiver(churchId, subject.familyId);
    const eventId = await seedDecline(churchId, subject);
    await Database.query(
      `INSERT INTO engagement_decline_deliveries
         (church_id, event_id, recipient_type, recipient_id, family_caregiver_id)
       VALUES (?, ?, 'user', ?, ?)`,
      [churchId, eventId, caregiver.userId, caregiver.assignmentId],
    );

    const first = await getPastoralInsights(churchId, { asOf: AS_OF });
    const decline = byType(first, 'primary_decline');
    assert.equal(decline.episodeKey, `primary_decline:event:${eventId}`);
    assert.deepEqual(decline.evidence, {
      eventId,
      fromTier: 'core',
      toTier: 'irregular',
      effectiveWeekEnd: '2026-08-09',
      detectedAt: '2026-08-10 08:00:00',
      recoveredAt: null,
    });
    assert.equal(decline.person.firstName, 'Drew');
    assert.equal(decline.family.name, 'Drew Household');
    assert.equal(decline.caregivers[0].firstName, 'Casey');
    assert.equal(decline.workflow.state, 'open');

    await Database.query(
      `UPDATE engagement_decline_events SET recovered_at = '2026-08-10 09:00:00'
       WHERE church_id = ? AND id = ?`,
      [churchId, eventId],
    );
    const recovered = await getPastoralInsights(churchId, { asOf: AS_OF });
    assert.equal(byType(recovered, 'primary_decline'), undefined);
    const positive = byType(recovered, 're_engagement');
    assert.equal(positive.episodeKey, `re_engagement:event:${eventId}`);
    assert.equal(positive.evidence.recoveredAt, '2026-08-10 09:00:00');
    assert.deepEqual(positive.deliverySummary, { pending: 0, delivered: 0, cancelled: 0 });
    assert.equal((await Database.query(
      `SELECT recovered_at AS recoveredAt FROM engagement_decline_events
       WHERE church_id = ? AND id = ?`,
      [churchId, eventId],
    ))[0].recoveredAt, '2026-08-10 09:00:00');
    assert.equal((await Database.query(
      `SELECT COUNT(*) AS count FROM engagement_decline_deliveries
       WHERE church_id = ? AND event_id = ?`,
      [churchId, eventId],
    ))[0].count, 1);
    await applyPastoralInsightAction(churchId, actorId, positive.id, { action: 'dismiss' });
    assert.equal((await Database.query(
      `SELECT state FROM engagement_decline_deliveries
       WHERE church_id = ? AND event_id = ?`,
      [churchId, eventId],
    ))[0].state, 'pending');

    const expired = await getPastoralInsights(churchId, {
      asOf: new Date('2026-09-14T02:00:00.000Z'),
    });
    assert.equal(byType(expired, 're_engagement'), undefined);
    assert.equal((await Database.query(
      `SELECT workflow_state AS state FROM pastoral_insight_states
       WHERE church_id = ? AND insight_type = 're_engagement'`,
      [churchId],
    ))[0].state, 'resolved');
  });
});

test('reconciles a large pastoral workspace with bounded database queries', async (t) => {
  await withTestChurchDb(async (churchId) => {
    const db = Database.getChurchDb(churchId);
    db.transaction(() => {
      const insertPerson = db.prepare(
        `INSERT INTO individuals
           (first_name, last_name, people_type, is_active, church_id)
         VALUES (?, 'Bulk', 'regular', 1, ?)`,
      );
      const insertEvent = db.prepare(
        `INSERT INTO engagement_decline_events
           (church_id, individual_id, from_tier, to_tier,
            effective_week_end, rules_version, detected_at)
         VALUES (?, ?, 'core', 'irregular', '2026-08-09', 1, '2026-08-10 08:00:00')`,
      );
      const insertState = db.prepare(
        `INSERT INTO pastoral_insight_states
           (church_id, insight_type, subject_id, episode_key,
            decline_event_id, workflow_state, snoozed_until)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let index = 1; index <= 100; index += 1) {
        const person = insertPerson.run(`Person ${index}`, churchId);
        const event = insertEvent.run(churchId, person.lastInsertRowid);
        if (index <= 50) {
          insertState.run(
            churchId,
            'primary_decline',
            person.lastInsertRowid,
            `primary_decline:event:${event.lastInsertRowid}`,
            event.lastInsertRowid,
            'snoozed',
            '2026-08-18',
          );
        }
        insertState.run(
          churchId,
          'visitor_next_step',
          person.lastInsertRowid,
          `stale:${index}`,
          null,
          'open',
          null,
        );
      }
    })();

    const measured = await measureDatabaseQueries(() => getPastoralInsights(churchId, {
      asOf: AS_OF,
    }));

    assert.equal(measured.result.insights.length, 100);
    assert.equal(measured.result.insights.every((row) => row.workflow.state === 'open'), true);
    assert.ok(
      measured.queryCount <= 22,
      `expected bounded pastoral queries, received ${measured.queryCount}`,
    );
    t.diagnostic(`measured ${measured.queryCount} pastoral queries for 100 active and 100 stale states`);
  });
});

test('community-connected primary-irregular episodes can resolve and recur within one completed week', async () => {
  await withTestChurchDb(async (churchId) => {
    const actorId = await seedActor(churchId);
    const subject = await seedFamilyPerson(churchId, actorId, { firstName: 'Morgan' });
    const primaryId = await seedGathering(churchId, actorId, 'Primary', 'primary');
    const communityId = await seedGathering(churchId, actorId, 'Community', 'community');
    await assign(churchId, actorId, primaryId, subject.personId);
    await assign(churchId, actorId, communityId, subject.personId);
    const dates = [
      '2026-06-28', '2026-07-05', '2026-07-12', '2026-07-19',
      '2026-07-26', '2026-08-02', '2026-08-09', '2026-08-16',
    ];
    for (const date of dates) {
      await seedAttendance(churchId, actorId, primaryId, subject.personId, date, { present: false });
      await seedAttendance(churchId, actorId, communityId, subject.personId, date, { present: true });
    }

    const first = byType(await getPastoralInsights(churchId, { asOf: AS_OF }), 'community_primary_gap');
    assert.equal(first.episodeKey, 'community_primary_gap:2026-08-16');
    assert.equal(first.profiles.primary.status, 'irregular');
    assert.deepEqual(first.profiles.primary, {
      status: 'irregular', attended: 0, opportunities: 8, rate: 0,
    });
    assert.equal(first.profiles.community.status, 'core');
    assert.deepEqual(first.evidence, {
      primaryTier: 'irregular', communityTier: 'core', completedWeekEnd: '2026-08-16',
    });

    await Database.query(
      `DELETE FROM gathering_lists
       WHERE church_id = ? AND gathering_type_id = ? AND individual_id = ?`,
      [churchId, communityId, subject.personId],
    );
    assert.equal(byType(
      await getPastoralInsights(churchId, { asOf: AS_OF }),
      'community_primary_gap',
    ), undefined);

    await assign(churchId, actorId, communityId, subject.personId);
    const recurrence = byType(
      await getPastoralInsights(churchId, { asOf: AS_OF }),
      'community_primary_gap',
    );
    assert.equal(recurrence.episodeKey, 'community_primary_gap:2026-08-16:2');
    assert.notEqual(recurrence.id, first.id);

    await Database.query(
      `UPDATE individuals SET is_active = 0 WHERE church_id = ? AND id = ?`,
      [churchId, subject.personId],
    );
    assert.equal(byType(
      await getPastoralInsights(churchId, { asOf: new Date('2026-09-09T02:00:00.000Z') }),
      'community_primary_gap',
    ), undefined);
  });
});

test('re-engagement uses the church-local recovery date at the four-week boundary', async () => {
  await withTestChurchDb(async (churchId) => {
    await Database.query(
      `UPDATE church_settings SET timezone = 'Pacific/Kiritimati' WHERE church_id = ?`,
      [churchId],
    );
    const actorId = await seedActor(churchId);
    const subject = await seedFamilyPerson(churchId, actorId, { firstName: 'Kira' });
    const eventId = await seedDecline(churchId, subject, {
      effectiveWeekEnd: '2026-08-02',
      detectedAt: '2026-08-03 08:00:00',
      // 2026-08-10 01:30 in Kiritimati: exactly the local-date cutoff for Sep 6.
      recoveredAt: '2026-08-09 11:30:00',
    });

    const response = await getPastoralInsights(churchId, {
      asOf: new Date('2026-09-09T02:00:00.000Z'),
    });
    const insight = byType(response, 're_engagement');
    assert.equal(insight.declineEventId, eventId);
    assert.equal(insight.evidence.recoveredAt, '2026-08-09 11:30:00');
  });
});

test('visitor next-step uses reliable Primary attendance and resolves on return, conversion, deactivation, and expiry', async () => {
  await withTestChurchDb(async (churchId) => {
    const actorId = await seedActor(churchId);
    const primaryId = await seedGathering(churchId, actorId, 'Sunday', 'primary');
    const returning = await seedFamilyPerson(churchId, actorId, {
      firstName: 'Vera', peopleType: 'local_visitor',
    });
    const converted = await seedFamilyPerson(churchId, actorId, {
      firstName: 'Connie', peopleType: 'local_visitor',
    });
    const inactive = await seedFamilyPerson(churchId, actorId, {
      firstName: 'Indy', peopleType: 'local_visitor',
    });
    const expiring = await seedFamilyPerson(churchId, actorId, {
      firstName: 'Ellis', peopleType: 'local_visitor',
    });
    for (const subject of [returning, converted, inactive, expiring]) {
      await seedAttendance(churchId, actorId, primaryId, subject.personId, '2026-08-02', {
        present: true, peopleType: 'local_visitor',
      });
    }

    const initial = await getPastoralInsights(churchId, { asOf: AS_OF });
    assert.deepEqual(
      initial.insights.filter((row) => row.type === 'visitor_next_step')
        .map((row) => row.episodeKey),
      [
        'visitor_next_step:first_primary:2026-08-02',
        'visitor_next_step:first_primary:2026-08-02',
        'visitor_next_step:first_primary:2026-08-02',
        'visitor_next_step:first_primary:2026-08-02',
      ],
    );
    assert.deepEqual(
      byType(initial, 'visitor_next_step').evidence,
      { firstPrimaryAttendanceDate: '2026-08-02', laterPrimaryAttendances: 0 },
    );

    await seedAttendance(churchId, actorId, primaryId, returning.personId, '2026-08-16', {
      present: true, peopleType: 'local_visitor',
    });
    await Database.query(
      `UPDATE individuals SET people_type = 'regular' WHERE church_id = ? AND id = ?`,
      [churchId, converted.personId],
    );
    await Database.query(
      `UPDATE individuals SET is_active = 0 WHERE church_id = ? AND id = ?`,
      [churchId, inactive.personId],
    );
    const resolved = await getPastoralInsights(churchId, { asOf: AS_OF });
    assert.deepEqual(
      resolved.insights.filter((row) => row.type === 'visitor_next_step')
        .map((row) => row.person.id),
      [expiring.personId],
    );

    const expired = await getPastoralInsights(churchId, {
      asOf: new Date('2026-09-28T02:00:00.000Z'),
    });
    assert.equal(expired.insights.some((row) => row.person.id === expiring.personId), false);
    assert.equal((await Database.query(
      `SELECT workflow_state AS state
       FROM pastoral_insight_states
       WHERE church_id = ? AND insight_type = 'visitor_next_step' AND subject_id = ?`,
      [churchId, expiring.personId],
    ))[0].state, 'resolved');

    const late = await seedFamilyPerson(churchId, actorId, {
      firstName: 'Late', peopleType: 'local_visitor',
    });
    await seedAttendance(churchId, actorId, primaryId, late.personId, '2026-06-14', {
      present: true, peopleType: 'local_visitor',
    });
    const afterExpiry = await getPastoralInsights(churchId, { asOf: AS_OF });
    assert.equal(afterExpiry.insights.some((row) => row.person.id === late.personId), false);
  });
});

test('snooze, dismiss, and reopen affect only pending delivery and workspace workflow', async () => {
  await withTestChurchDb(async (churchId) => {
    const actorId = await seedActor(churchId);
    const subject = await seedFamilyPerson(churchId, actorId, { firstName: 'Sam' });
    const caregiver = await seedCaregiver(churchId, subject.familyId);
    const workflowNow = new Date('2025-08-19T02:00:00.000Z');
    const eventId = await seedDecline(churchId, subject, {
      effectiveWeekEnd: '2025-08-10',
      detectedAt: '2025-08-11 08:00:00',
    });
    await Database.query(
      `INSERT INTO engagement_decline_deliveries
         (church_id, event_id, recipient_type, recipient_id, family_caregiver_id, state)
       VALUES (?, ?, 'user', ?, ?, 'pending')`,
      [churchId, eventId, caregiver.userId, caregiver.assignmentId],
    );
    const initial = byType(await getPastoralInsights(churchId, { asOf: AS_OF }), 'primary_decline');

    await applyPastoralInsightAction(churchId, actorId, initial.id, {
      action: 'snooze', snoozeUntil: '2025-08-25',
    }, { now: workflowNow });
    assert.equal(byType(await getPastoralInsights(churchId, { asOf: workflowNow }), 'primary_decline'), undefined);
    const snoozed = byType(await getPastoralInsights(churchId, {
      asOf: workflowNow, includeSnoozed: true,
    }), 'primary_decline');
    assert.equal(snoozed.workflow.state, 'snoozed');
    assert.equal((await Database.query(
      `SELECT state FROM engagement_decline_deliveries WHERE church_id = ? AND event_id = ?`,
      [churchId, eventId],
    ))[0].state, 'pending');
    const awakened = byType(await getPastoralInsights(churchId, {
      asOf: new Date('2025-08-25T02:00:00.000Z'),
    }), 'primary_decline');
    assert.equal(awakened.workflow.state, 'open');

    await Database.query(
      `UPDATE engagement_decline_deliveries
       SET state = 'delivered', delivered_at = '2026-08-25 10:00:00'
       WHERE church_id = ? AND event_id = ?`,
      [churchId, eventId],
    );
    await applyPastoralInsightAction(churchId, actorId, initial.id, { action: 'dismiss' });
    assert.equal((await Database.query(
      `SELECT state FROM engagement_decline_deliveries WHERE church_id = ? AND event_id = ?`,
      [churchId, eventId],
    ))[0].state, 'delivered');
    await applyPastoralInsightAction(churchId, actorId, initial.id, { action: 'reopen' });
    assert.equal(byType(await getPastoralInsights(churchId, { asOf: AS_OF }), 'primary_decline').workflow.state, 'open');

    const secondSubject = await seedFamilyPerson(churchId, actorId, { firstName: 'Taylor' });
    const secondCaregiver = await seedCaregiver(churchId, secondSubject.familyId);
    const secondEvent = await seedDecline(churchId, secondSubject, { effectiveWeekEnd: '2026-08-16' });
    await Database.query(
      `INSERT INTO engagement_decline_deliveries
         (church_id, event_id, recipient_type, recipient_id, family_caregiver_id, state)
       VALUES (?, ?, 'user', ?, ?, 'pending')`,
      [churchId, secondEvent, secondCaregiver.userId, secondCaregiver.assignmentId],
    );
    const second = (await getPastoralInsights(churchId, { asOf: AS_OF })).insights
      .find((row) => row.declineEventId === secondEvent);
    await applyPastoralInsightAction(churchId, actorId, second.id, { action: 'dismiss' });
    assert.equal((await Database.query(
      `SELECT state FROM engagement_decline_deliveries WHERE church_id = ? AND event_id = ?`,
      [churchId, secondEvent],
    ))[0].state, 'cancelled');
    await applyPastoralInsightAction(churchId, actorId, second.id, { action: 'reopen' });
    assert.equal((await Database.query(
      `SELECT state FROM engagement_decline_deliveries WHERE church_id = ? AND event_id = ?`,
      [churchId, secondEvent],
    ))[0].state, 'cancelled');

    await Database.query(
      `UPDATE engagement_decline_events SET recovered_at = '2026-08-17 09:00:00'
       WHERE church_id = ? AND id = ?`,
      [churchId, secondEvent],
    );
    const thirdEvent = await seedDecline(churchId, secondSubject, {
      fromTier: 'casual', toTier: 'irregular', effectiveWeekEnd: '2026-08-23',
    });
    const later = await getPastoralInsights(churchId, {
      asOf: new Date('2026-08-26T02:00:00.000Z'),
    });
    assert.ok(later.insights.some((row) => row.declineEventId === thirdEvent));
  });
});

test('a stale action reconciles factual recovery before mutating workflow or delivery', async () => {
  await withTestChurchDb(async (churchId) => {
    const actorId = await seedActor(churchId);
    const subject = await seedFamilyPerson(churchId, actorId, { firstName: 'Stale' });
    const caregiver = await seedCaregiver(churchId, subject.familyId);
    const eventId = await seedDecline(churchId, subject);
    await Database.query(
      `INSERT INTO engagement_decline_deliveries
         (church_id, event_id, recipient_type, recipient_id, family_caregiver_id, state)
       VALUES (?, ?, 'user', ?, ?, 'pending')`,
      [churchId, eventId, caregiver.userId, caregiver.assignmentId],
    );
    const insight = byType(
      await getPastoralInsights(churchId, { asOf: AS_OF }),
      'primary_decline',
    );
    await Database.query(
      `UPDATE engagement_decline_events SET recovered_at = '2026-08-18 01:00:00'
       WHERE church_id = ? AND id = ?`,
      [churchId, eventId],
    );

    await assert.rejects(
      applyPastoralInsightAction(
        churchId,
        actorId,
        insight.id,
        { action: 'dismiss' },
        { now: AS_OF },
      ),
      (error) => error.code === 'PASTORAL_INSIGHT_NOT_FOUND',
    );
    assert.deepEqual((await Database.query(
      `SELECT workflow_state AS workflowState
       FROM pastoral_insight_states WHERE church_id = ? AND id = ?`,
      [churchId, insight.id],
    ))[0], { workflowState: 'resolved' });
    assert.deepEqual((await Database.query(
      `SELECT state, cancellation_reason AS cancellationReason
       FROM engagement_decline_deliveries WHERE church_id = ? AND event_id = ?`,
      [churchId, eventId],
    ))[0], { state: 'pending', cancellationReason: null });
  });
});

test('church scope prevents acting on another church insight ID', async () => {
  await withTestChurchDb(async (churchId) => {
    const actorId = await seedActor(churchId);
    const subject = await seedFamilyPerson(churchId, actorId, { firstName: 'Scoped' });
    const eventId = await seedDecline(churchId, subject);
    const insight = byType(await getPastoralInsights(churchId, { asOf: AS_OF }), 'primary_decline');
    await Database.query(
      `UPDATE pastoral_insight_states SET church_id = 'another_church'
       WHERE church_id = ? AND id = ?`,
      [churchId, insight.id],
    );
    await assert.rejects(
      applyPastoralInsightAction(churchId, actorId, insight.id, { action: 'dismiss' }),
      (error) => error.code === 'PASTORAL_INSIGHT_NOT_FOUND',
    );
    assert.equal((await Database.query(
      `SELECT state FROM engagement_decline_deliveries WHERE church_id = ? AND event_id = ?`,
      [churchId, eventId],
    )).length, 0);
  });
});
