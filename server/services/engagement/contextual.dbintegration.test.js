'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'contextual-long-term-test-secret';

const logger = require('../../config/logger');
logger.exceptions?.unhandle();
logger.rejections?.unhandle();

const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { createDrilldownToken, DrilldownTokenError } = require('./drilldownTokens');
const {
  canonicalGatheringIds,
  getContextualWindow,
  buildContextualLongTermOverview,
  listContextualPeople,
  listContextualSessions,
} = require('./contextual');

const AS_OF = new Date('2026-09-02T02:00:00Z');

async function seedUser(churchId) {
  const result = await Database.query(
    `INSERT INTO users (email, role, first_name, last_name, is_active, church_id)
     VALUES (?, 'admin', 'Context', 'Admin', 1, ?)`,
    [`${churchId}@example.com`, churchId],
  );
  return result.insertId;
}

async function seedGathering(churchId, {
  name,
  attendanceType = 'standard',
  isActive = 1,
}) {
  const result = await Database.query(
    `INSERT INTO gathering_types (name, attendance_type, is_active, church_id)
     VALUES (?, ?, ?, ?)`,
    [name, attendanceType, isActive, churchId],
  );
  return result.insertId;
}

async function seedPerson(churchId, {
  firstName,
  lastName = 'Example',
  peopleType = 'regular',
  isActive = 1,
}) {
  const result = await Database.query(
    `INSERT INTO individuals
       (first_name, last_name, people_type, is_active, church_id)
     VALUES (?, ?, ?, ?, ?)`,
    [firstName, lastName, peopleType, isActive, churchId],
  );
  return result.insertId;
}

async function assign(churchId, gatheringTypeId, individualId) {
  await Database.query(
    `INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id)
     VALUES (?, ?, ?)`,
    [gatheringTypeId, individualId, churchId],
  );
}

async function seedSession(churchId, userId, gatheringTypeId, sessionDate, {
  status = 'held',
  excluded = 0,
  rosterSnapshotted = 1,
  rosterProvenanceVersion = 1,
  headcountMode = 'separate',
  records = [],
  headcounts = [],
} = {}) {
  const result = await Database.query(
    `INSERT INTO attendance_sessions
       (gathering_type_id, session_date, created_by, headcount_mode,
        roster_snapshotted, roster_provenance_version, excluded_from_stats,
        session_status, church_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      gatheringTypeId,
      sessionDate,
      userId,
      headcountMode,
      rosterSnapshotted,
      rosterProvenanceVersion,
      excluded,
      status,
      churchId,
    ],
  );
  for (const record of records) {
    await Database.query(
      `INSERT INTO attendance_records
         (session_id, individual_id, present, eligible_at_snapshot,
          people_type_at_time, church_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        result.insertId,
        record.individualId,
        record.present ?? 0,
        record.eligible ?? 1,
        record.peopleTypeAtTime ?? 'regular',
        churchId,
      ],
    );
  }
  for (let index = 0; index < headcounts.length; index += 1) {
    const updatedBy = index === 0 ? userId : (await Database.query(
      `INSERT INTO users (email, role, first_name, last_name, church_id)
       VALUES (?, 'attendance_taker', 'Counter', ?, ?)`,
      [`counter-${index}-${churchId}@example.com`, String(index), churchId],
    )).insertId;
    await Database.query(
      `INSERT INTO headcount_records (session_id, headcount, updated_by, church_id)
       VALUES (?, ?, ?, ?)`,
      [result.insertId, headcounts[index], updatedBy, churchId],
    );
  }
  return result.insertId;
}

function sundayWeeksEnding(endDate, count) {
  const end = new Date(`${endDate}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - ((count - index - 1) * 7));
    return date.toISOString().slice(0, 10);
  });
}

test('canonicalizes gathering IDs and calculates the latest fully completed 52-week window', () => {
  assert.deepEqual(canonicalGatheringIds(['3', 1, '3', 2]), [1, 2, 3]);
  for (const value of [undefined, null, [], [''], [0], [-1], [1.5], ['1x']]) {
    assert.throws(
      () => canonicalGatheringIds(value),
      (error) => error.code === 'INVALID_REPORT_GATHERING',
    );
  }
  assert.deepEqual(getContextualWindow(AS_OF, 'Australia/Sydney'), {
    completedWeekEnd: '2026-08-30',
    startDate: '2025-09-01',
    endDate: '2026-08-30',
    maximumWeeks: 52,
  });
});

test('scopes selection, population, weekly evidence, availability, and mixed/headcount results', async () => {
  await withTestChurchDb(async (churchId) => {
    const userId = await seedUser(churchId);
    const amId = await seedGathering(churchId, { name: 'AM' });
    const pmId = await seedGathering(churchId, { name: 'PM' });
    const youthId = await seedGathering(churchId, { name: 'Youth' });
    const headcountId = await seedGathering(churchId, {
      name: 'Festival', attendanceType: 'headcount',
    });

    const alexId = await seedPerson(churchId, { firstName: 'Alex', lastName: 'Able' });
    const bethId = await seedPerson(churchId, { firstName: 'Beth', lastName: 'Baker' });
    const youthPersonId = await seedPerson(churchId, { firstName: 'Cara', lastName: 'Clark' });
    const youthNoEvidenceId = await seedPerson(churchId, {
      firstName: 'Drew', lastName: 'No Evidence',
    });
    const historicalId = await seedPerson(churchId, { firstName: 'Former', lastName: 'Attendee' });
    const inactiveId = await seedPerson(churchId, {
      firstName: 'Inactive', lastName: 'Regular', isActive: 0,
    });
    const visitorId = await seedPerson(churchId, {
      firstName: 'Local', lastName: 'Visitor', peopleType: 'local_visitor',
    });
    await assign(churchId, amId, alexId);
    await assign(churchId, pmId, bethId);
    await assign(churchId, youthId, youthPersonId);
    await assign(churchId, youthId, youthNoEvidenceId);
    await assign(churchId, amId, inactiveId);
    await assign(churchId, amId, visitorId);

    await seedSession(churchId, userId, amId, '2026-08-24', {
      status: 'open',
      records: [
        { individualId: alexId, present: 1 },
        { individualId: bethId, present: 0, eligible: 0 },
        { individualId: historicalId, present: 1 },
      ],
    });
    await seedSession(churchId, userId, pmId, '2026-08-30', {
      records: [
        { individualId: alexId, present: 1, eligible: 0 },
        { individualId: bethId, present: 0 },
      ],
    });
    await seedSession(churchId, userId, youthId, '2026-08-17', {
      records: [{ individualId: youthPersonId, present: 1 }],
    });
    await seedSession(churchId, userId, amId, '2026-08-10', {
      rosterSnapshotted: 0,
      rosterProvenanceVersion: 0,
      records: [{ individualId: alexId, present: 0 }],
    });
    const headcountSessionId = await seedSession(
      churchId,
      userId,
      headcountId,
      '2026-08-29',
      { headcountMode: 'combined', headcounts: [10, 12] },
    );

    const overview = await buildContextualLongTermOverview(churchId, [pmId, amId, amId], {
      asOf: AS_OF,
    });
    assert.equal(overview.schemaVersion, 4);
    assert.deepEqual(overview.gatheringTypeIds, [amId, pmId]);
    assert.equal(overview.window.completedWeekEnd, '2026-08-30');
    assert.equal(overview.regularity.population, 2);
    assert.equal(overview.dataAvailability.availableWeeks, 1);
    assert.equal(overview.dataAvailability.firstSessionDate, '2026-08-24');
    assert.equal(overview.dataAvailability.lastSessionDate, '2026-08-30');
    assert.equal(overview.dataAvailability.validOpportunityWeeks, 1);
    assert.equal(overview.dataAvailability.excludedWeeks, 0);
    assert.equal(overview.dataAvailability.unclassifiedBecauseNoEvidence, 0);
    assert.deepEqual(Object.keys(overview.settings).sort(), [
      'calculationRulesVersion', 'casualMinimum', 'coreMinimum', 'tiers',
    ]);
    assert.equal(overview.regularity.tiers.find(({ tier }) => tier === 'core').count, 1);
    assert.equal(overview.regularity.tiers.find(({ tier }) => tier === 'irregular').count, 1);

    const coreToken = overview.regularity.tiers.find(({ tier }) => tier === 'core').peopleToken;
    const coreRows = await listContextualPeople(churchId, { segment: coreToken });
    assert.deepEqual(coreRows.rows.map(({ individualId }) => individualId), [alexId]);
    assert.deepEqual(coreRows.rows[0].evidence, {
      attendedWeeks: 1,
      opportunityWeeks: 1,
    });

    const youth = await buildContextualLongTermOverview(churchId, [youthId], { asOf: AS_OF });
    assert.equal(youth.regularity.population, 2);
    assert.equal(youth.regularity.tiers.find(({ tier }) => tier === 'core').count, 1);
    assert.equal(youth.dataAvailability.unclassifiedBecauseNoEvidence, 1);

    const mixed = await buildContextualLongTermOverview(churchId, [headcountId, amId], {
      asOf: AS_OF,
    });
    assert.equal(mixed.direction.series.length, 2);
    assert.deepEqual(
      mixed.direction.series.map(({ attendanceType }) => attendanceType).sort(),
      ['headcount', 'standard'],
    );
    assert.equal(mixed.regularity.population, 1);
    assert.equal(mixed.declines.total, 0);
    const headcountSeries = mixed.direction.series.find(
      ({ gatheringTypeId }) => gatheringTypeId === headcountId,
    );
    const populatedBucket = headcountSeries.buckets.find(({ heldSessions }) => heldSessions === 1);
    assert.equal(populatedBucket.averageAttendance, 22);
    const sessions = await listContextualSessions(churchId, {
      series: populatedBucket.sessionsToken,
    });
    assert.deepEqual(sessions.rows.map(({ sessionId }) => sessionId), [headcountSessionId]);
    assert.equal(sessions.rows[0].attendance, 22);

    const headcountOnly = await buildContextualLongTermOverview(churchId, [headcountId], {
      asOf: AS_OF,
    });
    assert.equal(headcountOnly.regularity, null);
    assert.equal(headcountOnly.declines, null);
    assert.equal(headcountOnly.increases, null);
    assert.equal(headcountOnly.dataAvailability.standardGatherings, 0);
    assert.equal(headcountOnly.dataAvailability.headcountGatherings, 1);
  });
});

test('rejects a foreign-church gathering before loading attendance data', async () => {
  await withTestChurchDb(async (churchId) => {
    const foreignChurchId = `${churchId}_foreign`;
    const result = await Database.query(
      `INSERT INTO gathering_types (name, attendance_type, is_active, church_id)
       VALUES ('Foreign', 'standard', 1, ?)`,
      [foreignChurchId],
    );
    const statements = [];
    const originalQueryForChurch = Database.queryForChurch;
    Database.queryForChurch = async function observedQuery(contextChurchId, sql, params) {
      statements.push(sql);
      return originalQueryForChurch.call(this, contextChurchId, sql, params);
    };
    try {
      await assert.rejects(
        buildContextualLongTermOverview(churchId, [result.insertId], { asOf: AS_OF }),
        (error) => error.code === 'INVALID_REPORT_GATHERING',
      );
    } finally {
      Database.queryForChurch = originalQueryForChurch;
    }
    assert.equal(statements.length, 1);
    assert.match(statements[0], /FROM gathering_types/);
    assert.doesNotMatch(statements[0], /attendance_sessions/);
  });
});

test('paginates contextual session drill-downs and binds cursors to their selected gathering', async () => {
  await withTestChurchDb(async (churchId) => {
    const userId = await seedUser(churchId);
    const sundayId = await seedGathering(churchId, { name: 'Sunday' });
    const youthId = await seedGathering(churchId, { name: 'Youth' });
    const attendeeId = await seedPerson(churchId, {
      firstName: 'Session', lastName: 'Marker', peopleType: 'local_visitor',
    });
    const sundaySessionIds = [];
    for (const date of ['2026-08-24', '2026-08-17', '2026-08-10']) {
      sundaySessionIds.push(await seedSession(churchId, userId, sundayId, date, {
        records: [{ individualId: attendeeId, present: 1, peopleTypeAtTime: 'local_visitor' }],
      }));
    }
    await seedSession(churchId, userId, youthId, '2026-08-24', {
      records: [{ individualId: attendeeId, present: 1, peopleTypeAtTime: 'local_visitor' }],
    });

    const sunday = await buildContextualLongTermOverview(churchId, [sundayId], { asOf: AS_OF });
    const youth = await buildContextualLongTermOverview(churchId, [youthId], { asOf: AS_OF });
    const sundaySeries = sunday.direction.series[0].buckets.find(({ heldSessions }) => heldSessions === 3);
    const youthSeries = youth.direction.series[0].buckets.find(({ heldSessions }) => heldSessions === 1);

    const first = await listContextualSessions(churchId, {
      series: sundaySeries.sessionsToken,
      limit: 1,
    });
    assert.deepEqual(first.rows.map(({ sessionId }) => sessionId), [sundaySessionIds[0]]);
    assert.ok(first.nextCursor);

    const second = await listContextualSessions(churchId, {
      series: sundaySeries.sessionsToken,
      cursor: first.nextCursor,
      limit: 10,
    });
    assert.deepEqual(second.rows.map(({ sessionId }) => sessionId), sundaySessionIds.slice(1));
    assert.equal(second.nextCursor, null);

    await assert.rejects(
      listContextualSessions(churchId, {
        series: youthSeries.sessionsToken,
        cursor: first.nextCursor,
      }),
      DrilldownTokenError,
    );
  });
});

test('reports shorter history exactly, caps old history at 52 weeks, and compares twelve-week periods', async () => {
  await withTestChurchDb(async (churchId) => {
    const userId = await seedUser(churchId);
    const gatheringTypeId = await seedGathering(churchId, {
      name: 'Counted', attendanceType: 'headcount',
    });
    const dates = sundayWeeksEnding('2026-08-30', 31);
    for (let index = 0; index < dates.length; index += 1) {
      const count = index < 7 ? 30 : index < 19 ? 20 : 10;
      await seedSession(churchId, userId, gatheringTypeId, dates[index], {
        headcounts: [count],
      });
    }
    const overview = await buildContextualLongTermOverview(churchId, [gatheringTypeId], {
      asOf: AS_OF,
    });
    assert.equal(overview.dataAvailability.availableWeeks, 31);
    assert.equal(overview.dataAvailability.firstSessionDate, dates[0]);
    assert.equal(overview.dataAvailability.lastSessionDate, dates.at(-1));
    assert.deepEqual(
      {
        comparisonWeeks: overview.direction.comparisonWeeks,
        previousAverage: overview.direction.previousAverage,
        recentAverage: overview.direction.recentAverage,
        percentChange: overview.direction.percentChange,
        status: overview.direction.status,
      },
      {
        comparisonWeeks: 12,
        previousAverage: 20,
        recentAverage: 10,
        percentChange: -50,
        status: 'down',
      },
    );
  });

  await withTestChurchDb(async (churchId) => {
    const userId = await seedUser(churchId);
    const gatheringTypeId = await seedGathering(churchId, {
      name: 'Weekly', attendanceType: 'headcount',
    });
    for (const date of sundayWeeksEnding('2026-08-30', 55)) {
      await seedSession(churchId, userId, gatheringTypeId, date, { headcounts: [1] });
    }
    const overview = await buildContextualLongTermOverview(churchId, [gatheringTypeId], {
      asOf: AS_OF,
    });
    assert.equal(overview.dataAvailability.availableWeeks, 52);
    assert.equal(overview.window.startDate, '2025-09-01');
    assert.equal(overview.direction.series[0].buckets.length, 13);
  });
});

test('treats an unrounded attendance change below one percent as steady', async () => {
  await withTestChurchDb(async (churchId) => {
    const userId = await seedUser(churchId);
    const gatheringTypeId = await seedGathering(churchId, {
      name: 'Nearly level', attendanceType: 'headcount',
    });
    const dates = sundayWeeksEnding('2026-08-30', 24);
    for (let index = 0; index < dates.length; index += 1) {
      const count = index < 12 ? 121 : index < 22 ? 122 : 123;
      await seedSession(churchId, userId, gatheringTypeId, dates[index], {
        headcounts: [count],
      });
    }

    const overview = await buildContextualLongTermOverview(churchId, [gatheringTypeId], {
      asOf: AS_OF,
    });
    assert.equal(overview.direction.percentChange, 1);
    assert.equal(overview.direction.status, 'steady');
  });
});

test('treats an exact positive one percent attendance change as up', async () => {
  await withTestChurchDb(async (churchId) => {
    const userId = await seedUser(churchId);
    const gatheringTypeId = await seedGathering(churchId, {
      name: 'Exact positive boundary', attendanceType: 'headcount',
    });
    const dates = sundayWeeksEnding('2026-08-30', 24);
    for (let index = 0; index < dates.length; index += 1) {
      const count = index < 8 || (index >= 12 && index < 19) ? 8 : 9;
      await seedSession(churchId, userId, gatheringTypeId, dates[index], {
        headcounts: [count],
      });
    }

    const overview = await buildContextualLongTermOverview(churchId, [gatheringTypeId], {
      asOf: AS_OF,
    });
    assert.equal(overview.direction.percentChange, 1);
    assert.equal(overview.direction.status, 'up');
  });
});

test('treats an exact negative one percent attendance change as down', async () => {
  await withTestChurchDb(async (churchId) => {
    const userId = await seedUser(churchId);
    const gatheringTypeId = await seedGathering(churchId, {
      name: 'Exact negative boundary', attendanceType: 'headcount',
    });
    const dates = sundayWeeksEnding('2026-08-30', 24);
    for (const [index, count] of [
      [0, 166], [5, 167], [11, 167],
      [12, 165], [17, 165], [23, 165],
    ]) {
      await seedSession(churchId, userId, gatheringTypeId, dates[index], {
        headcounts: [count],
      });
    }

    const overview = await buildContextualLongTermOverview(churchId, [gatheringTypeId], {
      asOf: AS_OF,
    });
    assert.equal(overview.direction.percentChange, -1);
    assert.equal(overview.direction.status, 'down');
  });
});

test('finds conservative declines, summarizes evidence plainly, and binds paginated tokens', async () => {
  await withTestChurchDb(async (churchId) => {
    const userId = await seedUser(churchId);
    const gatheringTypeId = await seedGathering(churchId, { name: 'Sunday' });
    const otherGatheringId = await seedGathering(churchId, { name: 'Other' });
    const serviceMarkerId = await seedPerson(churchId, {
      firstName: 'Session', lastName: 'Marker', peopleType: 'local_visitor',
    });
    const people = [];
    for (let index = 0; index < 11; index += 1) {
      const individualId = await seedPerson(churchId, {
        firstName: `Person ${String(index).padStart(2, '0')}`,
        lastName: `Family ${String(index).padStart(2, '0')}`,
      });
      people.push(individualId);
      await assign(churchId, gatheringTypeId, individualId);
    }

    const dates = sundayWeeksEnding('2026-08-30', 16);
    for (let week = 0; week < dates.length; week += 1) {
      const records = [];
      for (const individualId of people) {
        if (week >= 14) continue; // only six of the final eight weeks have roster evidence
        records.push({
          individualId,
          present: week < 6 || week === 8 ? 1 : 0,
        });
      }
      records.push({
        individualId: serviceMarkerId,
        present: 1,
        peopleTypeAtTime: 'local_visitor',
      });
      await seedSession(churchId, userId, gatheringTypeId, dates[week], { records });
    }

    const overview = await buildContextualLongTermOverview(churchId, [gatheringTypeId], {
      asOf: AS_OF,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(overview.declines.total, 11);
    assert.equal(overview.declines.rows.length, 10);
    assert.deepEqual(overview.declines.rows[0].baseline, {
      attendedWeeks: 6,
      opportunityWeeks: 8,
      rate: 75,
    });
    assert.deepEqual(overview.declines.rows[0].recent, {
      attendedWeeks: 1,
      opportunityWeeks: 6,
      rate: 16.7,
    });
    assert.equal(
      overview.declines.rows[0].summary,
      'Usually attends 3 weeks in 4; attended 1 of the last 6 weeks.',
    );
    assert.deepEqual(
      overview.declines.rows.map(({ individualId }) => individualId),
      people.slice(0, 10),
    );

    const first = await listContextualPeople(churchId, {
      segment: overview.declines.peopleToken,
      limit: 5,
    });
    assert.equal(first.rows.length, 5);
    assert.ok(first.nextCursor);
    const second = await listContextualPeople(churchId, {
      segment: overview.declines.peopleToken,
      cursor: first.nextCursor,
      limit: 100,
    });
    assert.deepEqual(
      [...first.rows, ...second.rows].map(({ individualId }) => individualId),
      people,
    );
    await assert.rejects(
      listContextualPeople(churchId, {
        segment: overview.declines.peopleToken,
        limit: 101,
      }),
      (error) => error.code === 'INVALID_ENGAGEMENT_LIMIT',
    );
    await assert.rejects(
      listContextualPeople(`${churchId}_other`, { segment: overview.declines.peopleToken }),
      DrilldownTokenError,
    );

    const wrongSelectionCursor = createDrilldownToken({
      churchId,
      kind: 'people_cursor',
      gatheringTypeIds: [otherGatheringId],
      selector: {
        sourceSelector: {
          type: 'decline', gatheringTypeIds: [otherGatheringId],
        },
        after: {
          tierDrop: 2,
          percentagePointDrop: 58.3,
          sortLast: 'family 00',
          sortFirst: 'person 00',
          individualId: people[0],
        },
      },
      completedWeekEnd: overview.window.completedWeekEnd,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await assert.rejects(
      listContextualPeople(churchId, {
        segment: overview.declines.peopleToken,
        cursor: wrongSelectionCursor,
      }),
      DrilldownTokenError,
    );

    const mismatchedSelector = createDrilldownToken({
      churchId,
      kind: 'people',
      gatheringTypeIds: [gatheringTypeId],
      selector: { type: 'tier', tier: 'core', gatheringTypeIds: [otherGatheringId] },
      completedWeekEnd: overview.window.completedWeekEnd,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await assert.rejects(
      listContextualPeople(churchId, { segment: mismatchedSelector }),
      DrilldownTokenError,
    );
  });
});

test('includes a decline at the exact twenty-percentage-point boundary', async () => {
  await withTestChurchDb(async (churchId) => {
    const userId = await seedUser(churchId);
    const gatheringTypeId = await seedGathering(churchId, { name: 'Exact decline boundary' });
    const individualId = await seedPerson(churchId, {
      firstName: 'Exact', lastName: 'Boundary',
    });
    const serviceMarkerId = await seedPerson(churchId, {
      firstName: 'Session', lastName: 'Marker', peopleType: 'local_visitor',
    });
    await assign(churchId, gatheringTypeId, individualId);

    const dates = sundayWeeksEnding('2026-08-30', 18);
    for (let week = 0; week < dates.length; week += 1) {
      const records = [];
      if (week < 15) {
        records.push({
          individualId,
          present: week < 6 || (week >= 10 && week < 12) ? 1 : 0,
        });
      }
      records.push({
        individualId: serviceMarkerId,
        present: 1,
        peopleTypeAtTime: 'local_visitor',
      });
      await seedSession(churchId, userId, gatheringTypeId, dates[week], { records });
    }

    const overview = await buildContextualLongTermOverview(churchId, [gatheringTypeId], {
      asOf: AS_OF,
    });
    assert.equal(overview.declines.total, 1);
    assert.deepEqual(overview.declines.rows[0].baseline, {
      attendedWeeks: 6,
      opportunityWeeks: 10,
      rate: 60,
    });
    assert.deepEqual(overview.declines.rows[0].recent, {
      attendedWeeks: 2,
      opportunityWeeks: 5,
      rate: 40,
    });
  });
});

test('orders equal displayed decline percentages by their unrounded severity before names', async () => {
  await withTestChurchDb(async (churchId) => {
    const userId = await seedUser(churchId);
    const gatheringTypeId = await seedGathering(churchId, { name: 'Severity' });
    const strongerId = await seedPerson(churchId, {
      firstName: 'Stronger', lastName: 'Zulu',
    });
    const weakerId = await seedPerson(churchId, {
      firstName: 'Weaker', lastName: 'Able',
    });
    const serviceMarkerId = await seedPerson(churchId, {
      firstName: 'Session', lastName: 'Marker', peopleType: 'local_visitor',
    });
    await assign(churchId, gatheringTypeId, strongerId);
    await assign(churchId, gatheringTypeId, weakerId);

    const dates = sundayWeeksEnding('2026-08-30', 45);
    for (let week = 0; week < dates.length; week += 1) {
      const records = [];
      if (week < 8 || (week >= 37 && week < 41)) {
        records.push({ individualId: strongerId, present: week < 3 ? 1 : 0 });
      }
      if (week < 37 || (week >= 37 && week < 44)) {
        records.push({
          individualId: weakerId,
          present: week < 35 || (week >= 37 && week < 41) ? 1 : 0,
        });
      }
      records.push({
        individualId: serviceMarkerId,
        present: 1,
        peopleTypeAtTime: 'local_visitor',
      });
      await seedSession(churchId, userId, gatheringTypeId, dates[week], { records });
    }

    const overview = await buildContextualLongTermOverview(churchId, [gatheringTypeId], {
      asOf: AS_OF,
    });
    assert.equal(overview.declines.rows[0].baseline.rate, 37.5);
    assert.equal(overview.declines.rows[1].baseline.rate, 94.6);
    assert.deepEqual(
      overview.declines.rows.map(({ individualId }) => individualId),
      [strongerId, weakerId],
    );
  });
});

test('finds conservative increases and binds their paginated tokens to church and direction', async () => {
  await withTestChurchDb(async (churchId) => {
    const userId = await seedUser(churchId);
    const gatheringTypeId = await seedGathering(churchId, { name: 'Increasing attendance' });
    const people = [];
    for (let index = 0; index < 11; index += 1) {
      const individualId = await seedPerson(churchId, { firstName: `Person ${String(index).padStart(2, '0')}` });
      people.push(individualId);
      await assign(churchId, gatheringTypeId, individualId);
    }
    const marker = await seedPerson(churchId, { firstName: 'Marker', peopleType: 'local_visitor' });
    const dates = sundayWeeksEnding('2026-08-30', 16);
    for (let week = 0; week < dates.length; week += 1) {
      await seedSession(churchId, userId, gatheringTypeId, dates[week], {
        records: [
          ...people.map((individualId) => ({ individualId, present: week < 2 || week >= 8 ? 1 : 0 })),
          { individualId: marker, present: 1, peopleTypeAtTime: 'local_visitor' },
        ],
      });
    }
    const overview = await buildContextualLongTermOverview(churchId, [gatheringTypeId], { asOf: AS_OF });
    assert.equal(overview.increases.total, 11);
    assert.equal(overview.increases.rows.length, 10);
    assert.equal(overview.declines.total, 0);
    assert.deepEqual(overview.increases.rows[0].baseline, { attendedWeeks: 2, opportunityWeeks: 8, rate: 25 });
    assert.deepEqual(overview.increases.rows[0].recent, { attendedWeeks: 8, opportunityWeeks: 8, rate: 100 });
    assert.equal(overview.increases.rows[0].summary, 'Previously attended 2 of 8 weeks; attended 8 of the last 8 weeks.');
    const first = await listContextualPeople(churchId, { segment: overview.increases.peopleToken, limit: 5 });
    assert.equal(first.rows[0].rowType, 'contextual_increase');
    assert.ok(first.nextCursor);
    const second = await listContextualPeople(churchId, {
      segment: overview.increases.peopleToken, cursor: first.nextCursor, limit: 100,
    });
    assert.deepEqual([...first.rows, ...second.rows].map(({ individualId }) => individualId), people);
    assert.equal(second.nextCursor, null);
    await assert.rejects(listContextualPeople(`${churchId}_other`, {
      segment: overview.increases.peopleToken,
    }), DrilldownTokenError);
    await assert.rejects(listContextualPeople(churchId, {
      segment: overview.declines.peopleToken, cursor: first.nextCursor,
    }), DrilldownTokenError);
  });
});

test('includes exact twenty-point increases but excludes small changes and insufficient evidence', async () => {
  await withTestChurchDb(async (churchId) => {
    const userId = await seedUser(churchId);
    const gatheringTypeId = await seedGathering(churchId, { name: 'Increase boundary' });
    const cases = [
      { firstName: 'Exact', baseline: 4, recent: 3, baselineWeeks: 10, recentWeeks: 5 },
      { firstName: 'Small', baseline: 5, recent: 3, baselineWeeks: 10, recentWeeks: 5 },
      { firstName: 'Short baseline', baseline: 1, recent: 5, baselineWeeks: 7, recentWeeks: 5 },
      { firstName: 'Short recent', baseline: 1, recent: 3, baselineWeeks: 10, recentWeeks: 3 },
      { firstName: 'Same tier', baseline: 7, recent: 5, baselineWeeks: 10, recentWeeks: 5 },
    ];
    for (const person of cases) {
      person.individualId = await seedPerson(churchId, person);
      await assign(churchId, gatheringTypeId, person.individualId);
    }
    const marker = await seedPerson(churchId, { firstName: 'Marker', peopleType: 'local_visitor' });
    const dates = sundayWeeksEnding('2026-08-30', 18);
    for (let week = 0; week < dates.length; week += 1) {
      const records = cases.filter((person) => week < 10
        ? week < person.baselineWeeks : week - 10 < person.recentWeeks)
        .map((person) => ({
          individualId: person.individualId,
          present: (week < 10 ? week < person.baseline : week - 10 < person.recent) ? 1 : 0,
        }));
      records.push({ individualId: marker, present: 1, peopleTypeAtTime: 'local_visitor' });
      await seedSession(churchId, userId, gatheringTypeId, dates[week], { records });
    }
    const overview = await buildContextualLongTermOverview(churchId, [gatheringTypeId], { asOf: AS_OF });
    assert.deepEqual(overview.increases.rows.map(({ individualId }) => individualId), [cases[0].individualId]);
    assert.deepEqual(overview.increases.rows[0].baseline, { attendedWeeks: 4, opportunityWeeks: 10, rate: 40 });
    assert.deepEqual(overview.increases.rows[0].recent, { attendedWeeks: 3, opportunityWeeks: 5, rate: 60 });
  });
});


test('compares each gathering independently, including missing previous history', async () => {
  await withTestChurchDb(async (churchId) => {
    const userId = await seedUser(churchId);
    const ids = [];
    for (const [name, counts] of [['Large', [100, 120]], ['Small', [20, 10]], ['New', [null, 30]]]) {
      const id = await seedGathering(churchId, { name, attendanceType: 'headcount' });
      ids.push(id);
      if (counts[0] !== null) await seedSession(churchId, userId, id, '2026-04-05', { headcounts: [counts[0]] });
      await seedSession(churchId, userId, id, '2026-08-30', { headcounts: [counts[1]] });
    }
    const result = await buildContextualLongTermOverview(churchId, ids, { asOf: AS_OF });
    assert.deepEqual(result.direction.series.map(({ comparison }) => comparison), [
      { comparisonWeeks: 12, previousAverage: 100, recentAverage: 120, percentChange: 20, status: 'up' },
      { comparisonWeeks: 12, previousAverage: 20, recentAverage: 10, percentChange: -50, status: 'down' },
      { comparisonWeeks: 12, previousAverage: null, recentAverage: 30, percentChange: null, status: 'unavailable' },
    ]);
  });
});
