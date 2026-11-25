import { describe, expect, it } from 'vitest';
import { automaticChanges, buildDecisionGroups, initialChoices, toSelections } from './syncDecisionModel';
import type { PeopleSyncPlan, PeopleSyncReview } from './types';

function fixture(): PeopleSyncReview {
  const plan: PeopleSyncPlan = {
    provider: 'planning_center', authoritative: true, snapshot: { mode: 'full', fetchedAt: null },
    linkPeople: [], linkFamilies: [], addPeople: [], addFamilies: [], updateManagedFields: [],
    promoteToRegular: [], demoteToLocalVisitor: [], reactivate: [], moveFamily: [], addToGathering: [],
    ambiguousPeople: [], unmatchedLocalRegulars: [], skipped: [],
    archive: [
      { id: 'archive:1', externalPersonId: 'p1', individualId: 1, reason: 'provider_state_archived', automatic: true },
      { id: 'archive:3', externalPersonId: 'p3', individualId: 3, reason: 'outside_all_sync_sources' },
    ],
    familyConflicts: [{ id: 'family:2', automatic: true, memberExternalIds: ['p2'],
      resolution: { kind: 'single_person', destination: { kind: 'create', familyName: 'Test Person' },
        moves: [{ externalPersonId: 'p2', individualId: 2, fromFamilyId: 10 }] } }],
    renameFamily: [{ id: 'rename:12', familyId: 12, familyName: 'Provider family', automatic: true }],
    removeFromGathering: [{ id: 'remove:2', batchId: null, gatheringTypeId: 2, gatheringName: 'PM',
      individualId: 2, externalPersonId: 'p2', reason: 'legacy_roster_not_in_source', reviewRequired: true, automatic: true }],
    reviewContext: { version: 2, identities: {}, manualCandidateIndividualIds: [] },
    people: { external: {}, local: {
      '1': { firstName: 'Inactive', lastName: 'Person' },
      '2': { firstName: 'Test', lastName: 'Person' },
      '3': { firstName: 'Outside', lastName: 'Person' },
    } },
  };
  return { runId: 1, reviewToken: 'token', decisionContractVersion: 2, plan, snapshot: plan.snapshot,
    summary: Object.fromEntries(Object.entries(plan).filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => [key, (value as unknown[]).length])) as PeopleSyncReview['summary'] };
}

describe('automatic Planning Center changes in the decision list', () => {
  it('shows automatic actions as included updates without submitting manual acceptances', () => {
    const review = fixture();
    const groups = buildDecisionGroups(review);
    expect(groups.flatMap(group => group.decisions.map(decision => decision.kind))).toEqual(['outsideSourceMatch']);
    expect(automaticChanges(review).map(change => change.label)).toEqual([
      'removed from attendance lists', 'archived to match Planning Center', 'households updated', 'families renamed',
    ]);
    const selections = toSelections(review, groups, initialChoices(groups));
    expect(selections.acceptArchiveIndividualIds).toEqual([]);
    expect(selections.acceptFamilyResolutionIds || []).toEqual([]);
    expect(selections.acceptGatheringRemovalIds || []).toEqual([]);
  });

  it('keeps unresolved households visible when the plan also has automatic actions', () => {
    const review = fixture();
    review.plan.familyConflicts.push({ id: 'unknown', reason: 'unknown_household_membership', memberExternalIds: ['p4'] });
    const decisions = buildDecisionGroups(review).flatMap(group => group.decisions);
    expect(decisions.find(decision => decision.actionId === 'unknown')).toMatchObject({ kind: 'household', needsInfo: true, recommended: null });
  });

  it('includes an automatic family link in changes available to apply', () => {
    const review = fixture();
    review.plan.linkFamilies = [{ id: 'link-family', externalFamilyId: 'household', familyId: 10, automatic: true }];
    expect(automaticChanges(review).find(change => change.label === 'families linked')?.names).toHaveLength(1);
  });
});
