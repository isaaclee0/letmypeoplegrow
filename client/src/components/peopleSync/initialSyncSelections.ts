import type { PeopleSyncReview, PeopleSyncSelections } from './types';

// Only additive first activation can bypass the interactive review. The
// existing signed-token apply endpoint still validates the snapshot/choices.
export function initialSyncSelections(review: PeopleSyncReview): PeopleSyncSelections | null {
  if (review.authority?.active !== 'none' || review.decisionContractVersion !== 2) return null;
  const plan = review.plan;
  const context = plan.reviewContext;
  if (!context || context.version !== 2) return null;
  const blocked = ['linkPeople', 'linkFamilies', 'updateManagedFields', 'promoteToRegular',
    'demoteToLocalVisitor', 'archive', 'reactivate', 'moveFamily', 'renameFamily',
    'removeFromGathering', 'ambiguousPeople', 'familyConflicts', 'skipped'] as const;
  if (blocked.some((key) => !Array.isArray(plan[key]) || plan[key].length > 0)) return null;
  if (context.linkCorrections?.length || context.unreviewedSuggestedLinks?.length) return null;
  const identityDecisions: NonNullable<PeopleSyncSelections['identityDecisions']> = {};
  for (const [id, identity] of Object.entries(context.identities)) {
    if (identity.held || identity.suggestedIndividualId != null || identity.candidateIndividualIds.length
      || !identity.canCreate || !identity.createPerson) return null;
    identityDecisions[id] = { outcome: 'create' };
  }
  if (plan.addPeople.some((person) => !identityDecisions[person.externalPersonId])) return null;
  return { decisionContractVersion: 2, identityDecisions };
}
