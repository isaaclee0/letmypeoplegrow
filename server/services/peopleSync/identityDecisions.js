'use strict';

const OUTCOMES = new Set(['accept', 'link', 'create', 'defer']);
const ALLOWED_FIELDS = {
  accept: new Set(['outcome']),
  link: new Set(['outcome', 'individualId', 'excludeIndividualId']),
  create: new Set(['outcome', 'excludeIndividualId']),
  defer: new Set(['outcome', 'excludeIndividualId']),
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a valid positive integer ID`);
  }
  return value;
}

function validateDestructiveSelections(plan, selections, claimedIndividualIds = new Set()) {
  const unmatchedLocalIds = new Set(asArray(plan.unmatchedLocalRegulars).map((action) => action.individualId));
  const renameById = new Map(asArray(plan.renameFamily).map((action) => [action.id, action]));

  const acceptedArchiveIndividualIds = new Set();
  for (const rawIndividualId of asArray(selections.acceptArchiveIndividualIds)) {
    const individualId = Number(rawIndividualId);
    if (!Number.isSafeInteger(individualId) || individualId <= 0) {
      throw new Error('Archive selection individual ID must be a valid positive integer ID');
    }
    const inAmbiguousCandidates = asArray(plan.ambiguousPeople)
      .some((action) => (action.candidateIndividualIds || []).includes(individualId));
    if (!unmatchedLocalIds.has(individualId) && !inAmbiguousCandidates) {
      throw new Error(`Cannot archive an individual not surfaced for review in this plan: ${individualId}`);
    }
    if (claimedIndividualIds.has(individualId)) {
      throw new Error(`Archive selection for ${individualId} collides with an accepted link`);
    }
    acceptedArchiveIndividualIds.add(individualId);
  }

  const acceptedFamilyRenameIds = new Set();
  for (const actionId of asArray(selections.acceptFamilyRenameIds)) {
    if (!renameById.has(actionId)) {
      throw new Error(`Cannot accept a family rename not offered in this plan: ${actionId}`);
    }
    acceptedFamilyRenameIds.add(actionId);
  }

  return { acceptedArchiveIndividualIds, acceptedFamilyRenameIds };
}

function validateDecisionFields(externalPersonId, decision) {
  const record = asRecord(decision);
  if (!record) throw new Error(`Identity decision for ${externalPersonId} must be an object`);
  if (!OUTCOMES.has(record.outcome)) {
    throw new Error(`Unsupported identity outcome for ${externalPersonId}: ${record.outcome}`);
  }
  const allowed = ALLOWED_FIELDS[record.outcome];
  if (Object.keys(record).some((field) => !allowed.has(field))) {
    throw new Error(`Identity decision for ${externalPersonId} has invalid fields for outcome "${record.outcome}"`);
  }
  return record;
}

function normalizeAndValidate(plan, context, rawDecisions, selections) {
  const decisions = asRecord(rawDecisions);
  if (!decisions) throw new Error('Identity decisions must be an object');

  const identities = asRecord(context.identities);
  if (!identities) throw new Error('This plan has an invalid identity review context');

  const contextExternalIds = Object.keys(identities).sort();
  for (const externalPersonId of Object.keys(decisions)) {
    if (!Object.hasOwn(identities, externalPersonId)) {
      throw new Error(`Identity decision references an external person not present in this plan: ${externalPersonId}`);
    }
  }
  for (const externalPersonId of contextExternalIds) {
    if (!Object.hasOwn(decisions, externalPersonId)) {
      throw new Error(`An identity decision is required for ${externalPersonId}`);
    }
  }

  const manualCandidates = new Set(asArray(context.manualCandidateIndividualIds));
  const addExternalIds = new Set(asArray(plan.addPeople).map((action) => action.externalPersonId));
  const claimedIndividualIds = new Set();
  const linkActions = [];
  const createExternalIds = new Set();
  const deferredReasons = new Map();
  const exclusionsToAdd = [];
  const exclusionsToRemove = [];
  const skippedAddExternalIds = new Set();
  const suppressedSuggestedPairs = [];

  for (const externalPersonId of contextExternalIds) {
    const entry = asRecord(identities[externalPersonId]);
    if (!entry) throw new Error(`Identity review context for ${externalPersonId} must be an object`);
    const decision = validateDecisionFields(externalPersonId, decisions[externalPersonId]);
    const suggestedIndividualId = entry.suggestedIndividualId;
    let acceptedIndividualId = null;
    let linkSource = null;

    if (decision.outcome === 'accept') {
      if (!Number.isSafeInteger(suggestedIndividualId) || suggestedIndividualId <= 0) {
        throw new Error(`Identity ${externalPersonId} has no suggested individual to accept`);
      }
      acceptedIndividualId = suggestedIndividualId;
      linkSource = 'matched';
    } else if (decision.outcome === 'link') {
      acceptedIndividualId = positiveInteger(
        decision.individualId,
        `Link individual ID for ${externalPersonId}`
      );
      if (!manualCandidates.has(acceptedIndividualId)) {
        throw new Error(`Link individual ID for ${externalPersonId} must be one of this plan's manual candidates`);
      }
      linkSource = 'manual';
    } else if (decision.outcome === 'create') {
      if (entry.canCreate !== true) throw new Error(`Identity ${externalPersonId} cannot be created`);
      if (!asRecord(entry.createPerson)) {
        throw new Error(`Identity ${externalPersonId} is missing signed create data`);
      }
      createExternalIds.add(externalPersonId);
    } else {
      deferredReasons.set(
        externalPersonId,
        Object.hasOwn(decision, 'excludeIndividualId') ? 'pair_rejected' : 'deferred'
      );
    }

    if (acceptedIndividualId !== null) {
      if (claimedIndividualIds.has(acceptedIndividualId)) {
        throw new Error(`Individual ${acceptedIndividualId} is already claimed by another identity decision`);
      }
      claimedIndividualIds.add(acceptedIndividualId);
      linkActions.push({ externalPersonId, individualId: acceptedIndividualId, linkSource });
      if (asArray(entry.excludedIndividualIds).includes(acceptedIndividualId)) {
        exclusionsToRemove.push({ externalPersonId, individualId: acceptedIndividualId });
      }
    }

    if (Object.hasOwn(decision, 'excludeIndividualId')) {
      const excludedIndividualId = positiveInteger(
        decision.excludeIndividualId,
        `Exclusion individual ID for ${externalPersonId}`
      );
      if (!asArray(entry.candidateIndividualIds).includes(excludedIndividualId)) {
        throw new Error(`Exclusion for ${externalPersonId} must reference a candidate exposed for that identity`);
      }
      if (excludedIndividualId === acceptedIndividualId) {
        throw new Error(`Identity ${externalPersonId} cannot exclude its accepted target`);
      }
      exclusionsToAdd.push({ externalPersonId, individualId: excludedIndividualId });
    }

    const suggestionWasRejected = Number.isSafeInteger(suggestedIndividualId) &&
      suggestedIndividualId > 0 &&
      acceptedIndividualId !== suggestedIndividualId;
    if (suggestionWasRejected) {
      suppressedSuggestedPairs.push({ externalPersonId, suggestedIndividualId });
    }

    if (addExternalIds.has(externalPersonId) && decision.outcome !== 'create') {
      skippedAddExternalIds.add(externalPersonId);
    }
  }

  const destructive = validateDestructiveSelections(plan, selections, claimedIndividualIds);
  return {
    contractVersion: 2,
    linkActions,
    createExternalIds,
    deferredReasons,
    exclusionsToAdd,
    exclusionsToRemove,
    skippedAddExternalIds,
    suppressedSuggestedPairs,
    ...destructive,
  };
}

function validateIdentityDecisions(plan, selections) {
  if (!plan || typeof plan !== 'object') {
    throw new Error('A plan is required to validate identity decisions against');
  }
  if (selections?.decisionContractVersion !== 2) {
    throw new Error('Unsupported identity decision contract version');
  }
  const context = plan.reviewContext;
  if (!context || context.version !== 2) {
    throw new Error('This plan does not support identity decisions');
  }
  return normalizeAndValidate(plan, context, selections.identityDecisions, selections);
}

module.exports = {
  validateDestructiveSelections,
  validateIdentityDecisions,
};
