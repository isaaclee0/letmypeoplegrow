'use strict';

const {
  classifyEvidence,
  evidenceSupportsCandidate,
  isClassifiedTier,
  tierDirection,
} = require('./tiers');

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function emptyCandidate() {
  return {
    candidateTier: null,
    candidateDirection: null,
    candidateStartedWeekEnd: null,
    candidateFinalWeekEnd: null,
  };
}

function nextState({ rulesVersion, establishedTier, completedWeekEnd, candidate = emptyCandidate() }) {
  return {
    rulesVersion,
    establishedTier,
    ...candidate,
    lastEvaluatedWeekEnd: completedWeekEnd,
  };
}

function startCandidate({ rulesVersion, establishedTier, candidateTier, completedWeekEnd }) {
  return nextState({
    rulesVersion,
    establishedTier,
    completedWeekEnd,
    candidate: {
      candidateTier,
      candidateDirection: tierDirection(establishedTier, candidateTier),
      candidateStartedWeekEnd: completedWeekEnd,
      candidateFinalWeekEnd: addDays(completedWeekEnd, 91),
    },
  });
}

function confirmationEvidence(datedOpportunities, candidateStartedWeekEnd, completedWeekEnd, settings) {
  let attended = 0;
  let opportunities = 0;
  for (const opportunity of datedOpportunities || []) {
    if (opportunity?.date > candidateStartedWeekEnd && opportunity.date <= completedWeekEnd) {
      opportunities += 1;
      if (opportunity.attended) attended += 1;
    }
  }
  return classifyEvidence({ assigned: true, attended, opportunities }, settings);
}

function baseline({ rulesVersion, completedWeekEnd, calculatedStatus }) {
  return nextState({
    rulesVersion,
    establishedTier: isClassifiedTier(calculatedStatus) ? calculatedStatus : null,
    completedWeekEnd,
  });
}

function evaluateTierConfirmation({
  completedWeekEnd,
  rulesVersion,
  calculatedStatus,
  calculatedEvidence,
  previousState,
  datedOpportunities,
  settings,
}) {
  const calculatedTier = isClassifiedTier(calculatedStatus) ? calculatedStatus : null;
  if (!previousState || previousState.rulesVersion !== rulesVersion) {
    return {
      nextState: baseline({ rulesVersion, completedWeekEnd, calculatedStatus }),
      transition: null,
      outcome: calculatedTier ? 'baseline' : 'ineligible',
    };
  }

  if (previousState.lastEvaluatedWeekEnd >= completedWeekEnd) {
    return { nextState: previousState, transition: null, outcome: 'unchanged' };
  }

  if (!calculatedTier) {
    return {
      nextState: nextState({ rulesVersion, establishedTier: null, completedWeekEnd }),
      transition: null,
      outcome: 'ineligible',
    };
  }

  if (!isClassifiedTier(previousState.establishedTier)) {
    return {
      nextState: baseline({ rulesVersion, completedWeekEnd, calculatedStatus }),
      transition: null,
      outcome: 'baseline',
    };
  }

  const candidate = previousState.candidateTier;
  if (!candidate) {
    if (calculatedTier === previousState.establishedTier) {
      return {
        nextState: nextState({
          rulesVersion,
          establishedTier: previousState.establishedTier,
          completedWeekEnd,
        }),
        transition: null,
        outcome: 'unchanged',
      };
    }
    return {
      nextState: startCandidate({
        rulesVersion,
        establishedTier: previousState.establishedTier,
        candidateTier: calculatedTier,
        completedWeekEnd,
      }),
      transition: null,
      outcome: 'started',
    };
  }

  if (calculatedTier === previousState.establishedTier) {
    return {
      nextState: nextState({
        rulesVersion,
        establishedTier: previousState.establishedTier,
        completedWeekEnd,
      }),
      transition: null,
      outcome: 'cancelled',
    };
  }

  if (calculatedTier !== candidate) {
    return {
      nextState: startCandidate({
        rulesVersion,
        establishedTier: previousState.establishedTier,
        candidateTier: calculatedTier,
        completedWeekEnd,
      }),
      transition: null,
      outcome: 'started',
    };
  }

  const evidence = confirmationEvidence(
    datedOpportunities,
    previousState.candidateStartedWeekEnd,
    completedWeekEnd,
    settings,
  );
  if (evidenceSupportsCandidate({
    establishedTier: previousState.establishedTier,
    candidateTier: previousState.candidateTier,
    evidenceTier: evidence.status,
  })) {
    return {
      nextState: nextState({
        rulesVersion,
        establishedTier: previousState.candidateTier,
        completedWeekEnd,
      }),
      transition: {
        fromTier: previousState.establishedTier,
        toTier: previousState.candidateTier,
        candidateStartedWeekEnd: previousState.candidateStartedWeekEnd,
        confirmedWeekEnd: completedWeekEnd,
        longTermEvidence: calculatedEvidence,
        confirmationEvidence: evidence,
      },
      outcome: 'confirmed',
    };
  }

  if (completedWeekEnd >= previousState.candidateFinalWeekEnd) {
    return {
      nextState: nextState({
        rulesVersion,
        establishedTier: previousState.establishedTier,
        completedWeekEnd,
      }),
      transition: null,
      outcome: 'expired',
    };
  }

  return {
    nextState: nextState({
      rulesVersion,
      establishedTier: previousState.establishedTier,
      completedWeekEnd,
      candidate: {
        candidateTier: previousState.candidateTier,
        candidateDirection: previousState.candidateDirection,
        candidateStartedWeekEnd: previousState.candidateStartedWeekEnd,
        candidateFinalWeekEnd: previousState.candidateFinalWeekEnd,
      },
    }),
    transition: null,
    outcome: 'advanced',
  };
}

module.exports = { evaluateTierConfirmation };
