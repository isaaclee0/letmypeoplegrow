import type {
  IdentityDecision,
  PeopleSyncReview,
  PeopleSyncReviewContext,
  PeopleSyncSelections,
} from './types';

export type VisitorChoice = 'promote' | 'keep';

export interface SyncSelectionState {
  // Undefined keeps pre-v2 reviews on their established legacy payload.
  // V2 review state is initialized with every signed identity explicitly
  // present, using null until the reviewer makes a required decision.
  identityDecisions?: Record<string, IdentityDecision | null>;
  ambiguousChoices: Record<string, number | null>;
  skippedExternalIds: Set<string>;
  visitorChoices: Record<string, VisitorChoice | null>;
  acceptedArchiveIds: Set<number>;
  acceptedFamilyRenameIds: Set<string>;
}

function sortedKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).sort((left, right) => left.localeCompare(right));
}

function sortedRecord<T>(record: Record<string, T | null | undefined>): Record<string, T> {
  const entries: [string, T][] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value !== null && value !== undefined) entries.push([key, value]);
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

export function initializeIdentityDecisions(review: PeopleSyncReview): Record<string, IdentityDecision | null> {
  const reviewContext = review.plan.reviewContext;
  if (!reviewContext || review.decisionContractVersion !== 2) return {};

  const unmatchedAdditions = new Set(review.plan.addPeople.map((action) => action.externalPersonId));
  return Object.fromEntries(sortedKeys(reviewContext.identities).map((externalPersonId) => {
    const identity = reviewContext.identities[externalPersonId];
    if (identity.held) return [externalPersonId, null];
    if (identity.suggestedIndividualId !== null) return [externalPersonId, { outcome: 'accept' }];
    if (identity.canCreate && unmatchedAdditions.has(externalPersonId)) {
      return [externalPersonId, { outcome: 'create' }];
    }
    return [externalPersonId, null];
  }));
}

export function incompleteIdentityExternalIds(
  state: SyncSelectionState,
  reviewContext: PeopleSyncReviewContext | undefined,
): string[] {
  if (!reviewContext) return [];
  return sortedKeys(reviewContext.identities).filter((externalPersonId) =>
    state.identityDecisions?.[externalPersonId] === null ||
    state.identityDecisions?.[externalPersonId] === undefined
  );
}

function destructiveSelections(state: SyncSelectionState): Pick<
  PeopleSyncSelections,
  'acceptArchiveIndividualIds' | 'acceptFamilyRenameIds'
> {
  return {
    acceptArchiveIndividualIds: [...state.acceptedArchiveIds].sort((left, right) => left - right),
    acceptFamilyRenameIds: [...state.acceptedFamilyRenameIds].sort(),
  };
}

export function buildSyncSelections(state: SyncSelectionState): PeopleSyncSelections {
  if (state.identityDecisions !== undefined) {
    return {
      decisionContractVersion: 2,
      identityDecisions: sortedRecord(state.identityDecisions),
      ...destructiveSelections(state),
    };
  }
  return {
    ambiguous: sortedRecord(state.ambiguousChoices),
    skipExternalPersonIds: [...state.skippedExternalIds].sort(),
    visitorChoices: sortedRecord(state.visitorChoices),
    ...destructiveSelections(state),
  };
}
