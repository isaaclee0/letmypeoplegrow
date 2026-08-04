import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SyncReview from '../peopleSync/SyncReview';
import type { PeopleImportReview } from './types';
import type {
  IdentityReviewEntry,
  PeopleSyncPlan,
  PeopleSyncPlanSummary,
} from '../peopleSync/types';

const emptyBuckets = (): Omit<PeopleSyncPlan, 'provider' | 'authoritative' | 'snapshot'> => ({
  linkPeople: [], linkFamilies: [], addPeople: [], addFamilies: [], updateManagedFields: [],
  promoteToRegular: [], demoteToLocalVisitor: [], archive: [], reactivate: [], moveFamily: [],
  renameFamily: [], addToGathering: [], removeFromGathering: [], ambiguousPeople: [],
  familyConflicts: [], unmatchedLocalRegulars: [], skipped: [],
});

function reviewFixture(): PeopleImportReview {
  const identity: IdentityReviewEntry = {
    suggestedIndividualId: 7,
    candidateIndividualIds: [7],
    excludedIndividualIds: [],
    held: false,
    canCreate: true,
    createPerson: {
      firstName: 'Alex', lastName: 'Smith', isChild: false,
      externalFamilyId: null, peopleType: 'regular',
    },
  };
  const plan: PeopleImportReview['plan'] = {
    ...emptyBuckets(),
    provider: 'elvanto',
    authoritative: false,
    operationKind: 'people_import',
    snapshot: { fetchedAt: '2026-08-04T00:00:00.000Z', mode: 'full' },
    people: {
      external: {
        'ext-person': { firstName: 'Alex', lastName: 'Smith', family: { state: 'none' } },
        'ext-linked': { firstName: 'Linked', lastName: 'Source', family: { state: 'none' } },
      },
      local: {
        '7': { firstName: 'Alex', lastName: 'Smith', matchEligible: true, family: { state: 'none' } },
        '8': { firstName: 'Linked', lastName: 'Local', matchEligible: false, family: { state: 'none' } },
      },
    },
    reviewContext: {
      version: 2,
      correctionContractVersion: 1,
      manualCandidateIndividualIds: [7],
      identities: { 'ext-person': identity },
      establishedLinks: { 'ext-linked': { individualId: 8 } },
      projectedEstablishedLinks: { 'ext-linked': { individualId: 8 } },
      linkCorrections: [],
    },
    linkPeople: [{
      id: 'link:ext-person', externalPersonId: 'ext-person', individualId: 7,
      reason: 'unique_name', reviewRequired: false,
    }],
  };
  const summary = Object.fromEntries(
    Object.entries(plan)
      .filter(([key]) => !['provider', 'authoritative', 'operationKind', 'snapshot', 'people', 'reviewContext'].includes(key))
      .map(([key, value]) => [key, Array.isArray(value) ? value.length : 0]),
  ) as PeopleSyncPlanSummary;
  return {
    runId: 1,
    operationKind: 'people_import',
    selection: { kind: 'all' },
    reviewToken: 'import-review-token',
    decisionContractVersion: 2,
    summary,
    plan,
    snapshot: plan.snapshot,
  };
}

const handlers = {
  onRefresh: vi.fn(),
  onApply: vi.fn(),
  applying: false,
};

describe('people import review model', () => {
  it('uses import-only copy and hides established-link and sync-only controls', () => {
    const { container } = render(React.createElement(SyncReview, {
      operationKind: 'people_import',
      provider: 'elvanto',
      review: reviewFixture(),
      onPreviewCorrections: vi.fn(async () => reviewFixture()),
      ...handlers,
    }));

    expect(screen.getByRole('heading', { name: 'Import people' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply import' })).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/sync|archive|managed fields|correction/i);
    expect(screen.queryByText('Already linked (read-only)')).not.toBeInTheDocument();
  });

  it.each([
    'updateManagedFields',
    'promoteToRegular',
    'demoteToLocalVisitor',
    'archive',
    'reactivate',
    'moveFamily',
    'renameFamily',
    'addToGathering',
    'removeFromGathering',
    'unmatchedLocalRegulars',
  ] as const)('fails closed when the forbidden %s bucket is non-empty', (bucket) => {
    const review = reviewFixture();
    review.plan[bucket] = [{ id: `forbidden:${bucket}` }] as never;

    const { container } = render(React.createElement(SyncReview, {
      operationKind: 'people_import',
      provider: 'elvanto',
      review,
      ...handlers,
    }));

    expect(screen.getByRole('alert')).toHaveTextContent('could not be safely loaded');
    expect(screen.getByRole('button', { name: 'Apply import' })).toBeDisabled();
    expect(screen.queryByRole('table', { name: 'Identity decisions' })).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/sync|archive|managed fields|correction/i);
  });
});
