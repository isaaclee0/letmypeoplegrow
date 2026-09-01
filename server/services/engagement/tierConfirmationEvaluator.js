'use strict';

const Database = require('../../config/database');
const { calculateEngagementProfiles } = require('./opportunities');
const { evaluateTierConfirmation } = require('./tierConfirmation');

const AXES = Object.freeze(['primary', 'community']);

function stateKey(individualId, axis) {
  return `${individualId}:${axis}`;
}

function hasNewerStateVersion(previousState, rulesVersion, completedWeekEnd) {
  if (!previousState) return false;
  if (previousState.rulesVersion > rulesVersion) return true;
  return previousState.rulesVersion === rulesVersion
    && previousState.lastEvaluatedWeekEnd > completedWeekEnd;
}

function groupDatedOpportunities(datedOpportunities) {
  const grouped = {
    primary: new Map(),
    community: new Map(),
  };
  for (const axis of AXES) {
    for (const opportunity of datedOpportunities?.[axis] || []) {
      const facts = grouped[axis].get(opportunity.individualId) || [];
      facts.push(opportunity);
      grouped[axis].set(opportunity.individualId, facts);
    }
  }
  return grouped;
}

async function loadTierStates(conn, churchId) {
  return conn.query(
    `SELECT individual_id AS individualId,
            axis,
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

async function upsertTierStates(conn, churchId, states) {
  return conn.query(
    `INSERT INTO engagement_tier_state
       (church_id, individual_id, axis, rules_version, established_tier,
        candidate_tier, candidate_direction, candidate_started_week_end,
        candidate_final_week_end, last_evaluated_week_end, created_at, updated_at)
     SELECT ?,
            CAST(json_extract(state.value, '$.individualId') AS INTEGER),
            json_extract(state.value, '$.axis'),
            CAST(json_extract(state.value, '$.rulesVersion') AS INTEGER),
            json_extract(state.value, '$.establishedTier'),
            json_extract(state.value, '$.candidateTier'),
            json_extract(state.value, '$.candidateDirection'),
            json_extract(state.value, '$.candidateStartedWeekEnd'),
            json_extract(state.value, '$.candidateFinalWeekEnd'),
            json_extract(state.value, '$.lastEvaluatedWeekEnd'),
            datetime('now'), datetime('now')
     FROM json_each(?) state
     WHERE 1
     ON CONFLICT(church_id, individual_id, axis) DO UPDATE SET
       rules_version = excluded.rules_version,
       established_tier = excluded.established_tier,
       candidate_tier = excluded.candidate_tier,
       candidate_direction = excluded.candidate_direction,
       candidate_started_week_end = excluded.candidate_started_week_end,
       candidate_final_week_end = excluded.candidate_final_week_end,
       last_evaluated_week_end = excluded.last_evaluated_week_end,
       updated_at = datetime('now')`,
    [churchId, JSON.stringify(states)],
  );
}

async function insertTransitions(conn, churchId, transitions) {
  return conn.query(
    `INSERT INTO engagement_tier_transitions
       (church_id, individual_id, axis, from_tier, to_tier,
        candidate_started_week_end, confirmed_week_end, rules_version,
        long_term_attended, long_term_opportunities, long_term_rate,
        confirmation_attended, confirmation_opportunities, confirmation_rate)
     SELECT ?,
            CAST(json_extract(transition.value, '$.individualId') AS INTEGER),
            json_extract(transition.value, '$.axis'),
            json_extract(transition.value, '$.fromTier'),
            json_extract(transition.value, '$.toTier'),
            json_extract(transition.value, '$.candidateStartedWeekEnd'),
            json_extract(transition.value, '$.confirmedWeekEnd'),
            CAST(json_extract(transition.value, '$.rulesVersion') AS INTEGER),
            CAST(json_extract(transition.value, '$.longTermAttended') AS INTEGER),
            CAST(json_extract(transition.value, '$.longTermOpportunities') AS INTEGER),
            CAST(json_extract(transition.value, '$.longTermRate') AS REAL),
            CAST(json_extract(transition.value, '$.confirmationAttended') AS INTEGER),
            CAST(json_extract(transition.value, '$.confirmationOpportunities') AS INTEGER),
            CAST(json_extract(transition.value, '$.confirmationRate') AS REAL)
     FROM json_each(?) transition
     WHERE 1
     ON CONFLICT(church_id, individual_id, axis, from_tier, to_tier,
                 confirmed_week_end, rules_version)
     DO NOTHING`,
    [churchId, JSON.stringify(transitions)],
  );
}

function persistedTransition(individualId, axis, rulesVersion, transition) {
  return {
    individualId,
    axis,
    rulesVersion,
    fromTier: transition.fromTier,
    toTier: transition.toTier,
    candidateStartedWeekEnd: transition.candidateStartedWeekEnd,
    confirmedWeekEnd: transition.confirmedWeekEnd,
    longTermAttended: transition.longTermEvidence.attended,
    longTermOpportunities: transition.longTermEvidence.opportunities,
    longTermRate: transition.longTermEvidence.rate,
    confirmationAttended: transition.confirmationEvidence.attended,
    confirmationOpportunities: transition.confirmationEvidence.opportunities,
    confirmationRate: transition.confirmationEvidence.rate,
  };
}

async function evaluateEngagementTierConfirmations(churchId, {
  asOf = new Date(),
  baselineOnly = false,
} = {}) {
  if (!churchId) throw new Error('A church ID is required to evaluate tier confirmations.');

  const profiles = await calculateEngagementProfiles(churchId, { asOf });
  const completedWeekEnd = profiles.window.completedWeekEnd;
  const rulesVersion = profiles.settings.calculationRulesVersion;
  const groupedFacts = groupDatedOpportunities(profiles.datedOpportunities);
  const persisted = await Database.transactionForChurch(
    churchId,
    async (conn) => {
      const previousRows = await loadTierStates(conn, churchId);
      const previousByKey = new Map(
        previousRows.map((state) => [stateKey(state.individualId, state.axis), state]),
      );
      const states = [];
      const transitions = [];
      const evaluatedKeys = new Set();
      const outcomes = {
        baselined: 0,
        candidatesStarted: 0,
        candidatesCancelled: 0,
        candidatesExpired: 0,
      };

      for (const [individualId, profile] of profiles.current) {
        for (const axis of AXES) {
          evaluatedKeys.add(stateKey(individualId, axis));
          const calculatedEvidence = profile[axis];
          const previousState = previousByKey.get(stateKey(individualId, axis)) || null;
          const result = hasNewerStateVersion(previousState, rulesVersion, completedWeekEnd)
            ? { nextState: previousState, transition: null, outcome: 'unchanged' }
            : evaluateTierConfirmation({
              completedWeekEnd,
              rulesVersion,
              calculatedStatus: calculatedEvidence.status,
              calculatedEvidence,
              previousState: baselineOnly ? null : previousState,
              datedOpportunities: groupedFacts[axis].get(individualId) || [],
              settings: profiles.settings,
            });
          states.push({ individualId, axis, ...result.nextState });

          if (result.outcome === 'baseline') outcomes.baselined += 1;
          else if (result.outcome === 'started') outcomes.candidatesStarted += 1;
          else if (result.outcome === 'cancelled') outcomes.candidatesCancelled += 1;
          else if (result.outcome === 'expired') outcomes.candidatesExpired += 1;

          if (result.transition) {
            transitions.push(persistedTransition(
              individualId,
              axis,
              rulesVersion,
              result.transition,
            ));
          }
        }
      }

      for (const previousState of previousRows) {
        if (evaluatedKeys.has(stateKey(previousState.individualId, previousState.axis))) continue;
        const result = hasNewerStateVersion(previousState, rulesVersion, completedWeekEnd)
          ? { nextState: previousState }
          : evaluateTierConfirmation({
            completedWeekEnd,
            rulesVersion,
            calculatedStatus: 'not_assigned',
            calculatedEvidence: {
              status: 'not_assigned',
              attended: 0,
              opportunities: 0,
              rate: null,
            },
            previousState: baselineOnly ? null : previousState,
            datedOpportunities: [],
            settings: profiles.settings,
          });
        states.push({
          individualId: previousState.individualId,
          axis: previousState.axis,
          ...result.nextState,
        });
      }

      await upsertTierStates(conn, churchId, states);
      const inserted = await insertTransitions(conn, churchId, transitions);
      return { ...outcomes, transitionsConfirmed: inserted.affectedRows };
    },
  );

  return {
    completedWeekEnd,
    ...persisted,
  };
}

module.exports = { evaluateEngagementTierConfirmations };
