import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import SyncReview from './SyncReview';
import SyncDecisionList from './SyncDecisionList';
import { deriveSyncPlanView } from './SyncPlanSections';
import { initializeSyncSelectionState } from './syncSelections';
import { tagLegacyPeopleReview, type PeopleSyncReview } from './types';

vi.mock('../../hooks/useChurchTime', () => ({ useChurchTime: () => ({ formatInstant: (value: string) => value }) }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

function fixture() {
  return tagLegacyPeopleReview({
    runId: 1, reviewToken: 'personal-family-token', decisionContractVersion: 2,
    summary: {}, snapshot: { mode: 'full' },
    plan: {
      provider: 'planning_center', authoritative: true, snapshot: { mode: 'full' },
      linkPeople: [], linkFamilies: [], addPeople: [], addFamilies: [], updateManagedFields: [],
      promoteToRegular: [], demoteToLocalVisitor: [], archive: [], reactivate: [], moveFamily: [],
      renameFamily: [], addToGathering: [], removeFromGathering: [], ambiguousPeople: [],
      unmatchedLocalRegulars: [], skipped: [],
      reviewContext: { version: 2, manualCandidateIndividualIds: [], identities: {}, establishedLinks: { betty: { individualId: 11 } } },
      people: { external: { betty: { firstName: 'Betty', lastName: 'Bultman', family: { state: 'none' } } },
        local: { '11': { firstName: 'Betty', lastName: 'Bultman', family: { state: 'none' } } } },
      familyConflicts: [{ id: 'family:betty', externalFamilyId: null, memberExternalIds: ['betty'],
        reason: 'provider_has_no_household', resolution: { kind: 'single_person',
          destination: { kind: 'create', familyName: 'BULTMAN, Betty' },
          moves: [{ externalPersonId: 'betty', individualId: 11, fromFamilyId: null }] } }],
    },
  } as PeopleSyncReview, 'people_sync');
}

function newcomer() {
  const review = fixture();
  review.plan.familyConflicts = [];
  review.plan.people!.local = {};
  review.plan.reviewContext!.establishedLinks = {};
  review.plan.reviewContext!.identities.betty = { suggestedIndividualId: null, candidateIndividualIds: [], excludedIndividualIds: [], held: false,
    canCreate: true, createPerson: { firstName: 'Betty', lastName: 'Bultman', isChild: false, externalFamilyId: null, peopleType: 'regular' } };
  review.plan.addPeople = [{ id: 'person:betty', externalPersonId: 'betty', firstName: 'Betty', lastName: 'Bultman', isChild: false,
    familyId: null, peopleType: 'regular', reason: 'eligible_unmatched_external', reviewRequired: true }];
  review.plan.addFamilies = [{ id: 'new-family:betty', externalFamilyId: null, singlePersonExternalId: 'betty', memberExternalIds: ['betty'],
    familyName: 'BULTMAN, Betty', reason: 'provider_has_no_household' }];
  return review;
}

describe('single-person family review', () => {
  it('offers a named LMPG family in the current review without claiming PCO has a household', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<SyncReview operationKind="people_sync" provider="planning_center" review={fixture()} onRefresh={vi.fn()} onApply={onApply} applying={false} />);
    const household = screen.getByRole('region', { name: 'Household decisions' });
    expect(within(household).getByText('No household in Planning Center')).toBeVisible();
    expect(within(household).getByText('BULTMAN, Betty')).toBeVisible();
    const choice = within(household).getByRole('checkbox', { name: 'Create a single-person family for Betty Bultman' });
    expect(choice).not.toBeChecked();
    await user.click(choice);
    await user.click(screen.getByRole('button', { name: 'Apply 1 selected change' }));
    expect(onApply).toHaveBeenCalledWith('personal-family-token', expect.objectContaining({ acceptFamilyResolutionIds: ['family:betty'] }));
  });

  it('defaults to the named family in the decision layout and applies only the signed resolution', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<SyncDecisionList provider="planning_center" review={fixture()} onApply={onApply} />);
    expect(screen.getByText('Create “BULTMAN, Betty”')).toBeVisible();
    expect(screen.getByText('No household in Planning Center')).toBeVisible();
    expect(screen.queryByText(/Put together|Together in/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply 1 change' }));
    expect(onApply).toHaveBeenCalledWith('personal-family-token', expect.objectContaining({ acceptFamilyResolutionIds: ['family:betty'] }));
  });

  it('can keep the current arrangement instead of creating a family', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<SyncDecisionList provider="planning_center" review={fixture()} onApply={onApply} />);
    await user.click(screen.getByRole('button', { name: 'Something else' }));
    await user.click(screen.getByRole('option', { name: /Keep without a family/ }));
    await user.click(screen.getByRole('button', { name: /Save/ }));
    expect(onApply).toHaveBeenCalledWith('personal-family-token', expect.objectContaining({ keepReconciliationIds: ['family:betty'] }));
    expect(onApply.mock.calls[0][1].acceptFamilyResolutionIds || []).toEqual([]);
  });

  it('shows the new person’s own family as the creation result', () => {
    render(<SyncDecisionList provider="planning_center" review={newcomer()} onApply={vi.fn()} />);
    expect(screen.getAllByText('Regular, in “BULTMAN, Betty”').length).toBeGreaterThan(0);
    expect(screen.queryByText('Regular, no family')).not.toBeInTheDocument();
  });

  it('uses the signed default family when creating from an ambiguous match', async () => {
    const user = userEvent.setup();
    const review = newcomer();
    review.plan.addPeople = [];
    review.plan.addFamilies = [];
    review.plan.ambiguousPeople = [{ id: 'ambiguous:betty', externalPersonId: 'betty', candidateIndividualIds: [11, 12], reason: 'multiple_name_matches' }];
    review.plan.people!.local = {
      '11': { firstName: 'Betty', lastName: 'Bultman', family: { state: 'none' } },
      '12': { firstName: 'Betty', lastName: 'Bultman', family: { state: 'none' } },
    };
    const entry = review.plan.reviewContext!.identities.betty;
    entry.candidateIndividualIds = [11, 12];
    entry.suggestedIndividualId = 11;
    entry.createPerson!.singlePersonFamilyName = 'BULTMAN, Betty';
    const onApply = vi.fn();
    render(<SyncDecisionList provider="planning_center" review={review} onApply={onApply} />);
    await user.click(screen.getByRole('button', { name: 'Something else' }));
    await user.click(screen.getByRole('option', { name: /Add as a new person/ }));
    expect(screen.getAllByText('Regular, in “BULTMAN, Betty”').length).toBeGreaterThan(0);
    expect(screen.queryByText('Regular, no family')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply 1 change' }));
    expect(onApply).toHaveBeenCalledWith('personal-family-token', expect.objectContaining({ identityDecisions: { betty: { outcome: 'create' } } }));
  });

  it('includes a newcomer’s default family only while creating that person', () => {
    const review = newcomer();
    const state = initializeSyncSelectionState(review);
    state.identityDecisions = { betty: { outcome: 'create' } };
    expect(deriveSyncPlanView(review, state).addFamilies.map((family) => family.familyName)).toEqual(['BULTMAN, Betty']);
    state.identityDecisions = { betty: { outcome: 'defer' } };
    expect(deriveSyncPlanView(review, state).addFamilies).toEqual([]);
    state.identityDecisions = { betty: { outcome: 'link', individualId: 11 } };
    expect(deriveSyncPlanView(review, state).addFamilies).toEqual([]);
  });
});
