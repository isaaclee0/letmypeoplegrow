import React, { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import SyncPlanSections from './SyncPlanSections';
import { initializeSyncSelectionState, type SyncSelectionState } from './syncSelections';
import type { PeopleSyncPlan, PeopleSyncPlanSummary, PeopleSyncReview } from './types';

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

function reviewFixture(overrides: Partial<PeopleSyncPlan> = {}): PeopleSyncReview {
  const plan: PeopleSyncPlan = {
    ...emptyBuckets(),
    provider: 'planning_center',
    authoritative: true,
    snapshot: { fetchedAt: '2026-08-02T01:00:00.000Z', mode: 'full' },
    people: {
      external: {
        'ext-match': { firstName: 'Source', lastName: 'Match', family: { state: 'none' } },
        'ext-held': { firstName: 'Source', lastName: 'Held', family: { state: 'none' } },
      },
      local: {
        '7': { firstName: 'Local', lastName: 'Match', family: { state: 'none' } },
        '8': { firstName: 'Local', lastName: 'Archive', family: { state: 'none' } },
        '9': { firstName: 'Local', lastName: 'Restore', family: { state: 'none' } },
      },
    },
    reviewContext: {
      version: 2,
      manualCandidateIndividualIds: [7],
      identities: {
        'ext-match': {
          suggestedIndividualId: 7,
          candidateIndividualIds: [7],
          excludedIndividualIds: [],
          held: false,
          canCreate: true,
          createPerson: {
            firstName: 'Source', lastName: 'Match', isChild: false,
            externalFamilyId: null, peopleType: 'regular',
          },
        },
        'ext-held': {
          suggestedIndividualId: null,
          candidateIndividualIds: [],
          excludedIndividualIds: [],
          held: true,
          canCreate: true,
          createPerson: {
            firstName: 'Source', lastName: 'Held', isChild: false,
            externalFamilyId: null, peopleType: 'regular',
          },
        },
      },
    },
    ...overrides,
  };
  return {
    runId: 10,
    reviewToken: 'review-token',
    decisionContractVersion: 2,
    summary: summaryFor(plan),
    plan,
    snapshot: plan.snapshot,
  };
}

function SectionsHarness({ review, initialState }: { review: PeopleSyncReview; initialState?: SyncSelectionState }) {
  const [state, setState] = useState(initialState || initializeSyncSelectionState(review));
  const archiveActions = review.plan.archive;
  return (
    <SyncPlanSections
      review={review}
      state={state}
      archiveActions={archiveActions}
      onStateChange={setState}
      onAcceptAllArchives={() => setState((current) => ({
        ...current,
        acceptedArchiveIds: new Set([
          ...current.acceptedArchiveIds,
          ...archiveActions.map((action) => action.individualId),
        ]),
      }))}
    />
  );
}

describe('SyncPlanSections', () => {
  it('omits empty sections and keeps routine managed changes collapsed', () => {
    const review = reviewFixture({
      updateManagedFields: [{
        id: 'update:7', externalPersonId: 'ext-match', individualId: 7,
        changes: [{ field: 'firstName', localValue: 'Old', externalValue: 'Local' }],
        reason: 'provider_managed_fields', reviewRequired: false,
      }],
    });

    render(<SectionsHarness review={review} />);

    const managed = screen.getByText('Managed person updates').closest('details');
    expect(managed).not.toHaveAttribute('open');
    expect(screen.queryByText('Family changes')).not.toBeInTheDocument();
    expect(screen.queryByText('Gathering changes')).not.toBeInTheDocument();
    expect(screen.queryByText('Lifecycle review')).not.toBeInTheDocument();
    expect(screen.queryByText('Skipped or unchanged')).not.toBeInTheDocument();
  });

  it('renders terminal archive proposals in lifecycle review and accepts all without selecting a local-only person', async () => {
    const user = userEvent.setup();
    const review = reviewFixture({
      archive: [
        {
          id: 'archive:8', externalPersonId: 'ext-archived', individualId: 8,
          reason: 'provider_state_archived', missingFullSyncCount: null,
        },
        {
          id: 'archive:9', externalPersonId: 'ext-deceased', individualId: 9,
          reason: 'provider_state_deceased', missingFullSyncCount: null,
        },
      ],
      unmatchedLocalRegulars: [{
        id: 'unmatchedLocalRegular:7', individualId: 7,
        reason: 'no_authority_link', reviewRequired: true,
      }],
      renameFamily: [{ id: 'renameFamily:20', familyId: 20, familyName: 'Renamed household', reason: 'provider_household_changed' }],
      removeFromGathering: [{
        id: 'remove:8', batchId: 1, gatheringTypeId: 2, individualId: 8,
        reason: 'no_longer_eligible',
      }],
    });

    render(<SectionsHarness review={review} />);

    expect(screen.getByText('Lifecycle review').closest('details')).toHaveAttribute('open');
    expect(screen.getByText('Gathering changes').closest('details')).toHaveAttribute('open');
    expect(screen.getByText('Family changes').closest('details')).toHaveAttribute('open');
    expect(screen.getByText('Archived in the provider')).toBeInTheDocument();
    expect(screen.getByText('Marked deceased in the provider')).toBeInTheDocument();

    const archived = screen.getByRole('checkbox', { name: 'Archive Local Archive' });
    const deceased = screen.getByRole('checkbox', { name: 'Archive Local Restore' });
    const rename = screen.getByRole('checkbox', { name: 'Accept family rename to Renamed household' });
    await user.click(screen.getByRole('button', { name: 'Accept all proposed archives' }));
    await user.click(rename);
    expect(archived).toBeChecked();
    expect(deceased).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Archive Local Match' })).not.toBeInTheDocument();
    expect(rename).toBeChecked();
  });

  it('does not render lifecycle review when there are no archive proposals', () => {
    const review = reviewFixture({
      reactivate: [{
        id: 'reactivate:9', externalPersonId: 'ext-restored', individualId: 9,
        reason: 'provider_state_active',
      }],
    });

    render(<SectionsHarness review={review} />);

    expect(screen.queryByText('Lifecycle review')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept all proposed archives' })).not.toBeInTheDocument();
  });

  it('derives downstream disclosures from the current identity decisions', async () => {
    const user = userEvent.setup();
    const review = reviewFixture({
      updateManagedFields: [{
        id: 'update:7', externalPersonId: 'ext-match', individualId: 7,
        changes: [{ field: 'firstName', localValue: 'Old', externalValue: 'Local' }],
        reason: 'provider_managed_fields', reviewRequired: false,
      }],
      addToGathering: [{
        id: 'gathering:7', batchId: 1, gatheringTypeId: 2, externalPersonId: 'ext-match',
        individualId: 7, eligibleBatchIds: [1], reason: 'batch_eligible',
      }],
    });
    const initialState = initializeSyncSelectionState(review);

    function DecisionHarness() {
      const [state, setState] = useState(initialState);
      return (
        <>
          <button type="button" onClick={() => setState((current) => ({
            ...current,
            identityDecisions: { ...current.identityDecisions, 'ext-match': { outcome: 'create' } },
          }))}>
            Add source match instead
          </button>
          <SyncPlanSections
            review={review}
            state={state}
            archiveActions={review.plan.archive}
            onStateChange={setState}
            onAcceptAllArchives={() => {}}
          />
        </>
      );
    }

    render(<DecisionHarness />);
    expect(screen.getByText('Update Local Match')).toBeInTheDocument();
    expect(screen.getByText('Add Source Match to a gathering')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add source match instead' }));
    expect(screen.queryByText('Update Local Match')).not.toBeInTheDocument();
    expect(screen.queryByText('Add Source Match to a gathering')).not.toBeInTheDocument();
  });

  it('removes a new person gathering addition when its identity changes from create to defer', async () => {
    const user = userEvent.setup();
    const review = reviewFixture({
      addPeople: [{
        id: 'add:ext-held', externalPersonId: 'ext-held', firstName: 'Source', lastName: 'Held',
        isChild: false, peopleType: 'regular', externalFamilyId: null,
        reason: 'no_match', reviewRequired: true,
      }],
      addToGathering: [{
        id: 'gathering:ext-held', batchId: 1, gatheringTypeId: 2, externalPersonId: 'ext-held',
        individualId: null, eligibleBatchIds: [1], reason: 'batch_eligible',
      }],
    });
    const initialState = initializeSyncSelectionState(review);
    initialState.identityDecisions = {
      ...initialState.identityDecisions,
      'ext-held': { outcome: 'create' },
    };

    function DecisionHarness() {
      const [state, setState] = useState(initialState);
      return (
        <>
          <button type="button" onClick={() => setState((current) => ({
            ...current,
            identityDecisions: { ...current.identityDecisions, 'ext-held': { outcome: 'defer' } },
          }))}>
            Decide later
          </button>
          <SyncPlanSections
            review={review}
            state={state}
            archiveActions={review.plan.archive}
            onStateChange={setState}
            onAcceptAllArchives={() => {}}
          />
        </>
      );
    }

    render(<DecisionHarness />);
    expect(screen.getByText('Add Source Held to a gathering')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Decide later' }));

    expect(screen.queryByText('Add Source Held to a gathering')).not.toBeInTheDocument();
    expect(screen.getByText('Source Held will be skipped for now.')).toBeInTheDocument();
  });
});
