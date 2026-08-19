'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../../config/logger');
logger.exceptions?.unhandle();
logger.rejections?.unhandle();

process.env.JWT_SECRET = 'engagement-overview-test-secret';

const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { readDrilldownToken } = require('./drilldownTokens');
const {
  summarizeEngagementProfiles,
  buildEngagementOverview,
  listEngagementPeople,
  listEngagementSessions,
} = require('./overview');

const WINDOW = {
  completedWeekEnd: '2026-08-16',
  currentStart: '2025-08-18',
  currentEnd: '2026-08-16',
  comparisonStart: '2025-07-21',
  comparisonEnd: '2026-07-19',
};
const SETTINGS = {
  coreMinimum: 60,
  casualMinimum: 20,
  calculationRulesVersion: 4,
  tiers: {
    core: { label: 'Committed', colour: '#008000' },
    casual: { label: 'Connected', colour: '#D97706' },
    irregular: { label: 'Occasional', colour: '#DC2626' },
  },
};

function axis(status, attended = 0, opportunities = 0) {
  return {
    status,
    attended,
    opportunities,
    rate: opportunities === 0 ? null : attended / opportunities,
  };
}

function profile(individualId, primary, community) {
  return {
    individualId,
    firstName: `Person ${individualId}`,
    lastName: 'Example',
    familyId: null,
    primary,
    community,
  };
}

test('summarizes classified-only distribution, four-way movement, and the established 3x3 matrix', () => {
  const current = new Map([
    [1, profile(1, axis('core', 8, 10), axis('core', 8, 8))],
    [2, profile(2, axis('casual', 4, 10), axis('irregular', 1, 8))],
    [3, profile(3, axis('irregular', 1, 10), axis('casual', 4, 8))],
    [4, profile(4, axis('establishing', 3, 6), axis('core', 8, 8))],
    [5, profile(5, axis('not_assigned'), axis('not_assigned'))],
  ]);
  const comparison = new Map([
    [1, profile(1, axis('casual', 4, 10), axis('core', 8, 8))],
    [2, profile(2, axis('core', 8, 10), axis('irregular', 1, 8))],
    [3, profile(3, axis('irregular', 1, 10), axis('casual', 4, 8))],
    [4, profile(4, axis('establishing', 2, 5), axis('core', 8, 8))],
    [5, profile(5, axis('core', 8, 10), axis('not_assigned'))],
  ]);

  const summary = summarizeEngagementProfiles({
    churchId: 'church_summary',
    current,
    comparison,
    coverage: {
      eligibleHeldSessions: 3,
      explicitProvenanceSessions: 2,
      legacyProvenanceSessions: 1,
      excludedUnknownProvenanceSessions: 1,
    },
    window: WINDOW,
    settings: SETTINGS,
    expiresAt: '2026-08-17T02:00:00.000Z',
  });

  assert.equal(summary.population.activeRegulars, 5);
  assert.equal(summary.primaryDistribution.classified.denominator, 3);
  assert.deepEqual(
    summary.primaryDistribution.classified.tiers.map(({ tier, label, colour, count, rate }) => ({
      tier, label, colour, count, rate,
    })),
    [
      { tier: 'core', label: 'Committed', colour: '#008000', count: 1, rate: 1 / 3 },
      { tier: 'casual', label: 'Connected', colour: '#D97706', count: 1, rate: 1 / 3 },
      { tier: 'irregular', label: 'Occasional', colour: '#DC2626', count: 1, rate: 1 / 3 },
    ],
  );
  assert.equal(summary.primaryDistribution.establishing.count, 1);
  assert.equal(summary.primaryDistribution.notAssigned.count, 1);
  assert.deepEqual(
    Object.fromEntries(Object.entries(summary.movement.categories).map(([key, value]) => [key, value.count])),
    { higher: 1, same: 1, lower: 1, nonComparable: 2 },
  );
  assert.equal(summary.matrix.classifiedOnBothAxes, 3);
  assert.equal(summary.matrix.cells.length, 9);
  assert.equal(summary.matrix.cells.find((cell) => cell.primaryTier === 'core'
    && cell.communityTier === 'core').count, 1);
  assert.equal(summary.matrix.cells.find((cell) => cell.primaryTier === 'casual'
    && cell.communityTier === 'irregular').count, 1);
  assert.equal(summary.matrix.cells.find((cell) => cell.primaryTier === 'irregular'
    && cell.communityTier === 'casual').count, 1);
  assert.deepEqual(summary.matrix.outside, {
    primaryEstablishing: 1,
    primaryNotAssigned: 1,
    communityEstablishing: 0,
    communityNotAssigned: 1,
    notClassifiedOnBothAxes: 2,
  });
  assert.deepEqual(summary.coverage.personLevelSessions, {
    numerator: 3, denominator: 4, rate: 0.75, excluded: 1,
  });
  assert.deepEqual(summary.coverage.legacyProvenance, {
    numerator: 1, denominator: 3, rate: 1 / 3,
  });
  assert.deepEqual(summary.coverage.establishing, {
    numerator: 1, denominator: 5, rate: 0.2,
  });
  assert.deepEqual(summary.coverage.primaryNotAssigned, {
    numerator: 1, denominator: 5, rate: 0.2,
  });

  const coreToken = summary.primaryDistribution.classified.tiers[0].peopleToken;
  assert.equal(coreToken.includes('church_summary'), false);
  assert.deepEqual(readDrilldownToken(coreToken, {
    churchId: 'church_summary',
    kind: 'people',
    now: '2026-08-17T01:00:00.000Z',
  }).selector, { type: 'primary_status', status: 'core' });
});

async function insertPerson(churchId, firstName, lastName, peopleType = 'regular') {
  const result = await Database.query(
    `INSERT INTO individuals (first_name, last_name, people_type, is_active, church_id)
     VALUES (?, ?, ?, 1, ?)`,
    [firstName, lastName, peopleType, churchId],
  );
  return result.insertId;
}

async function insertSession(churchId, userId, gatheringId, date, overrides = {}) {
  const result = await Database.query(
    `INSERT INTO attendance_sessions
       (gathering_type_id, session_date, created_by, headcount_mode,
        roster_snapshotted, excluded_from_stats, session_status,
        roster_provenance_version, church_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      gatheringId,
      date,
      userId,
      overrides.headcountMode || 'separate',
      overrides.rosterSnapshotted ?? 1,
      overrides.excludedFromStats ?? 0,
      overrides.sessionStatus || 'held',
      overrides.rosterProvenanceVersion ?? 1,
      churchId,
    ],
  );
  return result.insertId;
}

async function insertAttendance(churchId, sessionId, individualId, present, peopleType, eligible = 1) {
  await Database.query(
    `INSERT INTO attendance_records
       (session_id, individual_id, present, eligible_at_snapshot, people_type_at_time, church_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sessionId, individualId, present, eligible, peopleType, churchId],
  );
}

async function seedOverviewFixture(churchId) {
  await Database.query(
    `UPDATE church_settings SET timezone = 'Australia/Hobart' WHERE church_id = ?`,
    [churchId],
  );
  const user = await Database.query(
    `INSERT INTO users (church_id, email, role, first_name, last_name)
     VALUES (?, ?, 'admin', 'Test', 'Admin')`,
    [churchId, `${churchId}@example.com`],
  );
  const primary = await Database.query(
    `INSERT INTO gathering_types
       (name, attendance_type, engagement_role, is_active, church_id)
     VALUES ('Sunday', 'standard', 'primary', 1, ?)`,
    [churchId],
  );
  const headcount = await Database.query(
    `INSERT INTO gathering_types
       (name, attendance_type, engagement_role, is_active, church_id)
     VALUES ('All-age event', 'headcount', 'primary', 1, ?)`,
    [churchId],
  );

  const regulars = [];
  for (const [firstName, lastName] of [
    ['Amy', 'Able'], ['Ben', 'Baker'], ['Cara', 'Clark'],
  ]) {
    const id = await insertPerson(churchId, firstName, lastName);
    regulars.push(id);
    await Database.query(
      `INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id)
       VALUES (?, ?, ?)`,
      [primary.insertId, id, churchId],
    );
  }
  const localReturn = await insertPerson(churchId, 'Local', 'Return', 'local_visitor');
  const converted = await insertPerson(churchId, 'Now', 'Regular', 'regular');
  const traveller = await insertPerson(churchId, 'Travel', 'Guest', 'traveller_visitor');

  const dates = [
    '2026-06-21', '2026-06-28', '2026-07-05', '2026-07-12',
    '2026-07-19', '2026-07-26', '2026-08-02', '2026-08-09',
  ];
  const standardSessions = [];
  for (let index = 0; index < dates.length; index += 1) {
    const sessionId = await insertSession(
      churchId, user.insertId, primary.insertId, dates[index],
    );
    standardSessions.push(sessionId);
    for (let personIndex = 0; personIndex < regulars.length; personIndex += 1) {
      await insertAttendance(
        churchId,
        sessionId,
        regulars[personIndex],
        1,
        'regular',
      );
    }
  }

  await insertAttendance(churchId, standardSessions[2], localReturn, 1, 'local_visitor', 0);
  await insertAttendance(churchId, standardSessions[5], localReturn, 1, 'local_visitor', 0);
  await insertAttendance(churchId, standardSessions[3], converted, 1, 'local_visitor', 0);
  await insertAttendance(churchId, standardSessions[4], traveller, 1, 'traveller_visitor', 0);

  const legacySession = await insertSession(
    churchId,
    user.insertId,
    primary.insertId,
    '2026-06-14',
    { rosterProvenanceVersion: 0, rosterSnapshotted: 1 },
  );
  for (const id of regulars) {
    await insertAttendance(churchId, legacySession, id, 1, null, 0);
  }
  const unknownSession = await insertSession(
    churchId,
    user.insertId,
    primary.insertId,
    '2026-06-07',
    { rosterProvenanceVersion: 0, rosterSnapshotted: 0 },
  );
  await insertAttendance(churchId, unknownSession, regulars[0], 1, 'regular', 0);

  const headcountSession = await insertSession(
    churchId,
    user.insertId,
    headcount.insertId,
    '2026-08-08',
    { headcountMode: 'averaged', rosterSnapshotted: 0, rosterProvenanceVersion: 0 },
  );
  for (const count of [20, 21]) {
    const counter = await Database.query(
      `INSERT INTO users (church_id, email, role, first_name, last_name)
       VALUES (?, ?, 'coordinator', 'Count', 'User')`,
      [churchId, `${churchId}-${count}@example.com`],
    );
    await Database.query(
      `INSERT INTO headcount_records (session_id, headcount, updated_by, church_id)
       VALUES (?, ?, ?, ?)`,
      [headcountSession, count, counter.insertId, churchId],
    );
  }

  return { regulars, localReturn, converted, headcountSession };
}

async function seedRepresentativeOverviewFixture(churchId) {
  await Database.query(
    `UPDATE church_settings SET timezone = 'Australia/Hobart' WHERE church_id = ?`,
    [churchId],
  );
  const user = await Database.query(
    `INSERT INTO users (church_id, email, role, first_name, last_name)
     VALUES (?, ?, 'admin', 'Bulk', 'Admin')`,
    [churchId, `${churchId}-bulk@example.com`],
  );
  const primary = await Database.query(
    `INSERT INTO gathering_types
       (name, attendance_type, engagement_role, is_active, church_id)
     VALUES ('Sunday', 'standard', 'primary', 1, ?)`,
    [churchId],
  );

  const db = Database.getChurchDb(churchId);
  db.transaction(() => {
    const insertPersonRow = db.prepare(
      `INSERT INTO individuals
         (first_name, last_name, people_type, is_active, church_id)
       VALUES (?, 'Bulk', 'regular', 1, ?)`,
    );
    const insertAssignment = db.prepare(
      `INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id)
       VALUES (?, ?, ?)`,
    );
    const personIds = [];
    for (let sequence = 1; sequence <= 1000; sequence += 1) {
      const person = insertPersonRow.run(`Person ${String(sequence).padStart(4, '0')}`, churchId);
      personIds.push(Number(person.lastInsertRowid));
      insertAssignment.run(primary.insertId, person.lastInsertRowid, churchId);
    }

    const insertSessionRow = db.prepare(
      `INSERT INTO attendance_sessions
         (gathering_type_id, session_date, created_by, roster_snapshotted,
          excluded_from_stats, session_status, roster_provenance_version, church_id)
       VALUES (?, date('2025-07-21', '+' || ? || ' days'), ?, 1, 0, 'held', 1, ?)`,
    );
    const insertAttendanceRow = db.prepare(
      `INSERT INTO attendance_records
         (session_id, individual_id, present, eligible_at_snapshot,
          people_type_at_time, church_id)
       VALUES (?, ?, ?, 1, 'regular', ?)`,
    );
    for (let week = 0; week < 56; week += 1) {
      const session = insertSessionRow.run(
        primary.insertId, week * 7, user.insertId, churchId,
      );
      for (const individualId of personIds) {
        insertAttendanceRow.run(
          session.lastInsertRowid,
          individualId,
          individualId % 4 === 0 ? 0 : 1,
          churchId,
        );
      }
    }
  })();
}

async function measureOverviewQueries(churchId) {
  const originalQuery = Database.query;
  const originalQueryForChurch = Database.queryForChurch;
  let queryCount = 0;
  Database.query = async (...args) => {
    queryCount += 1;
    return originalQuery.call(Database, ...args);
  };
  Database.queryForChurch = async (...args) => {
    queryCount += 1;
    return originalQueryForChurch.call(Database, ...args);
  };
  try {
    const overview = await buildEngagementOverview(churchId, {
      asOf: '2026-08-16T14:00:00.000Z',
    });
    return { overview, queryCount };
  } finally {
    Database.query = originalQuery;
    Database.queryForChurch = originalQueryForChurch;
  }
}

test('builds 13 fixed buckets, standard reach, headcount averages, visitors, coverage, and stable drilldowns', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedOverviewFixture(churchId);
    const overview = await buildEngagementOverview(churchId, {
      asOf: '2026-08-16T14:00:00.000Z',
    });

    assert.equal(overview.window.currentStart, '2025-08-18');
    assert.equal(overview.window.currentEnd, '2026-08-16');
    assert.equal(overview.trend.buckets.length, 13);
    assert.equal(overview.trend.buckets[0].startDate, '2025-08-18');
    assert.equal(overview.trend.buckets[12].endDate, '2026-08-16');

    const lastBucket = overview.trend.buckets[12];
    const standard = lastBucket.series.find((item) => item.role === 'primary'
      && item.attendanceType === 'standard');
    const headcount = lastBucket.series.find((item) => item.role === 'primary'
      && item.attendanceType === 'headcount');
    assert.equal(standard.heldSessions, 3);
    assert.equal(standard.uniquePeople, 4);
    assert.equal(headcount.heldSessions, 1);
    assert.equal(headcount.totalAttendance, 21);
    assert.equal(headcount.averageAttendance, 21);
    assert.equal(headcount.uniquePeople, null);
    assert.equal(headcount.peopleToken, null);

    assert.deepEqual(
      {
        first: overview.visitorJourney.local.firstTime.count,
        returned: overview.visitorJourney.local.returnedWithinEightWeeks.count,
        regular: overview.visitorJourney.local.currentRegular.count,
        traveller: overview.visitorJourney.traveller.firstTime.count,
      },
      { first: 2, returned: 1, regular: 1, traveller: 1 },
    );
    assert.deepEqual(overview.coverage.personLevelSessions, {
      numerator: 9,
      denominator: 10,
      rate: 0.9,
      excluded: 1,
    });
    assert.deepEqual(overview.coverage.legacyProvenance, {
      numerator: 1,
      denominator: 9,
      rate: 1 / 9,
    });

    const coreSegment = overview.primaryDistribution.classified.tiers
      .find((tier) => tier.tier === 'core').peopleToken;
    const firstPage = await listEngagementPeople(churchId, {
      segment: coreSegment,
      limit: 2,
    });
    assert.equal(firstPage.rows.length, 2);
    assert.equal(firstPage.rows.every((row) => row.rowType === 'engagement_profile'
      && row.primary.status === 'core'), true);
    assert.ok(firstPage.nextCursor);
    const secondPage = await listEngagementPeople(churchId, {
      segment: coreSegment,
      cursor: firstPage.nextCursor,
      limit: 2,
    });
    assert.deepEqual(
      [...firstPage.rows, ...secondPage.rows].map((row) => row.individualId),
      fixture.regulars,
    );

    const sessionPage = await listEngagementSessions(churchId, {
      series: headcount.sessionsToken,
      limit: 1,
    });
    assert.deepEqual(sessionPage.rows.map((row) => row.sessionId), [fixture.headcountSession]);
    assert.equal(sessionPage.rows[0].attendance, 21);
  });
});

test('keeps overview queries constant for 1,000 regulars across 56 weeks', async (t) => {
  await withTestChurchDb(async (churchId) => {
    const baseline = await measureOverviewQueries(churchId);
    await seedRepresentativeOverviewFixture(churchId);
    const representative = await measureOverviewQueries(churchId);

    assert.equal(representative.overview.population.activeRegulars, 1000);
    assert.equal(representative.overview.coverage.personLevelSessions.denominator, 52);
    assert.equal(representative.queryCount, baseline.queryCount);
    assert.ok(
      representative.queryCount <= 12,
      `expected bounded overview queries, received ${representative.queryCount}`,
    );
    t.diagnostic(
      `measured ${representative.queryCount} overview queries for 1,000 regulars and 56 weekly sessions`,
    );
  });
});
