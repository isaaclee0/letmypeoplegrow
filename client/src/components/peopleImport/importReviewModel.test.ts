import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import SyncReview from '../peopleSync/SyncReview';
import type { PeopleImportReview } from './types';
import type {
  IdentityReviewEntry,
  PeopleReviewToken,
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
    reviewToken: 'import-review-token' as PeopleReviewToken<'people_import'>,
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

  it.each([
    ['missing top-level marker', (review: PeopleImportReview) => {
      delete (review as Partial<PeopleImportReview>).operationKind;
    }],
    ['missing plan marker', (review: PeopleImportReview) => {
      delete (review.plan as Partial<PeopleImportReview['plan']>).operationKind;
    }],
    ['wrong top-level marker', (review: PeopleImportReview) => {
      (review as { operationKind: string }).operationKind = 'people_sync';
    }],
    ['wrong plan marker', (review: PeopleImportReview) => {
      (review.plan as { operationKind: string }).operationKind = 'authority_switch';
    }],
  ] as const)('fails closed for an import review with a %s', (_label, mutate) => {
    const review = reviewFixture();
    mutate(review);
    const { container } = render(React.createElement(SyncReview, {
      operationKind: 'people_import',
      provider: 'elvanto',
      review,
      ...handlers,
    } as never));

    expect(screen.getByRole('alert')).toHaveTextContent('could not be safely loaded');
    expect(screen.queryByRole('button', { name: 'Apply import' })).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Identity decisions' })).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/sync|archive|managed fields|correction/i);
  });

  it.each(['people_sync', 'authority_switch'] as const)(
    'rejects an import-marked review rendered as %s',
    (operationKind) => {
      const review = reviewFixture();
      const { container } = render(React.createElement(SyncReview, {
        operationKind,
        provider: 'elvanto',
        review,
        ...handlers,
      } as never));

      expect(screen.getByRole('alert')).toHaveTextContent('could not be safely loaded');
      expect(screen.queryByRole('button', { name: /Apply/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('table', { name: 'Identity decisions' })).not.toBeInTheDocument();
      expect(container).not.toHaveTextContent(/sync|authority|identity|famil|skipped|lifecycle|correction|apply/i);
    },
  );

  it.each(['people_sync', 'authority_switch'] as const)(
    'rejects a %s-marked review rendered as a people import',
    (reviewKind) => {
      const review = reviewFixture();
      (review as { operationKind: string }).operationKind = reviewKind;
      (review.plan as { operationKind: string }).operationKind = reviewKind;
      const { container } = render(React.createElement(SyncReview, {
        operationKind: 'people_import',
        provider: 'elvanto',
        review,
        ...handlers,
      } as never));

      expect(screen.getByRole('alert')).toHaveTextContent('could not be safely loaded');
      expect(screen.queryByRole('button', { name: /Apply/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('table', { name: 'Identity decisions' })).not.toBeInTheDocument();
      expect(container).not.toHaveTextContent(/sync|authority|identity|famil|skipped|lifecycle|correction|apply/i);
    },
  );

  it('passes the import review token only through the import callback', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(React.createElement(SyncReview, {
      operationKind: 'people_import',
      provider: 'elvanto',
      review: reviewFixture(),
      ...handlers,
      onApply,
    }));

    await user.click(screen.getByRole('button', { name: 'Apply import' }));
    expect(onApply).toHaveBeenCalledWith('import-review-token', expect.any(Object));
  });

  it.each([
    ['SYNC_PLAN_STALE', 'This import review is out of date.'],
    ['SYNC_REVIEW_EXPIRED', 'This import review has expired.'],
  ] as const)('uses curated import copy for refresh-only %s errors', async (code, expected) => {
    const user = userEvent.setup();
    const raw = 'Refresh before applying another sync correction with archive managed fields.';
    const onApply = vi.fn().mockRejectedValue({ response: { data: { code, error: raw } } });
    const { container } = render(React.createElement(SyncReview, {
      operationKind: 'people_import',
      provider: 'elvanto',
      review: reviewFixture(),
      ...handlers,
      onApply,
    }));

    await user.click(screen.getByRole('button', { name: 'Apply import' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(expected);
    expect(container).not.toHaveTextContent(/sync|archive|managed fields|correction/i);
  });

  it('uses curated import copy for an unexpected apply error', async () => {
    const user = userEvent.setup();
    const raw = 'Sync correction failed while trying to archive managed fields.';
    const onApply = vi.fn().mockRejectedValue(new Error(raw));
    const { container } = render(React.createElement(SyncReview, {
      operationKind: 'people_import',
      provider: 'elvanto',
      review: reviewFixture(),
      ...handlers,
      onApply,
    }));

    await user.click(screen.getByRole('button', { name: 'Apply import' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The import could not be applied. Try again.');
    expect(container).not.toHaveTextContent(/sync|archive|managed fields|correction/i);
  });
});
