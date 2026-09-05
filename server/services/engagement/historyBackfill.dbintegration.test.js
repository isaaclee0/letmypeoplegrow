'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { backfillEngagementHistory, replayProfileHistory } = require('./historyBackfill');

function weekProfile(index) {
  const date = new Date('2026-01-04T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + index * 7);
  const completedWeekEnd = date.toISOString().slice(0, 10);
  const core = index === 0;
  const opportunities = Array.from({ length: index }, (_, opportunityIndex) => {
    const opportunityDate = new Date('2026-01-11T00:00:00Z');
    opportunityDate.setUTCDate(opportunityDate.getUTCDate() + opportunityIndex * 7);
    return { individualId: 1, date: opportunityDate.toISOString().slice(0, 10), attended: false };
  });
  return {
    window: { completedWeekEnd },
    settings: { coreMinimum: 60, casualMinimum: 20, calculationRulesVersion: 1 },
    current: new Map([[1, {
      primary: core
        ? { status: 'core', attended: 8, opportunities: 10, rate: 0.8 }
        : { status: 'irregular', attended: 1, opportunities: 10, rate: 0.1 },
      community: { status: 'not_assigned', attended: 0, opportunities: 0, rate: null },
    }]]),
    datedOpportunities: { primary: opportunities, community: [] },
  };
}

test('replayProfileHistory reconstructs a sustained historical tier transition', () => {
  const replay = replayProfileHistory(Array.from({ length: 14 }, (_, index) => weekProfile(index)));

  assert.equal(replay.weeksEvaluated, 14);
  assert.equal(replay.transitions.length, 1);
  assert.deepEqual(
    { from: replay.transitions[0].fromTier, to: replay.transitions[0].toTier },
    { from: 'core', to: 'irregular' },
  );
  assert.equal(replay.states.find((state) => state.axis === 'primary').establishedTier, 'irregular');
});

test('replayProfileHistory accepts an empty history without inventing movement', () => {
  assert.deepEqual(replayProfileHistory([]), {
    states: [], transitions: [], weeksEvaluated: 0,
  });
});

test('backfillEngagementHistory atomically marks and deduplicates a completed replay', async () => {
  await withTestChurchDb(async (churchId) => {
    const actor = await Database.query(
      `INSERT INTO users (church_id, email, role, first_name, last_name, is_active)
       VALUES (?, ?, 'admin', 'Test', 'Admin', 1)`, [churchId, `${churchId}@example.test`],
    );
    const person = await Database.query(
      `INSERT INTO individuals (first_name, last_name, people_type, is_active, church_id)
       VALUES ('Historical', 'Person', 'regular', 1, ?)`, [churchId],
    );
    const gathering = await Database.query(
      `INSERT INTO gathering_types
         (name, attendance_type, is_active, engagement_role, church_id)
       VALUES ('Primary', 'standard', 1, 'primary', ?)`, [churchId],
    );
    await Database.query(
      `INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id)
       VALUES (?, ?, ?)`, [gathering.insertId, person.insertId, churchId],
    );
    const session = await Database.query(
      `INSERT INTO attendance_sessions
         (gathering_type_id, session_date, created_by, roster_snapshotted, session_status, church_id)
       VALUES (?, '2026-01-04', ?, 1, 'open', ?)`, [gathering.insertId, actor.insertId, churchId],
    );
    await Database.query(
      `INSERT INTO attendance_records
         (session_id, individual_id, present, church_id, eligible_at_snapshot)
      VALUES (?, ?, 1, ?, 1)`, [session.insertId, person.insertId, churchId],
    );
    await Database.query(
      `INSERT INTO attendance_sessions
         (gathering_type_id, session_date, created_by, roster_snapshotted,
          session_status, excluded_from_stats, church_id)
       VALUES (?, '2025-12-07', ?, 1, 'held', 1, ?)`,
      [gathering.insertId, actor.insertId, churchId],
    );

    let profileCalls = 0;
    const calculate = async () => weekProfile(profileCalls++);
    const first = await backfillEngagementHistory(churchId, {
      asOf: new Date('2026-04-13T12:00:00Z'),
      __deps: { calculateEngagementProfiles: calculate },
    });
    const callsAfterFirst = profileCalls;
    const second = await backfillEngagementHistory(churchId, {
      asOf: new Date('2026-04-13T12:00:00Z'),
      __deps: { calculateEngagementProfiles: calculate },
    });

    assert.equal(first.status, 'completed');
    assert.equal(first.firstWeekEnd, '2026-01-04');
    assert.equal(first.transitionsReconstructed, 1);
    assert.equal(second.status, 'already_completed');
    assert.equal(profileCalls, callsAfterFirst);
    assert.deepEqual(await Database.query(
      `SELECT COUNT(*) AS count FROM engagement_history_backfills WHERE church_id = ?`,
      [churchId],
    ), [{ count: 1 }]);
    const transitions = await Database.query(
      `SELECT reconstructed_at AS reconstructedAt
       FROM engagement_tier_transitions WHERE church_id = ?`, [churchId],
    );
    assert.equal(transitions.length, 1);
    assert.ok(transitions[0].reconstructedAt);
  });
});

test('backfillEngagementHistory leaves no completion marker when calculation fails', async () => {
  await withTestChurchDb(async (churchId) => {
    const actor = await Database.query(
      `INSERT INTO users (church_id, email, role, first_name, last_name, is_active)
       VALUES (?, ?, 'admin', 'Test', 'Admin', 1)`, [churchId, `${churchId}@example.test`],
    );
    const gathering = await Database.query(
      `INSERT INTO gathering_types
         (name, attendance_type, is_active, engagement_role, church_id)
       VALUES ('Primary', 'standard', 1, 'primary', ?)`, [churchId],
    );
    const person = await Database.query(
      `INSERT INTO individuals (first_name, last_name, people_type, is_active, church_id)
       VALUES ('Historical', 'Person', 'regular', 1, ?)`, [churchId],
    );
    const session = await Database.query(
      `INSERT INTO attendance_sessions
         (gathering_type_id, session_date, created_by, roster_snapshotted, session_status, church_id)
       VALUES (?, '2026-01-04', ?, 1, 'open', ?)`, [gathering.insertId, actor.insertId, churchId],
    );
    await Database.query(
      `INSERT INTO attendance_records
         (session_id, individual_id, present, church_id, eligible_at_snapshot)
       VALUES (?, ?, 1, ?, 1)`, [session.insertId, person.insertId, churchId],
    );

    await assert.rejects(
      backfillEngagementHistory(churchId, {
        asOf: new Date('2026-01-12T12:00:00Z'),
        __deps: { calculateEngagementProfiles: async () => { throw new Error('calculation failed'); } },
      }),
      /calculation failed/,
    );
    assert.deepEqual(await Database.query(
      `SELECT COUNT(*) AS count FROM engagement_history_backfills WHERE church_id = ?`,
      [churchId],
    ), [{ count: 0 }]);
  });
});
