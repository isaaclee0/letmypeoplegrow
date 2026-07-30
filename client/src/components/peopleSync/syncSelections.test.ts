import { describe, expect, it } from 'vitest';
import {
  buildSyncSelections,
  incompleteIdentityExternalIds,
  initializeIdentityDecisions,
} from './syncSelections';
import type { PeopleSyncPlan, PeopleSyncPlanSummary, PeopleSyncReview } from './types';

function reviewWithIdentityContext(): PeopleSyncReview {
  const plan: PeopleSyncPlan = {
    provider: 'elvanto',
    authoritative: false,
    snapshot: { fetchedAt: null, mode: 'full' },
    reviewContext: {
      version: 2,
      manualCandidateIndividualIds: [11, 12],
      identities: {
        'ext-accept': {
          suggestedIndividualId: 10,
          candidateIndividualIds: [10],
          excludedIndividualIds: [],
          held: false,
          canCreate: true,
          createPerson: null,
        },
        'ext-create': {
          suggestedIndividualId: null,
          candidateIndividualIds: [],
          excludedIndividualIds: [],
          held: false,
          canCreate: true,
          createPerson: null,
        },
        'ext-held': {
          suggestedIndividualId: 11,
          candidateIndividualIds: [11],
          excludedIndividualIds: [],
          held: true,
          canCreate: true,
          createPerson: null,
        },
        'ext-ambiguous': {
          suggestedIndividualId: null,
          candidateIndividualIds: [11, 12],
          excludedIndividualIds: [],
          held: false,
          canCreate: true,
          createPerson: null,
        },
      },
    },
    linkPeople: [],
    linkFamilies: [],
    addPeople: [{
      id: 'addPeople:ext-create',
      externalPersonId: 'ext-create',
      firstName: 'New',
      lastName: 'Person',
      isChild: null,
      familyId: null,
      peopleType: 'regular',
      reason: 'unmatched',
      reviewRequired: true,
    }],
    addFamilies: [],
    updateManagedFields: [],
    promoteToRegular: [],
    demoteToLocalVisitor: [],
    archive: [],
    reactivate: [],
    moveFamily: [],
    renameFamily: [],
    addToGathering: [],
    removeFromGathering: [],
    ambiguousPeople: [],
    familyConflicts: [],
    unmatchedLocalRegulars: [],
    skipped: [],
  };
  const summary: PeopleSyncPlanSummary = {
    linkPeople: 0,
    linkFamilies: 0,
    addPeople: 1,
    addFamilies: 0,
    updateManagedFields: 0,
    promoteToRegular: 0,
    demoteToLocalVisitor: 0,
    archive: 0,
    reactivate: 0,
    moveFamily: 0,
    renameFamily: 0,
    addToGathering: 0,
    removeFromGathering: 0,
    ambiguousPeople: 0,
    familyConflicts: 0,
    unmatchedLocalRegulars: 0,
    skipped: 0,
  };
  return {
    runId: 1,
    reviewToken: 'review-token',
    decisionContractVersion: 2,
    summary,
    plan,
    snapshot: plan.snapshot,
  };
}

describe('buildSyncSelections', () => {
  it('serializes each v2 identity outcome and destructive selections in stable order', () => {
    expect(buildSyncSelections({
      identityDecisions: {
        'ext-4': { outcome: 'defer' },
        'ext-2': { outcome: 'link', individualId: 12, excludeIndividualId: 11 },
        'ext-3': { outcome: 'create' },
        'ext-1': { outcome: 'accept' },
      },
      ambiguousChoices: {},
      skippedExternalIds: new Set(),
      visitorChoices: {},
      acceptedArchiveIds: new Set([9]),
      acceptedFamilyRenameIds: new Set(['renameFamily:4']),
    })).toEqual({
      decisionContractVersion: 2,
      identityDecisions: {
        'ext-1': { outcome: 'accept' },
        'ext-2': { outcome: 'link', individualId: 12, excludeIndividualId: 11 },
        'ext-3': { outcome: 'create' },
        'ext-4': { outcome: 'defer' },
      },
      acceptArchiveIndividualIds: [9],
      acceptFamilyRenameIds: ['renameFamily:4'],
    });
  });

  it('defaults deterministic suggestions and unmatched additions without deciding held or ambiguous identities', () => {
    const review = reviewWithIdentityContext();
    const decisions = initializeIdentityDecisions(review);

    expect(decisions).toEqual({
      'ext-accept': { outcome: 'accept' },
      'ext-ambiguous': null,
      'ext-create': { outcome: 'create' },
      'ext-held': null,
    });
    expect(incompleteIdentityExternalIds({
      identityDecisions: decisions,
      ambiguousChoices: {},
      skippedExternalIds: new Set(),
      visitorChoices: {},
      acceptedArchiveIds: new Set(),
      acceptedFamilyRenameIds: new Set(),
    }, review.plan.reviewContext)).toEqual(['ext-ambiguous', 'ext-held']);
  });

  it('serializes only reviewer decisions into a deterministic apply payload', () => {
    expect(buildSyncSelections({
      ambiguousChoices: { ext2: null, ext1: 7 },
      skippedExternalIds: new Set(['ext3', 'ext0']),
      visitorChoices: { ext5: null, ext4: 'promote' },
      acceptedArchiveIds: new Set([10, 2]),
      acceptedFamilyRenameIds: new Set(['renameFamily:20', 'renameFamily:3']),
    })).toEqual({
      ambiguous: { ext1: 7 },
      skipExternalPersonIds: ['ext0', 'ext3'],
      visitorChoices: { ext4: 'promote' },
      acceptArchiveIndividualIds: [2, 10],
      acceptFamilyRenameIds: ['renameFamily:20', 'renameFamily:3'],
    });
  });
});
