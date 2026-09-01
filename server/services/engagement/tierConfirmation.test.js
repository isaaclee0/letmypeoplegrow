'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateTierConfirmation } = require('./tierConfirmation');

const settings = { coreMinimum: 60, casualMinimum: 20 };

function evidence(attended, opportunities) {
  return {
    attended,
    opportunities,
    rate: opportunities === 0 ? null : attended / opportunities,
  };
}

function fact(date, attended) {
  return { date, attended };
}

function weeklyFacts(startDate, count, attendedCount) {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + (index * 7));
    return fact(date.toISOString().slice(0, 10), index < attendedCount);
  });
}

function state(overrides = {}) {
  return {
    rulesVersion: 4,
    establishedTier: 'casual',
    candidateTier: null,
    candidateDirection: null,
    candidateStartedWeekEnd: null,
    candidateFinalWeekEnd: null,
    lastEvaluatedWeekEnd: '2026-05-31',
    ...overrides,
  };
}

function evaluate(overrides = {}) {
  return evaluateTierConfirmation({
    completedWeekEnd: '2026-06-07',
    rulesVersion: 4,
    calculatedStatus: 'casual',
    calculatedEvidence: evidence(3, 10),
    previousState: state(),
    datedOpportunities: [],
    settings,
    ...overrides,
  });
}

test('baselines a first classified result without creating a candidate', () => {
  const result = evaluate({ previousState: null, calculatedStatus: 'casual' });

  assert.deepEqual(result.nextState, {
    rulesVersion: 4,
    establishedTier: 'casual',
    candidateTier: null,
    candidateDirection: null,
    candidateStartedWeekEnd: null,
    candidateFinalWeekEnd: null,
    lastEvaluatedWeekEnd: '2026-06-07',
  });
  assert.equal(result.transition, null);
  assert.equal(result.outcome, 'baseline');
});

test('keeps ineligible first results unestablished and without a candidate', () => {
  for (const calculatedStatus of ['establishing', 'not_assigned']) {
    const result = evaluate({ previousState: null, calculatedStatus });
    assert.equal(result.nextState.establishedTier, null);
    assert.equal(result.nextState.candidateTier, null);
    assert.equal(result.outcome, 'ineligible');
  }
});

test('starts a candidate at zero evidence when the calculated tier crosses', () => {
  const result = evaluate({ calculatedStatus: 'core', calculatedEvidence: evidence(6, 10) });

  assert.deepEqual(result.nextState, {
    rulesVersion: 4,
    establishedTier: 'casual',
    candidateTier: 'core',
    candidateDirection: 'higher',
    candidateStartedWeekEnd: '2026-06-07',
    candidateFinalWeekEnd: '2026-09-06',
    lastEvaluatedWeekEnd: '2026-06-07',
  });
  assert.equal(result.transition, null);
  assert.equal(result.outcome, 'started');
});

test('excludes crossing-week opportunities from confirmation evidence', () => {
  const result = evaluate({
    completedWeekEnd: '2026-08-02',
    calculatedStatus: 'core',
    calculatedEvidence: evidence(6, 10),
    previousState: state({
      candidateTier: 'core',
      candidateDirection: 'higher',
      candidateStartedWeekEnd: '2026-06-07',
      candidateFinalWeekEnd: '2026-09-06',
      lastEvaluatedWeekEnd: '2026-06-07',
    }),
    datedOpportunities: [
      fact('2026-06-07', true),
      ...weeklyFacts('2026-06-08', 7, 7),
    ],
  });

  assert.equal(result.outcome, 'advanced');
  assert.equal(result.transition, null);
  assert.equal(result.nextState.candidateTier, 'core');
});

test('confirms an upward candidate on exactly the eighth supporting opportunity', () => {
  const result = evaluate({
    completedWeekEnd: '2026-08-02',
    calculatedStatus: 'core',
    calculatedEvidence: evidence(6, 10),
    previousState: state({
      candidateTier: 'core', candidateDirection: 'higher',
      candidateStartedWeekEnd: '2026-06-07', candidateFinalWeekEnd: '2026-09-06',
    }),
    datedOpportunities: weeklyFacts('2026-06-08', 8, 5),
  });

  assert.equal(result.outcome, 'confirmed');
  assert.deepEqual(result.nextState, state({ establishedTier: 'core', lastEvaluatedWeekEnd: '2026-08-02' }));
  assert.deepEqual(result.transition, {
    fromTier: 'casual',
    toTier: 'core',
    candidateStartedWeekEnd: '2026-06-07',
    confirmedWeekEnd: '2026-08-02',
    longTermEvidence: evidence(6, 10),
    confirmationEvidence: { status: 'core', attended: 5, opportunities: 8, rate: 0.625 },
  });
});

test('confirms a downward candidate on exactly the eighth supporting opportunity', () => {
  const result = evaluate({
    completedWeekEnd: '2026-08-02',
    calculatedStatus: 'casual',
    calculatedEvidence: evidence(3, 10),
    previousState: state({
      establishedTier: 'core', candidateTier: 'casual', candidateDirection: 'lower',
      candidateStartedWeekEnd: '2026-06-07', candidateFinalWeekEnd: '2026-09-06',
    }),
    datedOpportunities: weeklyFacts('2026-06-08', 8, 3),
  });

  assert.equal(result.outcome, 'confirmed');
  assert.equal(result.nextState.establishedTier, 'casual');
  assert.equal(result.transition.confirmationEvidence.status, 'casual');
});

test('retains an unsupported candidate after eight opportunities', () => {
  const result = evaluate({
    completedWeekEnd: '2026-08-02', calculatedStatus: 'core', calculatedEvidence: evidence(6, 10),
    previousState: state({ candidateTier: 'core', candidateDirection: 'higher', candidateStartedWeekEnd: '2026-06-07', candidateFinalWeekEnd: '2026-09-06' }),
    datedOpportunities: weeklyFacts('2026-06-08', 8, 4),
  });

  assert.equal(result.outcome, 'advanced');
  assert.equal(result.transition, null);
  assert.equal(result.nextState.candidateTier, 'core');
});

test('allows confirmation evidence farther in the candidate direction', () => {
  const result = evaluate({
    completedWeekEnd: '2026-08-02', calculatedStatus: 'casual', calculatedEvidence: evidence(3, 10),
    previousState: state({ establishedTier: 'core', candidateTier: 'casual', candidateDirection: 'lower', candidateStartedWeekEnd: '2026-06-07', candidateFinalWeekEnd: '2026-09-06' }),
    datedOpportunities: weeklyFacts('2026-06-08', 8, 1),
  });

  assert.equal(result.outcome, 'confirmed');
  assert.equal(result.nextState.establishedTier, 'casual');
  assert.equal(result.transition.confirmationEvidence.status, 'irregular');
});

test('rejects direct two-tier evidence that only reaches the intermediate tier', () => {
  const result = evaluate({
    completedWeekEnd: '2026-08-02', calculatedStatus: 'irregular', calculatedEvidence: evidence(1, 10),
    previousState: state({ establishedTier: 'core', candidateTier: 'irregular', candidateDirection: 'lower', candidateStartedWeekEnd: '2026-06-07', candidateFinalWeekEnd: '2026-09-06' }),
    datedOpportunities: weeklyFacts('2026-06-08', 8, 3),
  });

  assert.equal(result.outcome, 'advanced');
  assert.equal(result.transition, null);
});

test('cancels a candidate that returns to its established tier', () => {
  const result = evaluate({
    calculatedStatus: 'casual',
    previousState: state({ candidateTier: 'core', candidateDirection: 'higher', candidateStartedWeekEnd: '2026-05-31', candidateFinalWeekEnd: '2026-08-30' }),
  });

  assert.equal(result.outcome, 'cancelled');
  assert.deepEqual(result.nextState, state({ lastEvaluatedWeekEnd: '2026-06-07' }));
});

test('restarts from zero evidence when the calculated target changes', () => {
  const result = evaluate({
    calculatedStatus: 'irregular', calculatedEvidence: evidence(1, 10),
    previousState: state({ establishedTier: 'core', candidateTier: 'casual', candidateDirection: 'lower', candidateStartedWeekEnd: '2026-05-31', candidateFinalWeekEnd: '2026-08-30' }),
  });

  assert.equal(result.outcome, 'started');
  assert.deepEqual(result.nextState, state({
    establishedTier: 'core', candidateTier: 'irregular', candidateDirection: 'lower',
    candidateStartedWeekEnd: '2026-06-07', candidateFinalWeekEnd: '2026-09-06',
    lastEvaluatedWeekEnd: '2026-06-07',
  }));
});

test('clears a candidate and established tier when calculated status becomes ineligible', () => {
  const result = evaluate({
    calculatedStatus: 'not_assigned',
    previousState: state({ candidateTier: 'core', candidateDirection: 'higher', candidateStartedWeekEnd: '2026-05-31', candidateFinalWeekEnd: '2026-08-30' }),
  });

  assert.equal(result.outcome, 'ineligible');
  assert.deepEqual(result.nextState, state({ establishedTier: null, lastEvaluatedWeekEnd: '2026-06-07' }));
});

test('expires an unsupported candidate at its thirteenth eligible completed week', () => {
  const result = evaluate({
    completedWeekEnd: '2026-09-06', calculatedStatus: 'core', calculatedEvidence: evidence(6, 10),
    previousState: state({ candidateTier: 'core', candidateDirection: 'higher', candidateStartedWeekEnd: '2026-06-07', candidateFinalWeekEnd: '2026-09-06' }),
    datedOpportunities: weeklyFacts('2026-06-08', 8, 4),
  });

  assert.equal(result.outcome, 'expired');
  assert.deepEqual(result.nextState, state({ lastEvaluatedWeekEnd: '2026-09-06' }));
});

test('expires a missed-boundary candidate without using late facts to confirm it', () => {
  const result = evaluate({
    completedWeekEnd: '2026-09-13', calculatedStatus: 'core', calculatedEvidence: evidence(6, 10),
    previousState: state({ candidateTier: 'core', candidateDirection: 'higher', candidateStartedWeekEnd: '2026-06-07', candidateFinalWeekEnd: '2026-09-06' }),
    datedOpportunities: Array.from({ length: 8 }, () => fact('2026-09-08', true)),
  });

  assert.equal(result.outcome, 'expired');
  assert.equal(result.transition, null);
  assert.deepEqual(result.nextState, state({ lastEvaluatedWeekEnd: '2026-09-13' }));
});

test('expires a missed-boundary candidate before a target change can restart it', () => {
  const result = evaluate({
    completedWeekEnd: '2026-09-13', calculatedStatus: 'irregular', calculatedEvidence: evidence(1, 10),
    previousState: state({ candidateTier: 'core', candidateDirection: 'higher', candidateStartedWeekEnd: '2026-06-07', candidateFinalWeekEnd: '2026-09-06' }),
  });

  assert.equal(result.outcome, 'expired');
  assert.equal(result.transition, null);
  assert.deepEqual(result.nextState, state({ lastEvaluatedWeekEnd: '2026-09-13' }));
});

test('allows a later completed week to restart after expiry', () => {
  const result = evaluate({
    completedWeekEnd: '2026-09-13', calculatedStatus: 'core', calculatedEvidence: evidence(6, 10),
    previousState: state({ lastEvaluatedWeekEnd: '2026-09-06' }),
  });

  assert.equal(result.outcome, 'started');
  assert.equal(result.nextState.candidateStartedWeekEnd, '2026-09-13');
});

test('rebaselines on a rules version change without inferring a transition', () => {
  const result = evaluate({ rulesVersion: 5, calculatedStatus: 'core', calculatedEvidence: evidence(6, 10) });

  assert.equal(result.outcome, 'baseline');
  assert.deepEqual(result.nextState, {
    rulesVersion: 5,
    establishedTier: 'core',
    candidateTier: null,
    candidateDirection: null,
    candidateStartedWeekEnd: null,
    candidateFinalWeekEnd: null,
    lastEvaluatedWeekEnd: '2026-06-07',
  });
  assert.equal(result.transition, null);
});

test('rebaselines a changed rules version even for an already evaluated week', () => {
  const result = evaluate({
    completedWeekEnd: '2026-06-07',
    rulesVersion: 5,
    calculatedStatus: 'core',
    previousState: state({ lastEvaluatedWeekEnd: '2026-06-07' }),
  });

  assert.equal(result.outcome, 'baseline');
  assert.equal(result.nextState.rulesVersion, 5);
  assert.equal(result.nextState.establishedTier, 'core');
});

test('is idempotent for an already evaluated completed week', () => {
  const previousState = state({
    candidateTier: 'core', candidateDirection: 'higher',
    candidateStartedWeekEnd: '2026-06-07', candidateFinalWeekEnd: '2026-09-06',
    lastEvaluatedWeekEnd: '2026-06-14',
  });
  const result = evaluate({
    completedWeekEnd: '2026-06-14', calculatedStatus: 'core', previousState,
    datedOpportunities: weeklyFacts('2026-06-08', 8, 8),
  });

  assert.deepEqual(result.nextState, previousState);
  assert.equal(result.transition, null);
  assert.equal(result.outcome, 'unchanged');
});
