'use strict';

const Database = require('../../config/database');
const { addDateOnly, loadChurchTimeZone } = require('../../utils/churchTime');
const { calculateEngagementProfiles, getEngagementWindow } = require('./opportunities');
const { getEngagementSettings } = require('./settings');
const {
  evaluateProfileWeek,
  insertTransitions,
  upsertTierStates,
} = require('./tierConfirmationEvaluator');

const running = new Map();

function sundayFor(date) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  const daysUntilSunday = (7 - parsed.getUTCDay()) % 7;
  return addDateOnly(date, { days: daysUntilSunday });
}

function asOfAfterWeek(weekEnd) {
  return new Date(`${addDateOnly(weekEnd, { days: 1 })}T12:00:00.000Z`);
}

function replayProfileHistory(profileWeeks) {
  let states = [];
  const transitions = [];
  for (const profiles of profileWeeks) {
    const evaluated = evaluateProfileWeek({ profiles, previousStates: states });
    states = evaluated.states;
    transitions.push(...evaluated.transitions);
  }
  return { states, transitions, weeksEvaluated: profileWeeks.length };
}

async function markerFor(database, churchId, rulesVersion) {
  const rows = await database.queryForChurch(
    churchId,
    `SELECT first_week_end AS firstWeekEnd,
            last_week_end AS lastWeekEnd,
            weeks_evaluated AS weeksEvaluated,
            transitions_reconstructed AS transitionsReconstructed
     FROM engagement_history_backfills
     WHERE church_id = ? AND rules_version = ?`,
    [churchId, rulesVersion],
  );
  return rows[0] || null;
}

async function performBackfill(churchId, { asOf = new Date(), __deps = {} } = {}) {
  if (!churchId) throw new Error('A church ID is required to backfill engagement history.');
  const database = __deps.database || Database;
  const calculateProfiles = __deps.calculateEngagementProfiles || calculateEngagementProfiles;
  const loadSettings = __deps.getEngagementSettings || getEngagementSettings;
  const loadTimeZone = __deps.loadChurchTimeZone || loadChurchTimeZone;
  const settings = await loadSettings(churchId);
  const rulesVersion = settings.calculationRulesVersion;
  const existing = await markerFor(database, churchId, rulesVersion);
  if (existing) return { status: 'already_completed', rulesVersion, ...existing };

  const timeZone = await loadTimeZone(churchId);
  const latestWeekEnd = getEngagementWindow(asOf, timeZone).completedWeekEnd;
  const firstRows = await database.queryForChurch(
    churchId,
    `SELECT MIN(session.session_date) AS firstSessionDate
     FROM attendance_sessions session
     JOIN gathering_types gathering
       ON gathering.id = session.gathering_type_id
      AND gathering.church_id = session.church_id
     WHERE session.church_id = ?
       AND session.session_status = 'held'
       AND session.excluded_from_stats = 0
       AND gathering.attendance_type = 'standard'
       AND gathering.engagement_role IN ('primary', 'community')
       AND (session.roster_provenance_version >= 1 OR session.roster_snapshotted = 1)`,
    [churchId],
  );
  const firstSessionDate = firstRows[0]?.firstSessionDate || null;
  const firstWeekEnd = firstSessionDate ? sundayFor(firstSessionDate) : null;
  const profileWeeks = [];
  if (firstWeekEnd && firstWeekEnd <= latestWeekEnd) {
    for (let weekEnd = firstWeekEnd; weekEnd <= latestWeekEnd; weekEnd = addDateOnly(weekEnd, { days: 7 })) {
      profileWeeks.push(await calculateProfiles(churchId, { asOf: asOfAfterWeek(weekEnd) }));
    }
  }
  const replay = replayProfileHistory(profileWeeks);
  const reconstructedAt = new Date().toISOString();
  const transitions = replay.transitions.map((transition) => ({ ...transition, reconstructedAt }));

  return database.transactionForChurch(churchId, async (conn) => {
    const currentSettings = await conn.query(
      `SELECT calculation_rules_version AS rulesVersion
       FROM engagement_settings WHERE church_id = ? LIMIT 1`,
      [churchId],
    );
    const currentRulesVersion = currentSettings[0]?.rulesVersion || 1;
    const markerRows = await conn.query(
      `SELECT 1 FROM engagement_history_backfills
       WHERE church_id = ? AND rules_version = ? LIMIT 1`,
      [churchId, rulesVersion],
    );
    if (currentRulesVersion !== rulesVersion) {
      return { status: 'stale', rulesVersion, firstWeekEnd, lastWeekEnd: latestWeekEnd,
        weeksEvaluated: replay.weeksEvaluated, transitionsReconstructed: 0 };
    }
    if (markerRows.length > 0) {
      return { status: 'already_completed', rulesVersion, firstWeekEnd, lastWeekEnd: latestWeekEnd,
        weeksEvaluated: replay.weeksEvaluated, transitionsReconstructed: 0 };
    }

    let inserted;
    try {
      await upsertTierStates(conn, churchId, replay.states);
      inserted = await insertTransitions(conn, churchId, transitions);
      await conn.query(
        `INSERT INTO engagement_history_backfills
           (church_id, rules_version, first_week_end, last_week_end,
            weeks_evaluated, transitions_reconstructed, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
        [churchId, rulesVersion, firstWeekEnd, latestWeekEnd,
          replay.weeksEvaluated, inserted.affectedRows],
      );
    } catch (error) {
      throw new Error(`Could not persist engagement history backfill: ${error.message || error.code}`, {
        cause: error,
      });
    }
    return {
      status: 'completed', rulesVersion, firstWeekEnd, lastWeekEnd: latestWeekEnd,
      weeksEvaluated: replay.weeksEvaluated, transitionsReconstructed: inserted.affectedRows,
    };
  });
}

function backfillEngagementHistory(churchId, options) {
  if (running.has(churchId)) return running.get(churchId);
  const operation = performBackfill(churchId, options).finally(() => running.delete(churchId));
  running.set(churchId, operation);
  return operation;
}

module.exports = { backfillEngagementHistory, replayProfileHistory, sundayFor };
