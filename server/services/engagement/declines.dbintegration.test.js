'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../../config/logger');

logger.exceptions?.unhandle();
logger.rejections?.unhandle();

const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const {
  evaluateEngagementDeclines,
  createEligibleDeliveryRowsWithConnection,
} = require('./declines');

const SUNDAY = '2026-08-16';
const AS_OF = '2026-08-17T12:00:00.000Z';

function addDays(date, days) {
  const instant = new Date(`${date}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

function asOfAfter(completedWeekEnd) {
  return `${addDays(completedWeekEnd, 1)}T12:00:00.000Z`;
}

async function seedChurch(churchId) {
  await Database.query(
    `UPDATE church_settings SET timezone = 'UTC' WHERE church_id = ?`,
    [churchId],
  );
  const user = await Database.query(
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
  const community = await Database.query(
    `INSERT INTO gathering_types
       (name, attendance_type, is_active, engagement_role, church_id)
     VALUES ('Community', 'standard', 1, 'community', ?)`,
    [churchId],
  );
  return {
    actorId: user.insertId,
    primaryId: primary.insertId,
    communityId: community.insertId,
  };
}

async function seedFamily(churchId, name = 'Example') {
  const result = await Database.query(
    `INSERT INTO families (family_name, church_id) VALUES (?, ?)`,
    [name, churchId],
  );
  return result.insertId;
}

async function seedPerson(churchId, fixture, overrides = {}) {
  const result = await Database.query(
    `INSERT INTO individuals
       (first_name, last_name, family_id, people_type, is_active, church_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      overrides.firstName || 'Person',
      overrides.lastName || 'Example',
      overrides.familyId ?? null,
      overrides.peopleType || 'regular',
      overrides.isActive === undefined ? 1 : overrides.isActive,
      churchId,
    ],
  );
  if (overrides.primaryAssigned !== false) {
    await Database.query(
      `INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id)
       VALUES (?, ?, ?)`,
      [fixture.primaryId, result.insertId, churchId],
    );
  }
  if (overrides.communityAssigned) {
    await Database.query(
      `INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id)
       VALUES (?, ?, ?)`,
      [fixture.communityId, result.insertId, churchId],
    );
  }
  return result.insertId;
}

const PAIR_ATTENDANCE = Object.freeze({
  core_core: [4, 4, 4],
  casual_casual: [0, 3, 0],
  irregular_irregular: [0, 1, 0],
  core_casual: [4, 3, 0],
  casual_irregular: [3, 0, 0],
  core_irregular: [4, 1, 0],
  irregular_casual: [0, 0, 3],
  irregular_core: [0, 1, 4],
  casual_core: [0, 3, 2],
});

function profileRecords(pair, status) {
  if (status === 'establishing') {
    return Array.from({ length: 12 }, (_, index) => ({
      eligible: index < 7,
      present: index < 4,
    }));
  }
  const counts = PAIR_ATTENDANCE[pair];
  if (!counts) throw new Error(`Unknown profile pair: ${pair}`);
  return counts.flatMap((presentCount) => Array.from({ length: 4 }, (_, index) => ({
    eligible: true,
    present: index < presentCount,
  })));
}

async function replaceProfileSnapshot(churchId, fixture, completedWeekEnd, profiles) {
  await Database.query('DELETE FROM attendance_sessions WHERE church_id = ?', [churchId]);
  const offsets = [-385, -378, -371, -364, -350, -250, -150, -50, -21, -14, -7, 0];

  for (const axis of ['primary', 'community']) {
    const gatheringTypeId = axis === 'primary' ? fixture.primaryId : fixture.communityId;
    const axisProfiles = profiles.filter((profile) => profile[axis]);
    if (axisProfiles.length === 0) continue;
    for (let index = 0; index < offsets.length; index += 1) {
      const session = await Database.query(
        `INSERT INTO attendance_sessions
           (gathering_type_id, session_date, created_by, roster_snapshotted,
            session_status, roster_provenance_version, church_id)
         VALUES (?, ?, ?, 1, 'held', 1, ?)`,
        [gatheringTypeId, addDays(completedWeekEnd, offsets[index]), fixture.actorId, churchId],
      );
      for (const profile of axisProfiles) {
        const fact = profileRecords(profile[axis], profile[`${axis}Status`])[index];
        await Database.query(
          `INSERT INTO attendance_records
             (session_id, individual_id, present, eligible_at_snapshot,
              people_type_at_time, church_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            session.insertId,
            profile.individualId,
            fact.present ? 1 : 0,
            fact.eligible ? 1 : 0,
            profile.peopleTypeAtTime || 'regular',
            churchId,
          ],
        );
      }
    }
  }
}

async function events(churchId) {
  return Database.query(
    `SELECT id, individual_id AS individualId,
            family_at_detection_id AS familyAtDetectionId,
            from_tier AS fromTier, to_tier AS toTier,
            effective_week_end AS effectiveWeekEnd,
            rules_version AS rulesVersion, recovered_at AS recoveredAt
     FROM engagement_decline_events
     WHERE church_id = ?
     ORDER BY id`,
    [churchId],
  );
}

test('activation and rules-version changes baseline existing declines without alerting', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedChurch(churchId);
    const individualId = await seedPerson(churchId, fixture);
    await replaceProfileSnapshot(churchId, fixture, SUNDAY, [
      { individualId, primary: 'core_irregular' },
    ]);

    assert.deepEqual(await evaluateEngagementDeclines(churchId, { asOf: AS_OF }), {
      completedWeekEnd: SUNDAY,
      baselined: 1,
      eventsCreated: 0,
      eventsRecovered: 0,
      deliveriesCreated: 0,
    });
    assert.deepEqual(await Database.query(
      `SELECT rules_version AS rulesVersion, current_tier AS currentTier,
              active_lowest_decline_tier AS activeTier,
              baseline_suppressed AS baselineSuppressed
       FROM engagement_evaluation_state
       WHERE church_id = ? AND individual_id = ?`,
      [churchId, individualId],
    ), [{
      rulesVersion: 1,
      currentTier: 'irregular',
      activeTier: 'irregular',
      baselineSuppressed: 1,
    }]);
    assert.equal((await events(churchId)).length, 0);

    const unchangedWeek = addDays(SUNDAY, 7);
    await replaceProfileSnapshot(churchId, fixture, unchangedWeek, [
      { individualId, primary: 'core_irregular' },
    ]);
    const stillSuppressed = await evaluateEngagementDeclines(churchId, {
      asOf: asOfAfter(unchangedWeek),
    });
    assert.equal(stillSuppressed.baselined, 0);
    assert.equal(stillSuppressed.eventsCreated, 0);
    assert.equal((await events(churchId)).length, 0);

    await Database.query(
      `INSERT INTO engagement_settings (church_id, calculation_rules_version)
       VALUES (?, 2)
       ON CONFLICT(church_id) DO UPDATE SET calculation_rules_version = 2`,
      [churchId],
    );
    const nextWeek = addDays(SUNDAY, 14);
    await replaceProfileSnapshot(churchId, fixture, nextWeek, [
      { individualId, primary: 'core_irregular' },
    ]);
    const versionBaseline = await evaluateEngagementDeclines(churchId, {
      asOf: asOfAfter(nextWeek),
    });
    assert.equal(versionBaseline.baselined, 1);
    assert.equal(versionBaseline.eventsCreated, 0);
    assert.equal((await events(churchId)).length, 0);
  });
});

test('persists each supported Primary decline once for a completed week', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedChurch(churchId);
    const familyId = await seedFamily(churchId, 'Alerted');
    const people = await Promise.all([
      seedPerson(churchId, fixture, { firstName: 'Core Casual', familyId }),
      seedPerson(churchId, fixture, { firstName: 'Casual Irregular' }),
      seedPerson(churchId, fixture, { firstName: 'Core Irregular' }),
    ]);
    const caregiver = await assignUser(churchId, familyId);
    const baselineWeek = addDays(SUNDAY, -7);
    await replaceProfileSnapshot(churchId, fixture, baselineWeek, people.map((individualId) => ({
      individualId,
      primary: 'core_core',
    })));
    await evaluateEngagementDeclines(churchId, { asOf: asOfAfter(baselineWeek) });

    await replaceProfileSnapshot(churchId, fixture, SUNDAY, [
      { individualId: people[0], primary: 'core_casual' },
      { individualId: people[1], primary: 'casual_irregular' },
      { individualId: people[2], primary: 'core_irregular' },
    ]);
    assert.deepEqual(await evaluateEngagementDeclines(churchId, { asOf: AS_OF }), {
      completedWeekEnd: SUNDAY,
      baselined: 0,
      eventsCreated: 3,
      eventsRecovered: 0,
      deliveriesCreated: 1,
    });
    assert.deepEqual((await events(churchId)).map((event) => ({
      individualId: event.individualId,
      fromTier: event.fromTier,
      toTier: event.toTier,
      effectiveWeekEnd: event.effectiveWeekEnd,
    })), [
      { individualId: people[0], fromTier: 'core', toTier: 'casual', effectiveWeekEnd: SUNDAY },
      { individualId: people[1], fromTier: 'casual', toTier: 'irregular', effectiveWeekEnd: SUNDAY },
      { individualId: people[2], fromTier: 'core', toTier: 'irregular', effectiveWeekEnd: SUNDAY },
    ]);
    assert.deepEqual(await Database.query(
      `SELECT delivery.recipient_type AS recipientType,
              delivery.recipient_id AS recipientId,
              delivery.family_caregiver_id AS familyCaregiverId,
              event.individual_id AS individualId
       FROM engagement_decline_deliveries delivery
       JOIN engagement_decline_events event
         ON event.id = delivery.event_id AND event.church_id = ?
       WHERE delivery.church_id = ?`,
      [churchId, churchId],
    ), [{
      recipientType: 'user',
      recipientId: caregiver.recipientId,
      familyCaregiverId: caregiver.assignmentId,
      individualId: people[0],
    }]);

    const repeated = await evaluateEngagementDeclines(churchId, { asOf: AS_OF });
    assert.equal(repeated.eventsCreated, 0);
    assert.equal(repeated.deliveriesCreated, 0);
    assert.equal((await events(churchId)).length, 3);
  });
});

test('creates deeper episodes, recovers only surpassed tiers, and re-arms a later decline', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedChurch(churchId);
    const individualId = await seedPerson(churchId, fixture);
    const weeks = Array.from({ length: 6 }, (_, index) => addDays(SUNDAY, index * 7));

    await replaceProfileSnapshot(churchId, fixture, weeks[0], [
      { individualId, primary: 'core_core' },
    ]);
    await evaluateEngagementDeclines(churchId, { asOf: asOfAfter(weeks[0]) });

    await replaceProfileSnapshot(churchId, fixture, weeks[1], [
      { individualId, primary: 'core_casual' },
    ]);
    assert.equal((await evaluateEngagementDeclines(churchId, {
      asOf: asOfAfter(weeks[1]),
    })).eventsCreated, 1);

    await replaceProfileSnapshot(churchId, fixture, weeks[2], [
      { individualId, primary: 'casual_irregular' },
    ]);
    assert.equal((await evaluateEngagementDeclines(churchId, {
      asOf: asOfAfter(weeks[2]),
    })).eventsCreated, 1);

    await replaceProfileSnapshot(churchId, fixture, weeks[3], [
      { individualId, primary: 'irregular_casual' },
    ]);
    const partialRecovery = await evaluateEngagementDeclines(churchId, {
      asOf: asOfAfter(weeks[3]),
    });
    assert.equal(partialRecovery.eventsRecovered, 1);
    let persisted = await events(churchId);
    assert.equal(persisted[0].toTier, 'casual');
    assert.equal(persisted[0].recoveredAt, null);
    assert.notEqual(persisted[1].recoveredAt, null);

    await replaceProfileSnapshot(churchId, fixture, weeks[4], [
      { individualId, primary: 'casual_irregular' },
    ]);
    assert.equal((await evaluateEngagementDeclines(churchId, {
      asOf: asOfAfter(weeks[4]),
    })).eventsCreated, 1);
    persisted = await events(churchId);
    assert.equal(persisted.length, 3);
    assert.deepEqual(persisted.map((event) => event.toTier), ['casual', 'irregular', 'irregular']);

    await replaceProfileSnapshot(churchId, fixture, weeks[5], [
      { individualId, primary: 'casual_core' },
    ]);
    const fullRecovery = await evaluateEngagementDeclines(churchId, {
      asOf: asOfAfter(weeks[5]),
    });
    assert.equal(fullRecovery.eventsRecovered, 2);
    assert.equal((await events(churchId)).every((event) => event.recoveredAt !== null), true);
    assert.deepEqual(await Database.query(
      `SELECT current_tier AS currentTier,
              active_lowest_decline_tier AS activeTier,
              baseline_suppressed AS baselineSuppressed
       FROM engagement_evaluation_state
       WHERE church_id = ? AND individual_id = ?`,
      [churchId, individualId],
    ), [{ currentTier: 'core', activeTier: null, baselineSuppressed: 0 }]);
  });
});

test('does not turn a direct Core-to-Irregular partial recovery into a later Core-to-Casual event', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedChurch(churchId);
    const individualId = await seedPerson(churchId, fixture);
    const weeks = Array.from({ length: 6 }, (_, index) => addDays(SUNDAY, index * 7));

    await replaceProfileSnapshot(churchId, fixture, weeks[0], [
      { individualId, primary: 'core_core' },
    ]);
    await evaluateEngagementDeclines(churchId, { asOf: asOfAfter(weeks[0]) });

    await replaceProfileSnapshot(churchId, fixture, weeks[1], [
      { individualId, primary: 'core_irregular' },
    ]);
    assert.equal((await evaluateEngagementDeclines(churchId, {
      asOf: asOfAfter(weeks[1]),
    })).eventsCreated, 1);

    await replaceProfileSnapshot(churchId, fixture, weeks[2], [
      { individualId, primary: 'irregular_casual' },
    ]);
    assert.equal((await evaluateEngagementDeclines(churchId, {
      asOf: asOfAfter(weeks[2]),
    })).eventsRecovered, 1);

    await replaceProfileSnapshot(churchId, fixture, weeks[3], [
      { individualId, primary: 'core_casual' },
    ]);
    const stableCasual = await evaluateEngagementDeclines(churchId, {
      asOf: asOfAfter(weeks[3]),
    });
    assert.equal(stableCasual.eventsCreated, 0);
    assert.deepEqual((await events(churchId)).map((event) => ({
      fromTier: event.fromTier,
      toTier: event.toTier,
      recovered: event.recoveredAt !== null,
    })), [{ fromTier: 'core', toTier: 'irregular', recovered: true }]);

    await replaceProfileSnapshot(churchId, fixture, weeks[4], [
      { individualId, primary: 'casual_core' },
    ]);
    await evaluateEngagementDeclines(churchId, { asOf: asOfAfter(weeks[4]) });
    await replaceProfileSnapshot(churchId, fixture, weeks[5], [
      { individualId, primary: 'core_casual' },
    ]);
    assert.equal((await evaluateEngagementDeclines(churchId, {
      asOf: asOfAfter(weeks[5]),
    })).eventsCreated, 1);
    assert.deepEqual((await events(churchId)).map((event) => event.toTier), [
      'irregular',
      'casual',
    ]);
  });
});

test('keeps a partially recovered activation baseline suppressed until a new lower tier', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedChurch(churchId);
    const individualId = await seedPerson(churchId, fixture);
    const weeks = Array.from({ length: 4 }, (_, index) => addDays(SUNDAY, index * 7));

    await replaceProfileSnapshot(churchId, fixture, weeks[0], [
      { individualId, primary: 'core_irregular' },
    ]);
    await evaluateEngagementDeclines(churchId, { asOf: asOfAfter(weeks[0]) });

    await replaceProfileSnapshot(churchId, fixture, weeks[1], [
      { individualId, primary: 'irregular_casual' },
    ]);
    await evaluateEngagementDeclines(churchId, { asOf: asOfAfter(weeks[1]) });
    assert.deepEqual(await Database.query(
      `SELECT current_tier AS currentTier,
              active_lowest_decline_tier AS activeTier,
              baseline_suppressed AS baselineSuppressed
       FROM engagement_evaluation_state
       WHERE church_id = ? AND individual_id = ?`,
      [churchId, individualId],
    ), [{ currentTier: 'casual', activeTier: 'casual', baselineSuppressed: 1 }]);

    await replaceProfileSnapshot(churchId, fixture, weeks[2], [
      { individualId, primary: 'core_casual' },
    ]);
    assert.equal((await evaluateEngagementDeclines(churchId, {
      asOf: asOfAfter(weeks[2]),
    })).eventsCreated, 0);

    await replaceProfileSnapshot(churchId, fixture, weeks[3], [
      { individualId, primary: 'casual_irregular' },
    ]);
    assert.equal((await evaluateEngagementDeclines(churchId, {
      asOf: asOfAfter(weeks[3]),
    })).eventsCreated, 1);
    assert.deepEqual((await events(churchId)).map((event) => ({
      fromTier: event.fromTier,
      toTier: event.toTier,
    })), [{ fromTier: 'casual', toTier: 'irregular' }]);
  });
});

test('suppresses non-established, unassigned, visitor, inactive, and Community-only movement', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedChurch(churchId);
    const establishing = await seedPerson(churchId, fixture, { firstName: 'Establishing' });
    const unassigned = await seedPerson(churchId, fixture, {
      firstName: 'Unassigned', primaryAssigned: false,
    });
    const visitor = await seedPerson(churchId, fixture, {
      firstName: 'Visitor', peopleType: 'local_visitor',
    });
    const inactive = await seedPerson(churchId, fixture, {
      firstName: 'Inactive', isActive: 0,
    });
    const communityOnly = await seedPerson(churchId, fixture, {
      firstName: 'Community', communityAssigned: true,
    });
    const profiles = [
      { individualId: establishing, primary: 'core_irregular', primaryStatus: 'establishing' },
      { individualId: visitor, primary: 'core_irregular', peopleTypeAtTime: 'local_visitor' },
      { individualId: inactive, primary: 'core_irregular' },
      { individualId: communityOnly, primary: 'core_core', community: 'core_irregular' },
    ];
    const baselineWeek = addDays(SUNDAY, -7);
    await replaceProfileSnapshot(churchId, fixture, baselineWeek, profiles);
    await evaluateEngagementDeclines(churchId, { asOf: asOfAfter(baselineWeek) });
    await replaceProfileSnapshot(churchId, fixture, SUNDAY, profiles);

    const result = await evaluateEngagementDeclines(churchId, { asOf: AS_OF });
    assert.equal(result.eventsCreated, 0);
    assert.equal((await events(churchId)).length, 0);
    assert.deepEqual((await Database.query(
      `SELECT individual_id AS individualId
       FROM engagement_evaluation_state
       WHERE church_id = ? ORDER BY individual_id`,
      [churchId],
    )).map((row) => row.individualId), [establishing, unassigned, communityOnly]);
  });
});

function detectionInput(churchId, individualId, familyId, week = SUNDAY) {
  return {
    churchId,
    individualId,
    familyId,
    fromTier: 'core',
    toTier: 'casual',
    effectiveWeekEnd: week,
    rulesVersion: 1,
  };
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

test('snapshots every email-eligible stable caregiver ID and deduplicates crash-safe retries', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedChurch(churchId);
    const familyId = await seedFamily(churchId);
    const individualId = await seedPerson(churchId, fixture, { familyId });
    const sharedEmail = `shared-${churchId}@example.test`;
    const eligibleUser = await assignUser(churchId, familyId, {
      email: sharedEmail,
      primaryContactMethod: 'sms',
    });
    const eligibleContact = await assignContact(churchId, familyId, fixture.actorId, {
      email: sharedEmail,
    });
    await assignUser(churchId, familyId, { emailNotifications: 0 });
    await assignUser(churchId, familyId, { isActive: 0 });
    await assignUser(churchId, familyId, { email: null });
    await assignContact(churchId, familyId, fixture.actorId, { primaryContactMethod: 'sms' });
    await assignContact(churchId, familyId, fixture.actorId, { isActive: 0 });
    await assignContact(churchId, familyId, fixture.actorId, { email: null });
    const detection = detectionInput(churchId, individualId, familyId);
    const created = await Database.transactionForChurch(churchId, (conn) =>
      createEligibleDeliveryRowsWithConnection(conn, detection));
    assert.deepEqual({
      eventCreated: created.eventCreated,
      deliveriesCreated: created.deliveriesCreated,
    }, {
      eventCreated: 1,
      deliveriesCreated: 2,
    });
    assert.equal(Number.isInteger(created.eventId), true);
    assert.deepEqual(await Database.transactionForChurch(churchId, (conn) =>
      createEligibleDeliveryRowsWithConnection(conn, detection)), {
      eventId: null,
      eventCreated: 0,
      deliveriesCreated: 0,
    });
    assert.deepEqual(await Database.query(
      `SELECT recipient_type AS recipientType, recipient_id AS recipientId,
              family_caregiver_id AS familyCaregiverId, state
       FROM engagement_decline_deliveries
       WHERE church_id = ? AND event_id = ?
       ORDER BY recipient_type DESC`,
      [churchId, created.eventId],
    ), [
      {
        recipientType: 'user',
        recipientId: eligibleUser.recipientId,
        familyCaregiverId: eligibleUser.assignmentId,
        state: 'pending',
      },
      {
        recipientType: 'contact',
        recipientId: eligibleContact.recipientId,
        familyCaregiverId: eligibleContact.assignmentId,
        state: 'pending',
      },
    ]);

    const noFamilyPerson = await seedPerson(churchId, fixture, { familyId: null });
    const noFamily = await Database.transactionForChurch(churchId, (conn) =>
      createEligibleDeliveryRowsWithConnection(conn, detectionInput(
        churchId,
        noFamilyPerson,
        null,
        addDays(SUNDAY, 7),
      )));
    assert.equal(noFamily.eventCreated, 1);
    assert.equal(noFamily.deliveriesCreated, 0);
  });
});

test('freezes family and recipients at detection without retroactive delivery after assignment', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedChurch(churchId);
    const originalFamilyId = await seedFamily(churchId, 'Original');
    const laterFamilyId = await seedFamily(churchId, 'Later');
    const individualId = await seedPerson(churchId, fixture, { familyId: originalFamilyId });
    const baselineWeek = addDays(SUNDAY, -7);
    await replaceProfileSnapshot(churchId, fixture, baselineWeek, [
      { individualId, primary: 'core_core' },
    ]);
    await evaluateEngagementDeclines(churchId, { asOf: asOfAfter(baselineWeek) });
    await replaceProfileSnapshot(churchId, fixture, SUNDAY, [
      { individualId, primary: 'core_casual' },
    ]);
    const detection = await evaluateEngagementDeclines(churchId, { asOf: AS_OF });
    assert.equal(detection.eventsCreated, 1);
    assert.equal(detection.deliveriesCreated, 0);
    assert.equal((await events(churchId))[0].familyAtDetectionId, originalFamilyId);

    await Database.query(
      `UPDATE individuals SET family_id = ? WHERE id = ? AND church_id = ?`,
      [laterFamilyId, individualId, churchId],
    );
    await assignUser(churchId, laterFamilyId);
    assert.equal((await evaluateEngagementDeclines(churchId, { asOf: AS_OF })).deliveriesCreated, 0);
    const nextWeek = addDays(SUNDAY, 7);
    await replaceProfileSnapshot(churchId, fixture, nextWeek, [
      { individualId, primary: 'core_casual' },
    ]);
    assert.equal((await evaluateEngagementDeclines(churchId, {
      asOf: asOfAfter(nextWeek),
    })).deliveriesCreated, 0);
    assert.equal((await Database.query(
      `SELECT COUNT(*) AS count FROM engagement_decline_deliveries WHERE church_id = ?`,
      [churchId],
    ))[0].count, 0);
    assert.equal((await events(churchId))[0].familyAtDetectionId, originalFamilyId);
  });
});

test('does not add a caregiver assigned to the detection family after its recipient snapshot', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedChurch(churchId);
    const familyId = await seedFamily(churchId, 'Unchanged family');
    const individualId = await seedPerson(churchId, fixture, { familyId });
    const detection = detectionInput(churchId, individualId, familyId);
    const initial = await Database.transactionForChurch(churchId, (conn) =>
      createEligibleDeliveryRowsWithConnection(conn, detection));
    assert.equal(initial.eventCreated, 1);
    assert.equal(initial.deliveriesCreated, 0);

    await assignUser(churchId, familyId);
    assert.deepEqual(await Database.transactionForChurch(churchId, (conn) =>
      createEligibleDeliveryRowsWithConnection(conn, detection)), {
      eventId: null,
      eventCreated: 0,
      deliveriesCreated: 0,
    });
    assert.equal((await Database.query(
      `SELECT COUNT(*) AS count
       FROM engagement_decline_deliveries
       WHERE church_id = ? AND event_id = ?`,
      [churchId, initial.eventId],
    ))[0].count, 0);
  });
});
