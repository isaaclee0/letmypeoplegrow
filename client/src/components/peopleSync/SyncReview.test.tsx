import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SyncReview from './SyncReview';
import type { PeopleSyncPlan, PeopleSyncReview } from './types';

const plan: PeopleSyncPlan = {
  provider: 'elvanto', authoritative: true, snapshot: { fetchedAt: '2026-07-25T09:00:00.000Z', mode: 'full' },
  ambiguousPeople: [{ id: 'ambiguous:ext-1', externalPersonId: 'ext-1', reason: 'Multiple local matches', candidateIndividualIds: [7, 8] }],
  familyConflicts: [{ id: 'familyConflict:1', reason: 'Choose a household' }],
  unmatchedLocalRegulars: [{ id: 'unmatched:10', individualId: 10, reason: 'No external match', reviewRequired: true }],
  archive: [{ id: 'archive:11', externalPersonId: 'ext-archive', individualId: 11, reason: 'Missing from provider', missingFullSyncCount: 2 }],
  removeFromGathering: [{ id: 'remove:12', batchId: 1, gatheringTypeId: 2, individualId: 12, reason: 'No longer eligible' }],
  renameFamily: [{ id: 'renameFamily:20', familyId: 20, familyName: 'New family name', reason: 'Provider household changed' }],
  linkPeople: [{ id: 'link:13', externalPersonId: 'ext-link', individualId: 13, reason: 'Exact match', reviewRequired: false }],
  linkFamilies: [{ id: 'linkFamily:14', externalFamilyId: 'family-14', familyId: 14, reason: 'Exact household match' }],
  reactivate: [{ id: 'reactivate:15', externalPersonId: 'ext-reactivate', individualId: 15, reason: 'Active in provider' }],
  addPeople: [{ id: 'add:ext-add', externalPersonId: 'ext-add', firstName: 'Ada', lastName: 'Lovelace', isChild: false, familyId: null, peopleType: 'regular', reason: 'New external person', reviewRequired: true }],
  addFamilies: [{ id: 'addFamily:16', externalFamilyId: 'family-16', familyName: 'Lovelace', reason: 'New household' }],
  updateManagedFields: [{ id: 'update:17', externalPersonId: 'ext-update', individualId: 17, changes: [{ field: 'firstName', localValue: 'Grace', externalValue: 'Ada' }], reason: 'Managed field changed', reviewRequired: false }],
  promoteToRegular: [{ id: 'promote:ext-visitor', externalPersonId: 'ext-visitor', individualId: 18, fromPeopleType: 'local_visitor', toPeopleType: 'regular', reason: 'Visitor match', reviewRequired: true }],
  demoteToLocalVisitor: [{ id: 'demote:19', externalPersonId: 'ext-demote', individualId: 19, fromPeopleType: 'regular', toPeopleType: 'local_visitor', reason: 'Provider status changed', reviewRequired: false }],
  moveFamily: [{ id: 'move:21', individualId: 21, familyId: 22, reason: 'Household changed' }],
  addToGathering: [{ id: 'gathering-add:ext-add', batchId: 1, gatheringTypeId: 2, externalPersonId: 'ext-add', individualId: null, eligibleBatchIds: [1], reason: 'Eligible for gathering' }],
  skipped: [{ id: 'skip:22', externalPersonId: 'ext-skip', individualId: 22, reason: 'Managed by another provider' }],
};

const review: PeopleSyncReview = {
  runId: 1,
  reviewToken: 'review-token',
  summary: Object.fromEntries(Object.entries(plan)
    .filter(([key]) => !['provider', 'authoritative', 'snapshot'].includes(key))
    .map(([key, value]) => [key, Array.isArray(value) ? value.length : 0])) as PeopleSyncReview['summary'],
  plan,
  snapshot: plan.snapshot,
};

describe('SyncReview', () => {
  it('renders every plan bucket with provider-neutral labels and warns about destructive changes', () => {
    render(<SyncReview provider="elvanto" review={review} onRefresh={vi.fn()} onApply={vi.fn()} applying={false} />);

    expect(screen.getByText('Elvanto sync review')).toBeInTheDocument();
    expect(screen.queryByText(/PCO/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Needs your decision/)).toBeInTheDocument();
    expect(screen.getByText(/Destructive changes/).parentElement).toHaveClass('border-amber-300');
    expect(screen.getByText(/This will archive people or remove them from gatherings/)).toBeInTheDocument();
    expect(screen.getByText('Links and restores')).toBeInTheDocument();
    expect(screen.getByText('Adds')).toBeInTheDocument();
    expect(screen.getByText('Managed updates')).toBeInTheDocument();
    expect(screen.getByText('Gathering changes')).toBeInTheDocument();
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    expect(screen.getByText('ambiguousPeople: 1')).toBeInTheDocument();
    expect(screen.getByText('removeFromGathering: 1')).toBeInTheDocument();
    expect(screen.getByText(/ext-skip:/)).toBeInTheDocument();
  });

  it('serializes reviewer choices and requires explicit destructive confirmation before applying', () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(<SyncReview provider="planning_center" review={review} onRefresh={vi.fn()} onApply={onApply} applying={false} />);

    expect(screen.getByText('Planning Center sync review')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Use local person 7 for ext-1'));
    fireEvent.click(screen.getByLabelText('Promote visitor 18'));
    fireEvent.click(screen.getByLabelText('Archive person 10'));
    fireEvent.click(screen.getByLabelText('Archive person 11'));
    fireEvent.click(screen.getByLabelText('Accept family rename to New family name'));

    const apply = screen.getByRole('button', { name: 'Apply sync' });
    expect(apply).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I understand that this sync will archive people/));
    expect(apply).toBeEnabled();
    fireEvent.click(apply);

    expect(onApply).toHaveBeenCalledWith('review-token', {
      ambiguous: { 'ext-1': 7 },
      skipExternalPersonIds: [],
      visitorChoices: { 'ext-visitor': 'promote' },
      acceptArchiveIndividualIds: [10, 11],
      acceptFamilyRenameIds: ['renameFamily:20'],
    });
  });

  it('does not enable Apply until every planned archive is explicitly accepted', () => {
    render(<SyncReview provider="planning_center" review={review} onRefresh={vi.fn()} onApply={vi.fn()} applying={false} />);

    fireEvent.click(screen.getByLabelText(/I understand that this sync will archive people/));
    expect(screen.getByRole('button', { name: 'Apply sync' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Archive person 11'));
    expect(screen.getByRole('button', { name: 'Apply sync' })).toBeEnabled();
  });

  it('serializes the visitor keep decision', () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    const nonDestructiveReview: PeopleSyncReview = {
      ...review,
      plan: { ...plan, archive: [], removeFromGathering: [], renameFamily: [] },
    };
    render(<SyncReview provider="elvanto" review={nonDestructiveReview} onRefresh={vi.fn()} onApply={onApply} applying={false} />);

    fireEvent.click(screen.getByLabelText('Keep as visitor'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply sync' }));

    expect(onApply).toHaveBeenCalledWith('review-token', expect.objectContaining({
      visitorChoices: { 'ext-visitor': 'keep' },
    }));
  });

  it('offers a manual refresh after a stale plan error without retrying the apply', async () => {
    const staleError = Object.assign(new Error('This plan is stale.'), { code: 'STALE_REVIEW' });
    const onApply = vi.fn().mockRejectedValue(staleError);
    const onRefresh = vi.fn();
    render(<SyncReview provider="elvanto" review={review} onRefresh={onRefresh} onApply={onApply} applying={false} />);

    fireEvent.click(screen.getByLabelText(/I understand that this sync will archive people/));
    fireEvent.click(screen.getByLabelText('Archive person 11'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply sync' }));

    expect(await screen.findByRole('button', { name: 'Refresh plan' })).toBeInTheDocument();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onRefresh).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Refresh plan' }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  });
});
