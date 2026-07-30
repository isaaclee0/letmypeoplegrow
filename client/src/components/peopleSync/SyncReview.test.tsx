import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import SyncReview from './SyncReview';
import type { IdentityReviewEntry, PeopleSyncPlan, PeopleSyncPlanSummary, PeopleSyncReview } from './types';

const emptyBuckets = (): Omit<PeopleSyncPlan, 'provider' | 'authoritative' | 'snapshot'> => ({
  linkPeople: [], linkFamilies: [], addPeople: [], addFamilies: [], updateManagedFields: [],
  promoteToRegular: [], demoteToLocalVisitor: [], archive: [], reactivate: [], moveFamily: [],
  renameFamily: [], addToGathering: [], removeFromGathering: [], ambiguousPeople: [],
  familyConflicts: [], unmatchedLocalRegulars: [], skipped: [],
});

const summaryFor = (plan: PeopleSyncPlan): PeopleSyncPlanSummary => Object.fromEntries(
  Object.entries(plan)
    .filter(([key]) => !['provider', 'authoritative', 'snapshot', 'people', 'reviewContext'].includes(key))
    .map(([key, value]) => [key, Array.isArray(value) ? value.length : 0]),
) as PeopleSyncPlanSummary;

function v2Review(overrides: Partial<PeopleSyncPlan> = {}): PeopleSyncReview {
  const plan: PeopleSyncPlan = {
    ...emptyBuckets(),
    provider: 'planning_center',
    authoritative: true,
    snapshot: { fetchedAt: '2026-07-25T09:00:00.000Z', mode: 'full' },
    people: {
      external: {
        'ext-auto': {
          firstName: 'Alex', lastName: 'Smith',
          family: {
            state: 'known', name: 'Smith Household', totalOtherMembers: 4,
            members: [
              { firstName: 'Casey', lastName: 'Smith' },
              { firstName: 'Drew', lastName: 'Smith' },
              { firstName: 'Jamie', lastName: 'Smith' },
            ],
          },
        },
        'ext-ambiguous': { firstName: 'Blair', lastName: 'Jones', family: { state: 'none' } },
      },
      local: {
        '7': {
          firstName: 'Alex', lastName: 'Smith', matchEligible: true,
          family: { state: 'known', name: 'Local Smiths', members: [{ firstName: 'Jamie', lastName: 'Smith' }], totalOtherMembers: 1 },
        },
        '8': { firstName: 'Taylor', lastName: 'Reed', matchEligible: true, family: { state: 'none' } },
        '9': {
          firstName: 'Jordan', lastName: 'Lee', matchEligible: true,
          family: { state: 'known', name: 'Lee Family', members: [{ firstName: 'Morgan', lastName: 'Taylor' }], totalOtherMembers: 1 },
        },
        '10': { firstName: 'Durable', lastName: 'Link', matchEligible: false, family: { state: 'unavailable' } },
      },
    },
    reviewContext: {
      version: 2,
      manualCandidateIndividualIds: [7, 8, 9],
      identities: {
        'ext-auto': {
          suggestedIndividualId: 7, candidateIndividualIds: [7], excludedIndividualIds: [],
          held: false, canCreate: true,
          createPerson: { firstName: 'Alex', lastName: 'Smith', isChild: false, externalFamilyId: 'smiths', peopleType: 'regular' },
        },
        'ext-ambiguous': {
          suggestedIndividualId: null, candidateIndividualIds: [8, 9], excludedIndividualIds: [],
          held: false, canCreate: true,
          createPerson: { firstName: 'Blair', lastName: 'Jones', isChild: false, externalFamilyId: null, peopleType: 'regular' },
        },
      },
    },
    linkPeople: [{ id: 'link:ext-auto', externalPersonId: 'ext-auto', individualId: 7, reason: 'family_corroboration', reviewRequired: false }],
    ambiguousPeople: [{ id: 'ambiguous:ext-ambiguous', externalPersonId: 'ext-ambiguous', reason: 'duplicate_name', candidateIndividualIds: [8, 9] }],
    ...overrides,
  };
  return {
    runId: 1,
    reviewToken: 'review-token',
    decisionContractVersion: 2,
    summary: summaryFor(plan),
    plan,
    snapshot: plan.snapshot,
  };
}

function singleIdentityReview(overrides: Partial<IdentityReviewEntry> = {}): PeopleSyncReview {
  const review = v2Review();
  const identity = { ...review.plan.reviewContext!.identities['ext-auto'], ...overrides };
  const plan = {
    ...review.plan,
    ambiguousPeople: [],
    reviewContext: { ...review.plan.reviewContext!, identities: { 'ext-auto': identity } },
  };
  return { ...review, plan, summary: summaryFor(plan) };
}

function legacyReview(): PeopleSyncReview {
  const plan: PeopleSyncPlan = {
    ...emptyBuckets(), provider: 'elvanto', authoritative: true,
    snapshot: { fetchedAt: '2026-07-25T09:00:00.000Z', mode: 'full' },
    people: {
      external: { 'ext-archive': { firstName: 'External', lastName: 'Archived', family: { state: 'unavailable' } } },
      local: { '11': { firstName: 'Local', lastName: 'Archived', family: { state: 'none' } } },
    },
    archive: [{ id: 'archive:11', externalPersonId: 'ext-archive', individualId: 11, reason: 'Missing from provider', missingFullSyncCount: 2 }],
    removeFromGathering: [{ id: 'remove:12', batchId: 1, gatheringTypeId: 2, individualId: 12, reason: 'No longer eligible' }],
    renameFamily: [{ id: 'renameFamily:20', familyId: 20, familyName: 'New family name', reason: 'Provider household changed' }],
  };
  return { runId: 2, reviewToken: 'legacy-token', summary: summaryFor(plan), plan, snapshot: plan.snapshot };
}

describe('SyncReview v2 identity review', () => {
  it('renders friendly summaries and semantic, responsive family-aware comparison cards', () => {
    render(<SyncReview provider="planning_center" review={v2Review()} onRefresh={vi.fn()} onApply={vi.fn()} applying={false} />);

    expect(screen.getByText('Planning Center sync review')).toBeInTheDocument();
    expect(screen.getAllByText('Planning Center person').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Let My People Grow person').length).toBeGreaterThan(0);
    expect(screen.getByText('Smith Household')).toBeInTheDocument();
    expect(screen.getAllByText(/Jamie Smith/).length).toBeGreaterThan(0);
    expect(screen.getByText('1 more family member')).toBeInTheDocument();
    expect(screen.getAllByText('No family').length).toBeGreaterThan(0);
    expect(screen.queryByText(/linkPeople:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ambiguousPeople:/)).not.toBeInTheDocument();
    expect(screen.getByText('Suggested matches')).toBeInTheDocument();
    expect(screen.getByText('Decisions needed')).toBeInTheDocument();
    expect(screen.getByText('Same full name with a linked family member')).toBeInTheDocument();
    expect(screen.getByText('More than one person has this name')).toBeInTheDocument();
    expect(screen.getByTestId('identity-comparison-ext-auto')).toHaveClass('grid-cols-1', 'md:grid-cols-2');
    expect(screen.getByText(/Match decisions/).closest('details')).not.toBeNull();
    expect(screen.getAllByRole('button', { name: 'Apply sync' })).toHaveLength(2);
  });

  it('defaults deterministic matches but requires an explicit ambiguous decision', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(<SyncReview provider="planning_center" review={v2Review()} onRefresh={vi.fn()} onApply={onApply} applying={false} />);

    expect(screen.getByRole('radio', { name: 'Accept suggested match' })).toBeChecked();
    const applyButtons = screen.getAllByRole('button', { name: 'Apply sync' });
    expect(applyButtons[0]).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Blair Jones needs a decision');

    await user.click(screen.getAllByRole('radio', { name: 'Skip for now' })[1]);
    expect(applyButtons[0]).toBeEnabled();
    await user.click(applyButtons[0]);
    expect(onApply).toHaveBeenCalledWith('review-token', {
      decisionContractVersion: 2,
      identityDecisions: {
        'ext-ambiguous': { outcome: 'defer' },
        'ext-auto': { outcome: 'accept' },
      },
      acceptArchiveIndividualIds: [],
      acceptFamilyRenameIds: [],
    });
  });

  it('searches local people by name and family member and explains unavailable results', async () => {
    const user = userEvent.setup();
    render(<SyncReview provider="planning_center" review={v2Review()} onRefresh={vi.fn()} onApply={vi.fn()} applying={false} />);

    await user.click(screen.getAllByRole('radio', { name: 'Choose someone else' })[1]);
    const search = screen.getByRole('searchbox', { name: 'Search Let My People Grow people' });
    await user.type(search, 'Taylor');
    expect(screen.getByRole('button', { name: /Select Taylor Reed/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Select Jordan Lee/ })).toBeEnabled();

    await user.clear(search);
    await user.type(search, 'Alex');
    expect(screen.getByRole('button', { name: /Select Alex Smith/ })).toBeDisabled();
    expect(screen.getByText(/Already selected for Alex Smith/)).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'Durable');
    expect(screen.getByRole('button', { name: /Select Durable Link/ })).toBeDisabled();
    expect(screen.getByText(/Already linked to this provider/)).toBeInTheDocument();
    expect(screen.getByText('Household information unavailable')).toBeInTheDocument();
  });

  it('supports create, defer, exact rejection, and confirmation of an excluded pair override', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <SyncReview provider="planning_center" review={singleIdentityReview()} onRefresh={vi.fn()} onApply={onApply} applying={false} />,
    );

    await user.click(screen.getByRole('radio', { name: 'Add as a new person' }));
    const reject = screen.getByRole('checkbox', { name: "Don't suggest this pairing again" });
    await user.click(reject);
    await user.click(screen.getAllByRole('button', { name: 'Apply sync' })[0]);
    expect(onApply).toHaveBeenLastCalledWith('review-token', expect.objectContaining({
      identityDecisions: { 'ext-auto': { outcome: 'create', excludeIndividualId: 7 } },
    }));

    const excludedReview = singleIdentityReview({
      suggestedIndividualId: null,
      candidateIndividualIds: [8],
      excludedIndividualIds: [8],
      held: true,
    });
    rerender(<SyncReview provider="planning_center" review={{ ...excludedReview, reviewToken: 'excluded-token' }} onRefresh={vi.fn()} onApply={onApply} applying={false} />);
    await user.click(screen.getByRole('radio', { name: 'Choose someone else' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search Let My People Grow people' }), 'Taylor');
    await user.click(screen.getByRole('button', { name: /Select Taylor Reed/ }));
    expect(screen.getByText(/This pairing was previously rejected/).closest('[role="alert"]')).toHaveTextContent('previously rejected');
    expect(screen.getAllByRole('button', { name: 'Apply sync' })[0]).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Confirm this previously rejected pairing' }));
    expect(screen.getAllByRole('button', { name: 'Apply sync' })[0]).toBeEnabled();
    await user.click(screen.getAllByRole('button', { name: 'Apply sync' })[0]);
    expect(onApply).toHaveBeenLastCalledWith('excluded-token', expect.objectContaining({
      identityDecisions: { 'ext-auto': { outcome: 'link', individualId: 8 } },
    }));
  });

  it('identifies client-known claim collisions by person name', () => {
    const base = v2Review();
    const plan = {
      ...base.plan,
      reviewContext: {
        ...base.plan.reviewContext!,
        identities: {
          ...base.plan.reviewContext!.identities,
          'ext-ambiguous': { ...base.plan.reviewContext!.identities['ext-ambiguous'], suggestedIndividualId: 7, held: false },
        },
      },
    };
    const collisionReview = { ...base, plan, summary: summaryFor(plan) };
    render(<SyncReview provider="planning_center" review={collisionReview} onRefresh={vi.fn()} onApply={vi.fn()} applying={false} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/Alex Smith.*Blair Jones|Blair Jones.*Alex Smith/);
    expect(screen.getAllByRole('button', { name: 'Apply sync' })[0]).toBeDisabled();
  });

  it('preserves choices after ordinary errors, explains stale manual choices, and resets for a new token', async () => {
    const user = userEvent.setup();
    const ordinaryError = Object.assign(new Error('Temporary network problem.'), { code: 'NETWORK_ERROR' });
    const staleError = Object.assign(new Error('The reviewed plan was out of date.'), { code: 'SYNC_PLAN_STALE' });
    const onApply = vi.fn().mockRejectedValueOnce(ordinaryError).mockRejectedValueOnce(staleError);
    const onRefresh = vi.fn();
    const base = v2Review();
    const { rerender } = render(<SyncReview provider="planning_center" review={base} onRefresh={onRefresh} onApply={onApply} applying={false} />);

    await user.click(screen.getAllByRole('radio', { name: 'Choose someone else' })[1]);
    await user.type(screen.getByRole('searchbox', { name: 'Search Let My People Grow people' }), 'Taylor Reed');
    await user.click(screen.getByRole('button', { name: /Select Taylor Reed/ }));
    await user.click(screen.getAllByRole('button', { name: 'Apply sync' })[0]);
    expect(await screen.findByText('Temporary network problem.')).toBeInTheDocument();
    expect(within(screen.getByTestId('identity-comparison-ext-ambiguous')).getByText('Taylor Reed')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Apply sync' })[0]);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Blair Jones');
    expect(alert).toHaveTextContent('Taylor Reed');
    expect(alert).toHaveTextContent('may no longer be available');
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(onRefresh).not.toHaveBeenCalled();
    await user.click(within(alert).getByRole('button', { name: 'Refresh plan' }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));

    rerender(<SyncReview provider="planning_center" review={{ ...base, reviewToken: 'new-token' }} onRefresh={onRefresh} onApply={onApply} applying={false} />);
    expect(screen.getAllByRole('button', { name: 'Apply sync' })[0]).toBeDisabled();
  });
});

describe('SyncReview legacy destructive review', () => {
  it('keeps destructive confirmation and the all-archives acceptance policy', () => {
    const review = legacyReview();
    render(<SyncReview provider="elvanto" review={review} onRefresh={vi.fn()} onApply={vi.fn()} applying={false} requireAllPlannedArchivesAccepted />);

    const apply = screen.getAllByRole('button', { name: 'Apply sync' })[0];
    expect(apply).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Archive Local Archived'));
    fireEvent.click(screen.getByLabelText(/I understand that this sync will archive people/));
    expect(apply).toBeEnabled();
    expect(screen.getAllByText('Destructive changes').at(-1)?.closest('details')).toHaveClass('border-amber-300');
  });

  it('renders source coverage guidance only for a positive count', () => {
    const review = legacyReview();
    const { rerender } = render(<SyncReview provider="elvanto" review={{ ...review, coverage: { unmatchedActiveLocalRegulars: 208 } }} onRefresh={vi.fn()} onApply={vi.fn()} applying={false} />);
    expect(screen.getByText(/208 active LMPG regulars/)).toBeInTheDocument();
    rerender(<SyncReview provider="elvanto" review={{ ...review, coverage: { unmatchedActiveLocalRegulars: 0 } }} onRefresh={vi.fn()} onApply={vi.fn()} applying={false} />);
    expect(screen.queryByText(/remain unchanged/i)).not.toBeInTheDocument();
  });
});
