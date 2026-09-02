'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateProfileWeek } = require('./tierConfirmationEvaluator');

const settings = { coreMinimum: 60, casualMinimum: 20 };

function profiles(completedWeekEnd, primaryStatus) {
  return {
    window: { completedWeekEnd },
    settings: { ...settings, calculationRulesVersion: 1 },
    current: new Map([[7, {
      primary: { status: primaryStatus, attended: primaryStatus === 'core' ? 8 : 4, opportunities: 10, rate: primaryStatus === 'core' ? 0.8 : 0.4 },
      community: { status: 'not_assigned', attended: 0, opportunities: 0, rate: null },
    }]]),
    datedOpportunities: { primary: [], community: [] },
  };
}

test('evaluateProfileWeek reduces chronological profiles without mutating prior states', () => {
  const first = evaluateProfileWeek({ profiles: profiles('2026-01-04', 'core'), previousStates: [] });
  const snapshot = structuredClone(first.states);
  const second = evaluateProfileWeek({ profiles: profiles('2026-01-11', 'casual'), previousStates: first.states });

  assert.deepEqual(first.states, snapshot);
  assert.equal(first.outcomes.baselined, 1);
  assert.equal(second.outcomes.candidatesStarted, 1);
  assert.deepEqual(second.states.find((state) => state.axis === 'primary'), {
    individualId: 7,
    axis: 'primary',
    rulesVersion: 1,
    establishedTier: 'core',
    candidateTier: 'casual',
    candidateDirection: 'lower',
    candidateStartedWeekEnd: '2026-01-11',
    candidateFinalWeekEnd: '2026-04-12',
    lastEvaluatedWeekEnd: '2026-01-11',
  });
});
