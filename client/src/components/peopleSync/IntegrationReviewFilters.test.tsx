import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import SyncReview from './SyncReview';
import SyncDecisionList from './SyncDecisionList';
import { buildDecisionGroups } from './syncDecisionModel';
import { reviewGatherings } from './GatheringReviewFilter';
import { tagLegacyPeopleReview, type PeopleSyncReview } from './types';

vi.mock('../../hooks/useChurchTime', () => ({ useChurchTime: () => ({ formatInstant: (value: string) => value }) }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const gatherings = [{ id: 1, name: 'Sunday AM' }, { id: 2, name: 'Sunday PM' }];
function fixture() {
  return tagLegacyPeopleReview({
    runId: 1, reviewToken: 'whole-integration-token', decisionContractVersion: 2,
    summary: {
      linkPeople: 0, linkFamilies: 0, addPeople: 0, addFamilies: 0, updateManagedFields: 0,
      promoteToRegular: 0, demoteToLocalVisitor: 0, archive: 1, reactivate: 0, moveFamily: 0,
      renameFamily: 0, addToGathering: 0, removeFromGathering: 2, ambiguousPeople: 0,
      familyConflicts: 0, unmatchedLocalRegulars: 0, skipped: 0,
    }, snapshot: { mode: 'full', fetchedAt: '2026-11-07T00:00:00Z' },
    plan: {
      provider: 'planning_center', authoritative: true, snapshot: { mode: 'full', fetchedAt: '2026-11-07T00:00:00Z' },
      linkPeople: [], linkFamilies: [], addPeople: [], addFamilies: [], updateManagedFields: [],
      promoteToRegular: [], demoteToLocalVisitor: [], reactivate: [], moveFamily: [], renameFamily: [],
      addToGathering: [], familyConflicts: [], ambiguousPeople: [], unmatchedLocalRegulars: [], skipped: [],
      reviewContext: { version: 2, manualCandidateIndividualIds: [], identities: {}, establishedLinks: {} },
      people: { external: {}, local: {
        '11': { firstName: 'Alex', lastName: 'Morning' }, '12': { firstName: 'Blair', lastName: 'Evening' },
        '13': { firstName: 'Casey', lastName: 'Outside' },
      } },
      removeFromGathering: [
        { id: 'remove-am', batchId: 5, gatheringTypeId: 1, gatheringName: 'Sunday AM', individualId: 11, reviewRequired: true, reason: 'legacy_roster_not_in_source' },
        { id: 'remove-pm', batchId: 6, gatheringTypeId: 2, gatheringName: 'Sunday PM', individualId: 12, reviewRequired: true, reason: 'legacy_roster_not_in_source' },
      ],
      archive: [{ id: 'outside-casey', individualId: 13, externalPersonId: 'casey', reason: 'outside_all_sync_sources', linkRequired: true,
        externalFirstName: 'Casey', externalLastName: 'Outside', sourceNames: ['AM list', 'PM list'], pcoHouseholdNames: ['Outside Household'] }],
    },
  } as PeopleSyncReview, 'people_sync');
}

describe('integration-wide review visibility', () => {
  it('offers only participating gatherings while retaining names for planned roster changes', () => {
    const review = fixture();
    review.plan.sourceContext = { reviewedLists: [{ batchId: 5, name: 'AM list', gatheringTypeId: 1,
      activeSource: null, selectedSource: { kind: 'planning_center_list', externalId: 'am', name: 'AM list' }, isDraft: true }] };
    expect(reviewGatherings(review, [...gatherings, { id: 3, name: 'Disabled group' }])).toEqual(gatherings);
    expect(reviewGatherings(review, [])).toEqual(gatherings);
  });
  it('names one person once when their gathering removal and archive share an identity', () => {
    const review = fixture();
    review.plan.removeFromGathering = [{ id: 'remove-casey', batchId: 5, gatheringTypeId: 1,
      individualId: 13, externalPersonId: 'casey', reviewRequired: true, reason: 'legacy_roster_not_in_source' }];
    const groups = buildDecisionGroups(review);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe('Casey Outside');
    expect(groups[0].decisions).toHaveLength(2);
  });
  it('keeps hidden gathering selections and the full token when filtering the current review', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<SyncReview operationKind="people_sync" provider="planning_center" review={fixture()}
      gatherings={gatherings} onRefresh={vi.fn()} onApply={onApply} applying={false} />);
    await user.click(screen.getByRole('checkbox', { name: /Remove Alex Morning from Sunday AM/ }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Gathering changes' }), '2');
    expect(screen.queryByRole('checkbox', { name: /Remove Alex Morning/ })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Link and archive Casey Outside/ })).toBeVisible();
    await user.click(screen.getByRole('checkbox', { name: /Remove Blair Evening from Sunday PM/ }));
    await user.click(screen.getByRole('button', { name: 'Apply 2 selected changes' }));
    expect(onApply).toHaveBeenCalledWith('whole-integration-token', expect.objectContaining({
      acceptGatheringRemovalIds: ['remove-am', 'remove-pm'], acceptArchiveIndividualIds: [],
    }));
  });

  it('keeps a hidden keep decision and shared people visible in the decision layout', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<SyncDecisionList provider="planning_center" review={fixture()} gatherings={gatherings} onApply={onApply} />);
    const morning = screen.getByRole('heading', { name: 'Alex Morning' }).closest('li')!;
    await user.click(within(morning).getByRole('button', { name: 'Something else' }));
    await user.click(screen.getByRole('option', { name: /Keep on Sunday AM/ }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Gathering changes' }), '2');
    expect(screen.queryByRole('heading', { name: 'Alex Morning' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Casey Outside' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Blair Evening' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Apply 1 change' }));
    expect(onApply).toHaveBeenCalledWith('whole-integration-token', expect.objectContaining({
      acceptGatheringRemovalIds: ['remove-pm'], keepReconciliationIds: ['remove-am'], acceptArchiveIndividualIds: [],
    }));
  });

  it.each(['current', 'decisions'])('can apply source changes with no roster changes in %s layout', async (layout) => {
    const user = userEvent.setup();
    const review = fixture();
    review.plan.removeFromGathering = [];
    review.plan.archive = [];
    review.plan.sourceContext = { promotions: [{ batchId: 5, expectedBaseRevision: 0, expectedDraftDigest: 'draft-am' }] };
    const onApply = vi.fn();
    render(layout === 'current'
      ? <SyncReview operationKind="people_sync" provider="planning_center" review={review} gatherings={gatherings} onRefresh={vi.fn()} onApply={onApply} applying={false} />
      : <SyncDecisionList provider="planning_center" review={review} gatherings={gatherings} onApply={onApply} />);
    expect(screen.getByText(/1 list source change/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: layout === 'current' ? 'Apply 1 selected change' : 'Apply 1 change' }));
    expect(onApply).toHaveBeenCalledWith('whole-integration-token', expect.any(Object));
  });

  it.each(['current', 'decisions'])('names gathering additions and retains the whole plan while filtering in %s layout', async (layout) => {
    const user = userEvent.setup();
    const review = fixture();
    review.plan.removeFromGathering = [];
    review.plan.archive = [];
    review.plan.people!.external = { alex: { firstName: 'Alex', lastName: 'Morning' }, blair: { firstName: 'Blair', lastName: 'Evening' } };
    review.plan.addToGathering = [
      { id: 'add-am', batchId: 5, gatheringTypeId: 1, individualId: 11, externalPersonId: 'alex', eligibleBatchIds: [5], reason: 'in_source' },
      { id: 'add-pm', batchId: 6, gatheringTypeId: 2, individualId: 12, externalPersonId: 'blair', eligibleBatchIds: [6], reason: 'in_source' },
    ];
    const onApply = vi.fn();
    render(layout === 'current'
      ? <SyncReview operationKind="people_sync" provider="planning_center" review={review} gatherings={gatherings} onRefresh={vi.fn()} onApply={onApply} applying={false} />
      : <SyncDecisionList provider="planning_center" review={review} gatherings={gatherings} onApply={onApply} />);
    expect(screen.getByText(layout === 'current' ? 'Add Alex Morning to Sunday AM' : /Alex Morning → Sunday AM/)).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Gathering changes' }), '2');
    expect(screen.queryByText(layout === 'current' ? 'Add Alex Morning to Sunday AM' : /Alex Morning → Sunday AM/)).not.toBeInTheDocument();
    expect(screen.getByText(layout === 'current' ? 'Add Blair Evening to Sunday PM' : /Blair Evening → Sunday PM/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: layout === 'current' ? /^Apply \d+ selected changes$/ : 'Apply 2 changes' }));
    expect(onApply).toHaveBeenCalledWith('whole-integration-token', expect.any(Object));
    expect(review.plan.addToGathering).toHaveLength(2);
  });
});
