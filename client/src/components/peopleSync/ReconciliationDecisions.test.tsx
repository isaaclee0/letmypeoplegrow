import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import SyncReview from './SyncReview';
import { tagLegacyPeopleReview, type PeopleSyncPlan, type PeopleSyncReview } from './types';

vi.mock('../../hooks/useChurchTime', () => ({
  useChurchTime: () => ({ formatInstant: (value: string) => value }),
}));

function fixture() {
  const plan: PeopleSyncPlan = {
    provider: 'planning_center', authoritative: true,
    snapshot: { fetchedAt: '2026-11-03T10:28:00Z', mode: 'full' },
    linkPeople: [], linkFamilies: [], addPeople: [], addFamilies: [], updateManagedFields: [],
    promoteToRegular: [], demoteToLocalVisitor: [], archive: [], reactivate: [], moveFamily: [],
    renameFamily: [], addToGathering: [], removeFromGathering: [], ambiguousPeople: [],
    familyConflicts: [], unmatchedLocalRegulars: [], skipped: [],
    people: {
      external: {
        ellis: { firstName: 'Ellis', lastName: 'Example', family: { state: 'known', name: 'Example Household', members: [{ firstName: 'Robin', lastName: 'Example' }], totalOtherMembers: 1 } },
        robin: { firstName: 'Robin', lastName: 'Example' },
      },
      local: {
        '11': { firstName: 'Ellis', lastName: 'Example', family: { state: 'known', name: 'Example, Ellis', members: [], totalOtherMembers: 0 } },
        '12': { firstName: 'Robin', lastName: 'Example', family: { state: 'known', name: 'Example, Robin', members: [], totalOtherMembers: 0 } },
        '13': { firstName: 'Parker', lastName: 'Sample' },
      },
    },
    reviewContext: { version: 2, manualCandidateIndividualIds: [], identities: {}, establishedLinks: {} },
  };
  plan.familyConflicts = [{
    id: 'familyConflict:example', externalFamilyId: 'example', externalFamilyName: 'Example Household',
    memberExternalIds: ['ellis', 'robin'], candidateFamilyIds: [21, 22],
    reason: 'multiple_local_families',
    resolution: {
      kind: 'household', destination: { kind: 'create', familyName: 'Example, Ellis and Robin' },
      moves: [
        { externalPersonId: 'ellis', individualId: 11, fromFamilyId: 21 },
        { externalPersonId: 'robin', individualId: 12, fromFamilyId: 22 },
      ],
    },
  }];
  const review = {
    runId: 1, reviewToken: 'signed-review', decisionContractVersion: 2,
    plan, snapshot: plan.snapshot, summary: {},
  } as PeopleSyncReview;
  return tagLegacyPeopleReview(review, 'people_sync');
}

function mount(review = fixture()) {
  const onApply = vi.fn().mockResolvedValue(undefined);
  render(<SyncReview operationKind="people_sync" provider="planning_center" review={review}
    onRefresh={vi.fn()} onApply={onApply} applying={false} />);
  return onApply;
}

describe('reviewed household and attendance-list decisions', () => {
  it('lets a held person be added or left for later directly without opening a picker', async () => {
    const user = userEvent.setup();
    const review = fixture();
    review.plan.familyConflicts = [];
    review.plan.people!.external.quinn = { firstName: 'Quinn', lastName: '(Q S)' };
    review.plan.reviewContext!.identities.quinn = {
      suggestedIndividualId: null, candidateIndividualIds: [], excludedIndividualIds: [], held: true,
      canCreate: true, createPerson: { firstName: 'Quinn', lastName: '(Q S)', isChild: true, externalFamilyId: null, peopleType: 'regular' },
    };
    const onApply = mount(review);
    await user.click(screen.getByRole('button', { name: 'Add Quinn (Q S) to LMPG' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply 1 selected change' }));
    expect(onApply).toHaveBeenCalledWith('signed-review', expect.objectContaining({
      identityDecisions: { quinn: { outcome: 'create' } },
    }));
  });

  it('shows v2 household disagreements with current families and submits only an explicit resolution', async () => {
    const user = userEvent.setup();
    const onApply = mount();
    const household = screen.getByRole('region', { name: 'Household decisions' });
    expect(within(household).getByText('Example, Ellis')).toBeVisible();
    expect(within(household).getByText('Example, Robin')).toBeVisible();
    const choice = within(household).getByRole('checkbox', { name: /Use Planning Center household/ });
    expect(choice).not.toBeChecked();
    await user.click(choice);
    expect(screen.getByText('Example, Ellis and Robin')).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: /I understand|I have reviewed/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply 1 selected change' }));
    expect(onApply).toHaveBeenCalledWith('signed-review', expect.objectContaining({
      acceptFamilyResolutionIds: ['familyConflict:example'],
    }));
  });

  it('keeps an unresolved household visible when no safe repair can be offered', () => {
    const review = fixture();
    delete review.plan.familyConflicts[0].resolution;
    review.plan.familyConflicts[0].reason = 'unresolved_household_members';
    review.plan.reviewContext!.establishedLinks = { ellis: { individualId: 11 }, robin: { individualId: 12 } };
    mount(review);
    const household = screen.getByRole('region', { name: 'Household decisions' });
    expect(within(household).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(household).getByText(/Match the household members first/)).toBeVisible();
    expect(within(household).getByText('Example, Ellis')).toBeVisible();
    expect(within(household).getByText('Example, Robin')).toBeVisible();
    expect(screen.queryByText('No roster changes are planned in this review.')).not.toBeInTheDocument();
  });

  it('separates optional old roster removal from automatic updates and preserves history in its explanation', async () => {
    const user = userEvent.setup();
    const review = fixture();
    review.plan.familyConflicts = [];
    review.plan.removeFromGathering = [{
      id: 'legacy:1:13', batchId: null, gatheringTypeId: 1, gatheringName: 'Sunday AM',
      individualId: 13, externalPersonId: 'parker', sourceBatchIds: [5],
      reason: 'legacy_roster_not_in_source', reviewRequired: true,
    } as never];
    const onApply = mount(review);
    const roster = screen.getByRole('region', { name: 'Attendance-list decisions' });
    expect(within(roster).getByText(/Past attendance is kept/)).toBeVisible();
    const choice = within(roster).getByRole('checkbox', { name: /Remove Parker Sample from Sunday AM/ });
    expect(choice).not.toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /I have reviewed/ })).not.toBeInTheDocument();
    await user.click(choice);
    expect(screen.queryByRole('checkbox', { name: /I understand|I have reviewed/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply 1 selected change' }));
    expect(onApply).toHaveBeenCalledWith('signed-review', expect.objectContaining({
      acceptGatheringRemovalIds: ['legacy:1:13'],
    }));
  });
});
