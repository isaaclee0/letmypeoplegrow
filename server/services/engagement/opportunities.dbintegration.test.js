'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../../config/logger');
logger.exceptions?.unhandle();
logger.rejections?.unhandle();

const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const {
  getEngagementWindow,
  loadOpportunitySource,
  buildOpportunityProfiles,
  calculateEngagementProfiles,
} = require('./opportunities');

const DEFAULT_SETTINGS = { coreMinimum: 60, casualMinimum: 20 };

function person(id, overrides = {}) {
  return {
    id,
    firstName: `Person ${id}`,
    lastName: 'Example',
    familyId: null,
    peopleType: 'regular',
    isActive: 1,
    ...overrides,
  };
}

function session(id, date, role, overrides = {}) {
  return {
    id,
    gatheringTypeId: overrides.gatheringTypeId ?? id,
    sessionDate: date,
    sessionStatus: 'held',
    excludedFromStats: 0,
    rosterSnapshotted: 1,
    rosterProvenanceVersion: 1,
    attendanceType: 'standard',
    engagementRole: role,
    ...overrides,
  };
}

function record(sessionId, individualId, overrides = {}) {
  return {
    sessionId,
    individualId,
    present: 0,
    eligibleAtSnapshot: 1,
    peopleTypeAtTime: 'regular',
    ...overrides,
  };
}

test('uses the latest fully completed church week and exact inclusive 56-week windows', () => {
  assert.deepEqual(
    getEngagementWindow('2026-08-16T14:00:00.000Z', 'Australia/Hobart'),
    {
      completedWeekEnd: '2026-08-16',
      sourceStart: '2025-07-21',
      sourceEnd: '2026-08-16',
      currentStart: '2025-08-18',
      currentEnd: '2026-08-16',
      comparisonStart: '2025-07-21',
      comparisonEnd: '2026-07-19',
    },
  );

  // At 23:55 on the DST-transition Sunday, that Sunday is still partial.
  assert.deepEqual(
    getEngagementWindow('2026-10-04T12:55:00.000Z', 'Australia/Hobart'),
    {
      completedWeekEnd: '2026-09-27',
      sourceStart: '2025-09-01',
      sourceEnd: '2026-09-27',
      currentStart: '2025-09-29',
      currentEnd: '2026-09-27',
      comparisonStart: '2025-09-01',
      comparisonEnd: '2026-08-30',
    },
  );

  // Ten minutes later it is church-local Monday, so the DST Sunday is complete.
  assert.deepEqual(
    getEngagementWindow('2026-10-04T13:05:00.000Z', 'Australia/Hobart'),
    {
      completedWeekEnd: '2026-10-04',
      sourceStart: '2025-09-08',
      sourceEnd: '2026-10-04',
      currentStart: '2025-10-06',
      currentEnd: '2026-10-04',
      comparisonStart: '2025-09-08',
      comparisonEnd: '2026-09-06',
    },
  );
});

test('reduces reliable opportunities with axis-specific denominators, provenance, gates, and exact tiers', () => {
  const window = getEngagementWindow('2026-08-16T14:00:00.000Z', 'Australia/Hobart');
  const people = [
    person(1), // exact 60% Primary; alternative attendance fulfils week one
    person(2), // exact 20% Primary
    person(3), // below 20% Primary
    person(4), // seven reliable opportunities: Establishing
    person(5), // historical evidence but no current Primary assignment
    person(6, { isActive: 0 }),
    person(7, { peopleType: 'local_visitor' }),
    person(8), // two Community commitments remain distinct
    person(9), // legacy provenance, including null people type fallback
  ];
  const assignments = [];
  for (const individualId of [1, 2, 3, 4, 6, 7, 9]) {
    assignments.push({ individualId, gatheringTypeId: 10, role: 'primary' });
  }
  assignments.push(
    { individualId: 8, gatheringTypeId: 20, role: 'community' },
    { individualId: 8, gatheringTypeId: 21, role: 'community' },
  );

  const dates = [
    '2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06',
    '2026-07-13', '2026-07-20', '2026-07-27', '2026-08-03', '2026-08-10',
  ];
  const sessions = dates.map((date, index) => session(100 + index, date, 'primary', {
    gatheringTypeId: 10,
  }));
  sessions.push(session(200, dates[0], 'primary', { gatheringTypeId: 11 }));

  const records = [];
  dates.forEach((date, index) => {
    void date;
    const sessionId = 100 + index;
    records.push(
      record(sessionId, 1, { present: index >= 5 ? 1 : 0 }),
      record(sessionId, 2, { present: index < 2 ? 1 : 0 }),
      record(sessionId, 3, { present: index === 0 ? 1 : 0 }),
      record(sessionId, 5, { present: 1 }),
      record(sessionId, 6, { present: 1 }),
      record(sessionId, 7, { present: 1 }),
    );
    if (index < 7) records.push(record(sessionId, 4, { present: index < 4 ? 1 : 0 }));
  });
  // Week one has two eligible alternatives but still one denominator. Presence
  // at the second, ad-hoc alternative fulfils the already-existing denominator.
  records.push(
    record(200, 1, { present: 1, eligibleAtSnapshot: 0 }),
    record(200, 2),
  );

  // Four weeks x two Community commitments = eight distinct opportunities.
  for (let index = 0; index < 4; index += 1) {
    const date = dates[index];
    const first = 300 + index * 2;
    const second = first + 1;
    sessions.push(
      session(first, date, 'community', { gatheringTypeId: 20 }),
      session(second, date, 'community', { gatheringTypeId: 21 }),
    );
    records.push(record(first, 8, { present: 1 }), record(second, 8));
  }

  sessions.push(
    session(400, '2026-08-10', 'primary', {
      gatheringTypeId: 10,
      rosterProvenanceVersion: 0,
      rosterSnapshotted: 1,
    }),
    session(401, '2026-08-03', 'primary', {
      gatheringTypeId: 10,
      rosterProvenanceVersion: 0,
      rosterSnapshotted: 0,
    }),
    session(402, '2026-07-27', 'primary', { gatheringTypeId: 10, sessionStatus: 'open' }),
    session(403, '2026-07-20', 'primary', { gatheringTypeId: 10, sessionStatus: 'cancelled' }),
    session(404, '2026-07-13', 'primary', { gatheringTypeId: 10, excludedFromStats: 1 }),
    session(405, '2026-08-17', 'primary', { gatheringTypeId: 10 }),
    session(406, '2026-07-06', 'primary', { gatheringTypeId: 10, attendanceType: 'headcount' }),
    session(407, '2026-06-29', 'primary', { gatheringTypeId: 10 }),
    session(408, '2026-06-22', 'primary', { gatheringTypeId: 10 }),
  );
  records.push(
    record(400, 9, { present: 1, eligibleAtSnapshot: 0, peopleTypeAtTime: null }),
    record(401, 9, { present: 1, peopleTypeAtTime: null }),
    record(402, 9, { present: 1 }),
    record(403, 9, { present: 1 }),
    record(404, 9, { present: 1 }),
    record(405, 9, { present: 1 }),
    record(406, 9, { present: 1 }),
    record(407, 9, { present: 1, peopleTypeAtTime: 'local_visitor' }),
    record(408, 9, { present: 1, peopleTypeAtTime: null }),
  );

  const source = { people, assignments, sessions, records, headcounts: [{ sessionId: 406, headcount: 20 }] };
  const result = buildOpportunityProfiles(source, DEFAULT_SETTINGS, window);

  assert.deepEqual(result.current.get(1).primary, {
    status: 'core', attended: 6, opportunities: 10, rate: 0.6,
  });
  assert.deepEqual(result.current.get(2).primary, {
    status: 'casual', attended: 2, opportunities: 10, rate: 0.2,
  });
  assert.deepEqual(result.current.get(3).primary, {
    status: 'irregular', attended: 1, opportunities: 10, rate: 0.1,
  });
  assert.deepEqual(result.current.get(4).primary, {
    status: 'establishing', attended: 4, opportunities: 7, rate: 4 / 7,
  });
  assert.deepEqual(result.current.get(5).primary, {
    status: 'not_assigned', attended: 0, opportunities: 0, rate: null,
  });
  assert.equal(result.current.has(6), false);
  assert.equal(result.current.has(7), false);
  assert.deepEqual(result.current.get(8).community, {
    status: 'casual', attended: 4, opportunities: 8, rate: 0.5,
  });
  assert.deepEqual(result.current.get(9).primary, {
    status: 'establishing', attended: 2, opportunities: 2, rate: 1,
  });
  assert.deepEqual(result.current.get(1).community, {
    status: 'not_assigned', attended: 0, opportunities: 0, rate: null,
  });
  assert.deepEqual(
    result.datedOpportunities.primary.filter((opportunity) => opportunity.individualId === 1),
    [
      { individualId: 1, date: '2026-06-08', attended: true },
      { individualId: 1, date: '2026-06-15', attended: false },
      { individualId: 1, date: '2026-06-22', attended: false },
      { individualId: 1, date: '2026-06-29', attended: false },
      { individualId: 1, date: '2026-07-06', attended: false },
      { individualId: 1, date: '2026-07-13', attended: true },
      { individualId: 1, date: '2026-07-20', attended: true },
      { individualId: 1, date: '2026-07-27', attended: true },
      { individualId: 1, date: '2026-08-03', attended: true },
      { individualId: 1, date: '2026-08-10', attended: true },
    ],
    'alternative Primary services produce one fact for a person and week',
  );
  assert.deepEqual(
    result.datedOpportunities.community.filter((opportunity) => opportunity.individualId === 8),
    [
      { individualId: 8, date: '2026-06-08', attended: true },
      { individualId: 8, date: '2026-06-08', attended: false },
      { individualId: 8, date: '2026-06-15', attended: true },
      { individualId: 8, date: '2026-06-15', attended: false },
      { individualId: 8, date: '2026-06-22', attended: true },
      { individualId: 8, date: '2026-06-22', attended: false },
      { individualId: 8, date: '2026-06-29', attended: true },
      { individualId: 8, date: '2026-06-29', attended: false },
    ],
    'Other participation commitments remain distinct dated facts',
  );
  assert.deepEqual(
    result.datedOpportunities.primary.filter((opportunity) => opportunity.individualId === 9),
    [
      { individualId: 9, date: '2026-08-10', attended: true },
      { individualId: 9, date: '2026-07-27', attended: true },
    ],
    'cancelled, excluded, headcount, and unknown-provenance sessions produce no facts',
  );
  assert.deepEqual(result.coverage, {
    eligibleHeldSessions: 23,
    explicitProvenanceSessions: 22,
    legacyProvenanceSessions: 1,
    excludedUnknownProvenanceSessions: 1,
    legacyProvenanceShare: 1 / 23,
  });

  const custom = buildOpportunityProfiles(source, {
    coreMinimum: 70,
    casualMinimum: 30,
  }, window);
  assert.equal(custom.current.get(1).primary.status, 'casual');
  assert.equal(custom.current.get(2).primary.status, 'irregular');
});

async function seedBulkFixture(churchId) {
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
       (name, attendance_type, is_active, engagement_role, church_id)
     VALUES ('Primary', 'standard', 1, 'primary', ?)`,
    [churchId],
  );
  const headcount = await Database.query(
    `INSERT INTO gathering_types
       (name, attendance_type, is_active, engagement_role, church_id)
     VALUES ('Headcount', 'headcount', 1, 'primary', ?)`,
    [churchId],
  );
  const people = [];
  for (let index = 0; index < 12; index += 1) {
    const inserted = await Database.query(
      `INSERT INTO individuals (first_name, last_name, people_type, is_active, church_id)
       VALUES (?, 'Bulk', 'regular', 1, ?)`,
      [`Person ${index}`, churchId],
    );
    people.push(inserted.insertId);
    await Database.query(
      `INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id)
       VALUES (?, ?, ?)`,
      [primary.insertId, inserted.insertId, churchId],
    );
  }
  const dates = [
    '2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06',
    '2026-07-13', '2026-07-20', '2026-07-27', '2026-08-03',
  ];
  for (const sessionDate of dates) {
    const inserted = await Database.query(
      `INSERT INTO attendance_sessions
         (gathering_type_id, session_date, created_by, roster_snapshotted,
          session_status, roster_provenance_version, church_id)
       VALUES (?, ?, ?, 1, 'held', 1, ?)`,
      [primary.insertId, sessionDate, user.insertId, churchId],
    );
    for (const individualId of people) {
      await Database.query(
        `INSERT INTO attendance_records
           (session_id, individual_id, present, eligible_at_snapshot,
            people_type_at_time, church_id)
         VALUES (?, ?, 1, 1, 'regular', ?)`,
        [inserted.insertId, individualId, churchId],
      );
    }
  }
  const hcSession = await Database.query(
    `INSERT INTO attendance_sessions
       (gathering_type_id, session_date, created_by, session_status, church_id)
     VALUES (?, '2026-08-09', ?, 'held', ?)`,
    [headcount.insertId, user.insertId, churchId],
  );
  await Database.query(
    `INSERT INTO headcount_records (session_id, headcount, updated_by, church_id)
     VALUES (?, 50, ?, ?)`,
    [hcSession.insertId, user.insertId, churchId],
  );
  return { people, headcountSessionId: hcSession.insertId };
}

test('loads one bounded church snapshot and keeps database calls fixed outside person/session loops', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedBulkFixture(churchId);
    const window = getEngagementWindow('2026-08-16T14:00:00.000Z', 'Australia/Hobart');
    const source = await loadOpportunitySource(churchId, window);

    assert.equal(source.people.length, 12);
    assert.equal(source.assignments.length, 12);
    assert.equal(source.sessions.length, 10);
    assert.equal(source.records.length, 108);
    assert.deepEqual(source.headcounts, [{ sessionId: fixture.headcountSessionId, headcount: 50 }]);

    const originalQueryForChurch = Database.queryForChurch;
    let queryCount = 0;
    Database.queryForChurch = async (...args) => {
      queryCount += 1;
      return originalQueryForChurch.call(Database, ...args);
    };
    try {
      const result = await calculateEngagementProfiles(churchId, {
        asOf: '2026-08-16T14:00:00.000Z',
      });
      assert.equal(result.current.size, 12);
      assert.deepEqual(result.current.get(fixture.people[0]).primary, {
        status: 'core', attended: 9, opportunities: 9, rate: 1,
      });
      assert.equal(queryCount, 9);
    } finally {
      Database.queryForChurch = originalQueryForChurch;
    }
  });
});
