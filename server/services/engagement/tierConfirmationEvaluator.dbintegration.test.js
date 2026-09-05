'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../../config/logger');
logger.exceptions?.unhandle();
logger.rejections?.unhandle();

const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { evaluateEngagementTierConfirmations } = require('./tierConfirmationEvaluator');

const AS_OF = '2026-08-17T12:00:00.000Z';
const NEXT_WEEK = '2026-08-24T12:00:00.000Z';
const THIRD_WEEK = '2026-08-31T12:00:00.000Z';
const DATES = [
  '2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06',
  '2026-07-13', '2026-07-20', '2026-07-27', '2026-08-03', '2026-08-10',
];

function scopedQuery(churchId) {
  return (sql, params = []) => Database.queryForChurch(churchId, sql, params);
}

async function ensureSecondChurch(churchId) {
  Database.ensureChurch(churchId, 'Other Church');
  await scopedQuery(churchId)(
    `INSERT INTO church_settings (church_id, church_name, timezone)
     VALUES (?, 'Other Church', 'UTC')`,
    [churchId],
  );
}

async function seedRoster(churchId, people) {
  const query = scopedQuery(churchId);
  await query(`UPDATE church_settings SET timezone = 'UTC' WHERE church_id = ?`, [churchId]);
  const user = await query(
    `INSERT INTO users (church_id, email, role, first_name, last_name)
     VALUES (?, ?, 'admin', 'Test', 'Admin')`,
    [churchId, `${churchId}@example.test`],
  );
  const primary = await query(
    `INSERT INTO gathering_types
       (name, attendance_type, is_active, engagement_role, church_id)
     VALUES ('Primary', 'standard', 1, 'primary', ?)`,
    [churchId],
  );
  const community = await query(
    `INSERT INTO gathering_types
       (name, attendance_type, is_active, engagement_role, church_id)
     VALUES ('Community', 'standard', 1, 'community', ?)`,
    [churchId],
  );

  const sessions = { primary: [], community: [] };
  for (const date of DATES) {
    for (const [axis, gatheringTypeId] of [
      ['primary', primary.insertId],
      ['community', community.insertId],
    ]) {
      const inserted = await query(
        `INSERT INTO attendance_sessions
           (gathering_type_id, session_date, created_by, roster_snapshotted,
            session_status, roster_provenance_version, church_id)
         VALUES (?, ?, ?, 1, 'held', 1, ?)`,
        [gatheringTypeId, date, user.insertId, churchId],
      );
      sessions[axis].push(inserted.insertId);
    }
  }

  // Keep every synthetic gathering genuinely attended even when all regulars
  // in a scenario are absent; zero-attendance services are not report input.
  const marker = await query(
    `INSERT INTO individuals
       (first_name, last_name, people_type, is_active, church_id)
     VALUES ('Session', 'Marker', 'local_visitor', 1, ?)`,
    [churchId],
  );
  for (const sessionId of [...sessions.primary, ...sessions.community]) {
    await query(
      `INSERT INTO attendance_records
         (session_id, individual_id, present, eligible_at_snapshot,
          people_type_at_time, church_id)
       VALUES (?, ?, 1, 0, 'local_visitor', ?)`,
      [sessionId, marker.insertId, churchId],
    );
  }

  const seeded = [];
  for (const [index, person] of people.entries()) {
    const inserted = await query(
      `INSERT INTO individuals
         (first_name, last_name, people_type, is_active, church_id)
       VALUES (?, 'Evaluator', ?, ?, ?)`,
      [
        person.name || `Person ${index}`,
        person.peopleType || 'regular',
        person.active === false ? 0 : 1,
        churchId,
      ],
    );
    const individualId = inserted.insertId;
    seeded.push({ ...person, individualId });

    for (const [axis, gatheringTypeId] of [
      ['primary', primary.insertId],
      ['community', community.insertId],
    ]) {
      if (person[`${axis}Assigned`] !== false && person[axis]) {
        await query(
          `INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id)
           VALUES (?, ?, ?)`,
          [gatheringTypeId, individualId, churchId],
        );
      }
      for (let dateIndex = 0; dateIndex < (person[axis] || []).length; dateIndex += 1) {
        await query(
          `INSERT INTO attendance_records
             (session_id, individual_id, present, eligible_at_snapshot,
              people_type_at_time, church_id)
           VALUES (?, ?, ?, 1, ?, ?)`,
          [
            sessions[axis][dateIndex],
            individualId,
            person[axis][dateIndex] ? 1 : 0,
            person.peopleType || 'regular',
            churchId,
          ],
        );
      }
    }
  }
  return { people: seeded, sessions };
}

async function seedState(churchId, individualId, axis, overrides = {}) {
  const row = {
    rulesVersion: 1,
    establishedTier: 'casual',
    candidateTier: null,
    candidateDirection: null,
    candidateStartedWeekEnd: null,
    candidateFinalWeekEnd: null,
    lastEvaluatedWeekEnd: '2026-08-09',
    ...overrides,
  };
  await scopedQuery(churchId)(
    `INSERT INTO engagement_tier_state
       (church_id, individual_id, axis, rules_version, established_tier,
        candidate_tier, candidate_direction, candidate_started_week_end,
        candidate_final_week_end, last_evaluated_week_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      churchId, individualId, axis, row.rulesVersion, row.establishedTier,
      row.candidateTier, row.candidateDirection, row.candidateStartedWeekEnd,
      row.candidateFinalWeekEnd, row.lastEvaluatedWeekEnd,
    ],
  );
}

async function loadStates(churchId) {
  return scopedQuery(churchId)(
    `SELECT individual_id AS individualId, axis,
            rules_version AS rulesVersion,
            established_tier AS establishedTier,
            candidate_tier AS candidateTier,
            candidate_direction AS candidateDirection,
            candidate_started_week_end AS candidateStartedWeekEnd,
            candidate_final_week_end AS candidateFinalWeekEnd,
            last_evaluated_week_end AS lastEvaluatedWeekEnd
     FROM engagement_tier_state
     WHERE church_id = ?
     ORDER BY individual_id, axis`,
    [churchId],
  );
}

async function loadTransitions(churchId) {
  return scopedQuery(churchId)(
    `SELECT individual_id AS individualId, axis,
            from_tier AS fromTier, to_tier AS toTier,
            candidate_started_week_end AS candidateStartedWeekEnd,
            confirmed_week_end AS confirmedWeekEnd,
            rules_version AS rulesVersion,
            long_term_attended AS longTermAttended,
            long_term_opportunities AS longTermOpportunities,
            long_term_rate AS longTermRate,
            confirmation_attended AS confirmationAttended,
            confirmation_opportunities AS confirmationOpportunities,
            confirmation_rate AS confirmationRate,
            pastoral_processed_at AS pastoralProcessedAt,
            decline_event_id AS declineEventId
     FROM engagement_tier_transitions
     WHERE church_id = ?
     ORDER BY individual_id, axis`,
    [churchId],
  );
}

function pauseFirstChurchTransaction({ afterBegin = false } = {}) {
  const originalTransactionForChurch = Database.transactionForChurch;
  let transactionCalls = 0;
  let markFirstReached;
  let markSecondReached;
  let releaseFirst;
  const firstReached = new Promise((resolve) => { markFirstReached = resolve; });
  const secondReached = new Promise((resolve) => { markSecondReached = resolve; });
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });

  Database.transactionForChurch = async (churchId, callback) => {
    transactionCalls += 1;
    if (transactionCalls === 1) {
      if (afterBegin) {
        return originalTransactionForChurch.call(Database, churchId, async (conn) => {
          markFirstReached();
          await firstReleased;
          return callback(conn);
        });
      }
      markFirstReached();
      await firstReleased;
      return originalTransactionForChurch.call(Database, churchId, callback);
    }
    if (transactionCalls === 2) markSecondReached();
    return originalTransactionForChurch.call(Database, churchId, callback);
  };

  return {
    firstReached,
    secondReached,
    release: () => releaseFirst(),
    restore: () => { Database.transactionForChurch = originalTransactionForChurch; },
  };
}

test('first run baselines both axes for active regulars and persists nullable ineligible axes', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedRoster(churchId, [
      { name: 'Active', primary: [1, 1, 1, 1, 1, 1, 0, 0, 0, 0] },
      { name: 'Inactive', active: false, primary: Array(10).fill(1) },
      { name: 'Visitor', peopleType: 'local_visitor', primary: Array(10).fill(1) },
    ]);

    const result = await evaluateEngagementTierConfirmations(churchId, { asOf: AS_OF });

    assert.deepEqual(result, {
      completedWeekEnd: '2026-08-16',
      baselined: 1,
      candidatesStarted: 0,
      candidatesCancelled: 0,
      candidatesExpired: 0,
      transitionsConfirmed: 0,
    });
    assert.deepEqual(await loadStates(churchId), [
      {
        individualId: fixture.people[0].individualId,
        axis: 'community',
        rulesVersion: 1,
        establishedTier: null,
        candidateTier: null,
        candidateDirection: null,
        candidateStartedWeekEnd: null,
        candidateFinalWeekEnd: null,
        lastEvaluatedWeekEnd: '2026-08-16',
      },
      {
        individualId: fixture.people[0].individualId,
        axis: 'primary',
        rulesVersion: 1,
        establishedTier: 'core',
        candidateTier: null,
        candidateDirection: null,
        candidateStartedWeekEnd: null,
        candidateFinalWeekEnd: null,
        lastEvaluatedWeekEnd: '2026-08-16',
      },
    ]);
    assert.deepEqual(await loadTransitions(churchId), []);
  });
});

test('same-week inactive evaluation clears eligibility and reactivation creates a fresh baseline', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedRoster(churchId, [
      { primary: [1, 1, 1, 1, 1, 1, 0, 0, 0, 0] },
    ]);
    const individualId = fixture.people[0].individualId;
    await seedState(churchId, individualId, 'primary', {
      establishedTier: 'casual',
      candidateTier: 'core',
      candidateDirection: 'higher',
      candidateStartedWeekEnd: '2026-08-09',
      candidateFinalWeekEnd: '2026-11-08',
      lastEvaluatedWeekEnd: '2026-08-16',
    });
    await seedState(churchId, individualId, 'community', {
      establishedTier: 'casual',
      lastEvaluatedWeekEnd: '2026-08-16',
    });
    const transition = await scopedQuery(churchId)(
      `INSERT INTO engagement_tier_transitions
         (church_id, individual_id, axis, from_tier, to_tier,
          candidate_started_week_end, confirmed_week_end, rules_version,
          long_term_attended, long_term_opportunities, long_term_rate,
          confirmation_attended, confirmation_opportunities, confirmation_rate)
       VALUES (?, ?, 'community', 'irregular', 'casual', '2026-04-26', '2026-08-02', 1,
               5, 13, ?, 4, 8, 0.5)`,
      [churchId, individualId, 5 / 13],
    );
    await scopedQuery(churchId)(
      `UPDATE individuals SET is_active = 0 WHERE church_id = ? AND id = ?`,
      [churchId, individualId],
    );

    const result = await evaluateEngagementTierConfirmations(churchId, { asOf: AS_OF });

    assert.deepEqual(result, {
      completedWeekEnd: '2026-08-16',
      baselined: 0,
      candidatesStarted: 0,
      candidatesCancelled: 0,
      candidatesExpired: 0,
      transitionsConfirmed: 0,
    });
    assert.deepEqual(await loadStates(churchId), [
      {
        individualId,
        axis: 'community',
        rulesVersion: 1,
        establishedTier: null,
        candidateTier: null,
        candidateDirection: null,
        candidateStartedWeekEnd: null,
        candidateFinalWeekEnd: null,
        lastEvaluatedWeekEnd: '2026-08-16',
      },
      {
        individualId,
        axis: 'primary',
        rulesVersion: 1,
        establishedTier: null,
        candidateTier: null,
        candidateDirection: null,
        candidateStartedWeekEnd: null,
        candidateFinalWeekEnd: null,
        lastEvaluatedWeekEnd: '2026-08-16',
      },
    ]);
    assert.deepEqual(await scopedQuery(churchId)(
      `SELECT id, individual_id AS individualId
       FROM engagement_tier_transitions WHERE church_id = ?`,
      [churchId],
    ), [{ id: transition.insertId, individualId }]);

    await scopedQuery(churchId)(
      `UPDATE individuals SET is_active = 1 WHERE church_id = ? AND id = ?`,
      [churchId, individualId],
    );
    const reactivated = await evaluateEngagementTierConfirmations(churchId, { asOf: NEXT_WEEK });

    assert.deepEqual(reactivated, {
      completedWeekEnd: '2026-08-23',
      baselined: 1,
      candidatesStarted: 0,
      candidatesCancelled: 0,
      candidatesExpired: 0,
      transitionsConfirmed: 0,
    });
    assert.deepEqual(await loadStates(churchId), [
      {
        individualId,
        axis: 'community',
        rulesVersion: 1,
        establishedTier: null,
        candidateTier: null,
        candidateDirection: null,
        candidateStartedWeekEnd: null,
        candidateFinalWeekEnd: null,
        lastEvaluatedWeekEnd: '2026-08-23',
      },
      {
        individualId,
        axis: 'primary',
        rulesVersion: 1,
        establishedTier: 'core',
        candidateTier: null,
        candidateDirection: null,
        candidateStartedWeekEnd: null,
        candidateFinalWeekEnd: null,
        lastEvaluatedWeekEnd: '2026-08-23',
      },
    ]);
    assert.deepEqual(await scopedQuery(churchId)(
      `SELECT id, individual_id AS individualId
       FROM engagement_tier_transitions WHERE church_id = ?`,
      [churchId],
    ), [{ id: transition.insertId, individualId }]);
  });
});

test('weekly runs advance once, ignore same-week reruns, and cancel after corrected evidence', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedRoster(churchId, [
      { primary: [1, 1, 1, 1, 1, 1, 0, 0, 0, 0] },
    ]);
    const individualId = fixture.people[0].individualId;
    await seedState(churchId, individualId, 'primary');

    const started = await evaluateEngagementTierConfirmations(churchId, { asOf: AS_OF });
    assert.equal(started.candidatesStarted, 1);
    let primary = (await loadStates(churchId)).find((row) => row.axis === 'primary');
    assert.equal(primary.candidateTier, 'core');
    assert.equal(primary.candidateStartedWeekEnd, '2026-08-16');
    assert.equal(primary.candidateFinalWeekEnd, '2026-11-15');

    const repeated = await evaluateEngagementTierConfirmations(churchId, { asOf: AS_OF });
    assert.deepEqual(repeated, {
      completedWeekEnd: '2026-08-16', baselined: 0, candidatesStarted: 0,
      candidatesCancelled: 0, candidatesExpired: 0, transitionsConfirmed: 0,
    });
    primary = (await loadStates(churchId)).find((row) => row.axis === 'primary');
    assert.equal(primary.candidateTier, 'core');

    const advanced = await evaluateEngagementTierConfirmations(churchId, { asOf: NEXT_WEEK });
    assert.equal(advanced.transitionsConfirmed, 0);
    primary = (await loadStates(churchId)).find((row) => row.axis === 'primary');
    assert.equal(primary.candidateTier, 'core');
    assert.equal(primary.lastEvaluatedWeekEnd, '2026-08-23');

    await scopedQuery(churchId)(
      `UPDATE attendance_records
       SET present = 0
       WHERE church_id = ? AND individual_id = ?
         AND session_id IN (?, ?, ?)`,
      [
        churchId,
        individualId,
        fixture.sessions.primary[3],
        fixture.sessions.primary[4],
        fixture.sessions.primary[5],
      ],
    );
    const cancelled = await evaluateEngagementTierConfirmations(churchId, { asOf: THIRD_WEEK });
    assert.equal(cancelled.candidatesCancelled, 1);
    primary = (await loadStates(churchId)).find((row) => row.axis === 'primary');
    assert.equal(primary.establishedTier, 'casual');
    assert.equal(primary.candidateTier, null);
    assert.equal(primary.lastEvaluatedWeekEnd, '2026-08-30');
  });
});

test('overlapping same-week evaluations progress a candidate only once', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedRoster(churchId, [
      { primary: [1, 1, 1, 1, 1, 1, 0, 0, 0, 0] },
    ]);
    await seedState(churchId, fixture.people[0].individualId, 'primary');
    const pause = pauseFirstChurchTransaction({ afterBegin: true });
    let first;
    let second;
    try {
      const firstRun = evaluateEngagementTierConfirmations(churchId, { asOf: AS_OF });
      await pause.firstReached;
      const secondRun = evaluateEngagementTierConfirmations(churchId, { asOf: AS_OF });
      await pause.secondReached;
      pause.release();
      [first, second] = await Promise.all([firstRun, secondRun]);
    } finally {
      pause.release();
      pause.restore();
    }

    assert.deepEqual(
      [first.candidatesStarted, second.candidatesStarted].sort(),
      [0, 1],
    );
    const primary = (await loadStates(churchId)).find((row) => row.axis === 'primary');
    assert.equal(primary.candidateStartedWeekEnd, '2026-08-16');
    assert.equal(primary.lastEvaluatedWeekEnd, '2026-08-16');
  });
});

test('an older evaluation committing last cannot move confirmed state backward', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedRoster(churchId, [
      { primary: [1, 1, 1, 1, 1, 1, 0, 0, 0, 0] },
    ]);
    await seedState(churchId, fixture.people[0].individualId, 'primary');
    const pause = pauseFirstChurchTransaction();
    let older;
    let newer;
    try {
      const olderRun = evaluateEngagementTierConfirmations(churchId, { asOf: AS_OF });
      await pause.firstReached;
      const newerRun = evaluateEngagementTierConfirmations(churchId, { asOf: NEXT_WEEK });
      await pause.secondReached;
      newer = await newerRun;
      pause.release();
      older = await olderRun;
    } finally {
      pause.release();
      pause.restore();
    }

    assert.equal(newer.candidatesStarted, 1);
    assert.equal(older.candidatesStarted, 0);
    const primary = (await loadStates(churchId)).find((row) => row.axis === 'primary');
    assert.equal(primary.candidateStartedWeekEnd, '2026-08-23');
    assert.equal(primary.lastEvaluatedWeekEnd, '2026-08-23');
  });
});

test('an older forced-baseline run cannot bypass the committed state version', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedRoster(churchId, [
      { primary: [1, 1, 1, 1, 1, 1, 0, 0, 0, 0] },
    ]);
    await seedState(churchId, fixture.people[0].individualId, 'primary');
    const pause = pauseFirstChurchTransaction();
    let older;
    try {
      const olderRun = evaluateEngagementTierConfirmations(churchId, {
        asOf: AS_OF,
        baselineOnly: true,
      });
      await pause.firstReached;
      const newerRun = evaluateEngagementTierConfirmations(churchId, { asOf: NEXT_WEEK });
      await pause.secondReached;
      await newerRun;
      pause.release();
      older = await olderRun;
    } finally {
      pause.release();
      pause.restore();
    }

    assert.equal(older.baselined, 0);
    const primary = (await loadStates(churchId)).find((row) => row.axis === 'primary');
    assert.equal(primary.candidateStartedWeekEnd, '2026-08-23');
    assert.equal(primary.lastEvaluatedWeekEnd, '2026-08-23');
  });
});

test('a stale transition is not inserted when its associated state progression loses', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedRoster(churchId, [{
      primary: [1, 0, 1, 1, 1, 1, 1, 0, 0, 0],
    }]);
    const individualId = fixture.people[0].individualId;
    await seedState(churchId, individualId, 'primary', {
      candidateTier: 'core', candidateDirection: 'higher',
      candidateStartedWeekEnd: '2026-06-21', candidateFinalWeekEnd: '2026-09-20',
      lastEvaluatedWeekEnd: '2026-06-21',
    });
    const pause = pauseFirstChurchTransaction();
    let older;
    let newer;
    try {
      const olderRun = evaluateEngagementTierConfirmations(churchId, { asOf: AS_OF });
      await pause.firstReached;
      const newerRun = evaluateEngagementTierConfirmations(churchId, { asOf: NEXT_WEEK });
      await pause.secondReached;
      newer = await newerRun;
      pause.release();
      older = await olderRun;
    } finally {
      pause.release();
      pause.restore();
    }

    assert.equal(newer.transitionsConfirmed, 1);
    assert.equal(older.transitionsConfirmed, 0);
    const primary = (await loadStates(churchId)).find((row) => row.axis === 'primary');
    assert.equal(primary.establishedTier, 'core');
    assert.equal(primary.lastEvaluatedWeekEnd, '2026-08-23');
    const transitions = await loadTransitions(churchId);
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].confirmedWeekEnd, '2026-08-23');
  });
});

test('cancelling contributing sessions recomputes evidence and cancels an active candidate', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedRoster(churchId, [
      { primary: [1, 1, 1, 1, 1, 1, 0, 0, 0, 0] },
    ]);
    const individualId = fixture.people[0].individualId;
    await seedState(churchId, individualId, 'primary');
    const started = await evaluateEngagementTierConfirmations(churchId, { asOf: AS_OF });
    assert.equal(started.candidatesStarted, 1);

    await scopedQuery(churchId)(
      `UPDATE attendance_sessions
       SET session_status = 'cancelled'
       WHERE church_id = ? AND id IN (?, ?)`,
      [churchId, fixture.sessions.primary[0], fixture.sessions.primary[1]],
    );
    const cancelled = await evaluateEngagementTierConfirmations(churchId, { asOf: NEXT_WEEK });

    assert.equal(cancelled.candidatesCancelled, 1);
    const primary = (await loadStates(churchId)).find((row) => row.axis === 'primary');
    assert.equal(primary.establishedTier, 'casual');
    assert.equal(primary.candidateTier, null);
    assert.equal(primary.lastEvaluatedWeekEnd, '2026-08-23');
    assert.deepEqual(await loadTransitions(churchId), []);
  });
});

test('an expired candidate clears before a later week can restart it', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedRoster(churchId, [
      { primary: [1, 1, 1, 1, 1, 1, 0, 0, 0, 0] },
    ]);
    const individualId = fixture.people[0].individualId;
    await seedState(churchId, individualId, 'primary', {
      candidateTier: 'core',
      candidateDirection: 'higher',
      candidateStartedWeekEnd: '2026-05-10',
      candidateFinalWeekEnd: '2026-08-09',
      lastEvaluatedWeekEnd: '2026-08-02',
    });

    const expired = await evaluateEngagementTierConfirmations(churchId, { asOf: AS_OF });
    assert.equal(expired.candidatesExpired, 1);
    let primary = (await loadStates(churchId)).find((row) => row.axis === 'primary');
    assert.equal(primary.candidateTier, null);

    const restarted = await evaluateEngagementTierConfirmations(churchId, { asOf: NEXT_WEEK });
    assert.equal(restarted.candidatesStarted, 1);
    primary = (await loadStates(churchId)).find((row) => row.axis === 'primary');
    assert.equal(primary.candidateTier, 'core');
    assert.equal(primary.candidateStartedWeekEnd, '2026-08-23');
  });
});

test('rules-version and forced runs baseline classified states without inventing transitions', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedRoster(churchId, [{
      primary: [1, 1, 1, 1, 1, 1, 0, 0, 0, 0],
      community: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
    }]);
    const individualId = fixture.people[0].individualId;
    for (const axis of ['primary', 'community']) {
      await seedState(churchId, individualId, axis, {
        candidateTier: axis === 'primary' ? 'core' : 'irregular',
        candidateDirection: axis === 'primary' ? 'higher' : 'lower',
        candidateStartedWeekEnd: '2026-08-09',
        candidateFinalWeekEnd: '2026-11-08',
      });
    }
    await scopedQuery(churchId)(
      `INSERT INTO engagement_settings (church_id, calculation_rules_version)
       VALUES (?, 2)`,
      [churchId],
    );

    const versionBaseline = await evaluateEngagementTierConfirmations(churchId, { asOf: AS_OF });
    assert.equal(versionBaseline.baselined, 2);
    assert.deepEqual((await loadStates(churchId)).map((row) => [
      row.axis, row.rulesVersion, row.establishedTier, row.candidateTier,
    ]), [
      ['community', 2, 'casual', null],
      ['primary', 2, 'core', null],
    ]);

    await scopedQuery(churchId)(
      `UPDATE engagement_tier_state
       SET established_tier = 'casual', candidate_tier = 'core',
           candidate_direction = 'higher', candidate_started_week_end = '2026-08-16',
           candidate_final_week_end = '2026-11-15'
       WHERE church_id = ? AND individual_id = ? AND axis = 'primary'`,
      [churchId, individualId],
    );
    const forced = await evaluateEngagementTierConfirmations(churchId, {
      asOf: AS_OF,
      baselineOnly: true,
    });
    assert.equal(forced.baselined, 2);
    const primary = (await loadStates(churchId)).find((row) => row.axis === 'primary');
    assert.equal(primary.establishedTier, 'core');
    assert.equal(primary.candidateTier, null);
    assert.deepEqual(await loadTransitions(churchId), []);
  });
});

test('confirms both axes with exact evidence, dedupes reruns, and leaves another church untouched', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedRoster(churchId, [{
      primary: [1, 0, 1, 1, 1, 1, 1, 0, 0, 0],
      community: [0, 0, 1, 1, 1, 0, 0, 0, 0, 0],
    }]);
    const individualId = fixture.people[0].individualId;
    await seedState(churchId, individualId, 'primary', {
      establishedTier: 'casual', candidateTier: 'core', candidateDirection: 'higher',
      candidateStartedWeekEnd: '2026-06-21', candidateFinalWeekEnd: '2026-09-20',
      lastEvaluatedWeekEnd: '2026-06-21',
    });
    await seedState(churchId, individualId, 'community', {
      establishedTier: 'core', candidateTier: 'casual', candidateDirection: 'lower',
      candidateStartedWeekEnd: '2026-06-21', candidateFinalWeekEnd: '2026-09-20',
      lastEvaluatedWeekEnd: '2026-06-21',
    });

    const otherChurchId = `${churchId}_other`;
    await ensureSecondChurch(otherChurchId);
    const otherFixture = await seedRoster(otherChurchId, [{ primary: Array(10).fill(1) }]);
    await seedState(otherChurchId, otherFixture.people[0].individualId, 'primary', {
      establishedTier: 'irregular',
    });
    const otherBefore = await loadStates(otherChurchId);

    const originalQueryForChurch = Database.queryForChurch;
    const originalTransactionForChurch = Database.transactionForChurch;
    const observedChurchIds = [];
    Database.queryForChurch = async (scopedChurchId, ...args) => {
      observedChurchIds.push(scopedChurchId);
      return originalQueryForChurch.call(Database, scopedChurchId, ...args);
    };
    Database.transactionForChurch = async (scopedChurchId, ...args) => {
      observedChurchIds.push(scopedChurchId);
      return originalTransactionForChurch.call(Database, scopedChurchId, ...args);
    };
    let confirmed;
    try {
      confirmed = await evaluateEngagementTierConfirmations(churchId, { asOf: AS_OF });
    } finally {
      Database.queryForChurch = originalQueryForChurch;
      Database.transactionForChurch = originalTransactionForChurch;
    }
    assert.equal(confirmed.transitionsConfirmed, 2);
    assert.ok(observedChurchIds.length > 0);
    assert.deepEqual(new Set(observedChurchIds), new Set([churchId]));
    assert.deepEqual(await loadTransitions(churchId), [
      {
        individualId,
        axis: 'community',
        fromTier: 'core',
        toTier: 'casual',
        candidateStartedWeekEnd: '2026-06-21',
        confirmedWeekEnd: '2026-08-16',
        rulesVersion: 1,
        longTermAttended: 3,
        longTermOpportunities: 10,
        longTermRate: 0.3,
        confirmationAttended: 3,
        confirmationOpportunities: 8,
        confirmationRate: 0.375,
        pastoralProcessedAt: null,
        declineEventId: null,
      },
      {
        individualId,
        axis: 'primary',
        fromTier: 'casual',
        toTier: 'core',
        candidateStartedWeekEnd: '2026-06-21',
        confirmedWeekEnd: '2026-08-16',
        rulesVersion: 1,
        longTermAttended: 6,
        longTermOpportunities: 10,
        longTermRate: 0.6,
        confirmationAttended: 5,
        confirmationOpportunities: 8,
        confirmationRate: 0.625,
        pastoralProcessedAt: null,
        declineEventId: null,
      },
    ]);

    const repeated = await evaluateEngagementTierConfirmations(churchId, { asOf: AS_OF });
    assert.equal(repeated.transitionsConfirmed, 0);
    assert.equal((await loadTransitions(churchId)).length, 2);
    assert.deepEqual(await loadStates(otherChurchId), otherBefore);
    assert.deepEqual(await loadTransitions(otherChurchId), []);
  });
});

test('a transition insert failure rolls back the state upsert in the same church transaction', async () => {
  await withTestChurchDb(async (churchId) => {
    const fixture = await seedRoster(churchId, [{
      primary: [1, 0, 1, 1, 1, 1, 1, 0, 0, 0],
    }]);
    const individualId = fixture.people[0].individualId;
    await seedState(churchId, individualId, 'primary', {
      candidateTier: 'core', candidateDirection: 'higher',
      candidateStartedWeekEnd: '2026-06-21', candidateFinalWeekEnd: '2026-09-20',
      lastEvaluatedWeekEnd: '2026-06-21',
    });
    const before = await loadStates(churchId);

    const originalExecuteQuery = Database._executeQuery;
    const originalConsoleError = console.error;
    Database._executeQuery = (db, sql, params) => {
      if (sql.includes('INSERT INTO engagement_tier_transitions')) {
        throw new Error('injected transition persistence failure');
      }
      return originalExecuteQuery.call(Database, db, sql, params);
    };
    console.error = () => {};
    try {
      await assert.rejects(
        evaluateEngagementTierConfirmations(churchId, { asOf: AS_OF }),
        /injected transition persistence failure/,
      );
    } finally {
      Database._executeQuery = originalExecuteQuery;
      console.error = originalConsoleError;
    }

    assert.deepEqual(await loadStates(churchId), before);
    assert.deepEqual(await loadTransitions(churchId), []);
  });
});

test('database work remains bulk-bounded as the representative roster grows', async () => {
  await withTestChurchDb(async (churchId) => {
    const people = Array.from({ length: 18 }, (_, index) => ({
      name: `Bulk ${index}`,
      primary: Array(10).fill(index % 3 !== 0),
      community: Array(10).fill(index % 2 === 0),
    }));
    await seedRoster(churchId, people);

    const originalExecuteQuery = Database._executeQuery;
    const queryLog = [];
    Database._executeQuery = (db, sql, params) => {
      queryLog.push(sql.replace(/\s+/g, ' ').trim());
      return originalExecuteQuery.call(Database, db, sql, params);
    };
    try {
      const result = await evaluateEngagementTierConfirmations(churchId, { asOf: AS_OF });
      assert.equal(result.baselined, 36);
    } finally {
      Database._executeQuery = originalExecuteQuery;
    }

    const EXPECTED_BULK_QUERY_CEILING = 12;
    assert.ok(queryLog.length <= EXPECTED_BULK_QUERY_CEILING, queryLog.join('\n'));
    assert.equal(queryLog.some((sql) => /WHERE individual_id = \?/i.test(sql)), false);
    for (const sql of queryLog.filter((statement) =>
      /(?:engagement_tier_state|engagement_tier_transitions)/i.test(statement))) {
      assert.match(sql, /church_id/i);
    }
  });
});
