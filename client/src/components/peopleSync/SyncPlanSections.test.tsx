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
      operationKind="people_sync"
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
  it('fails closed at runtime when an untyped caller omits the operation kind', () => {
    const review = reviewFixture({
      updateManagedFields: [{
        id: 'update:7', externalPersonId: 'ext-match', individualId: 7,
        changes: [{ field: 'firstName', localValue: 'Old', externalValue: 'Local' }],
        reason: 'provider_managed_fields', reviewRequired: false,
      }],
    });
    const state = initializeSyncSelectionState(review);

    render(React.createElement(SyncPlanSections, {
      review,
      state,
      archiveActions: [],
      onStateChange: () => {},
      onAcceptAllArchives: () => {},
    } as never));

    expect(screen.queryByLabelText('Planned non-identity changes')).not.toBeInTheDocument();
  });

  it('shows every read-only import outcome without exposing raw reasons or sync-only controls', () => {
    const review = reviewFixture({
      addPeople: [
        {
          id: 'add:ext-match', externalPersonId: 'ext-match', firstName: 'Source', lastName: 'Match',
          isChild: false, familyId: null, peopleType: 'regular',
          reason: 'sync_archive_managed_fields_correction', reviewRequired: true,
        },
        {
          id: 'add:ext-held', externalPersonId: 'ext-held', firstName: 'Source', lastName: 'Held',
          isChild: false, familyId: 'source-1', peopleType: 'local_visitor',
          reason: 'authority_requires_visitor', reviewRequired: true,
        },
      ],
      linkFamilies: [{
        id: 'linkFamily:source-2', externalFamilyId: 'source-2', familyId: 20,
        reason: 'sync_archive_managed_fields_correction',
      }],
      addFamilies: [{
        id: 'addFamily:source-1', externalFamilyId: 'source-1', familyName: 'Import Household',
        reason: 'sync_archive_managed_fields_correction',
      }],
      familyConflicts: [{
        id: 'familyConflict:source-3',
        externalFamilyId: 'source-3',
        memberExternalIds: ['ext-match', 'ext-held'],
        reason: 'sync_archive_managed_fields_correction',
      }],
      skipped: [{
        id: 'skipped:ext-skipped', externalPersonId: 'ext-skipped',
        reason: 'sync_archive_managed_fields_correction',
      }],
    });
    review.plan.people!.external['ext-skipped'] = {
      firstName: 'Source', lastName: 'Skipped', family: { state: 'none' },
    };
    review.plan.reviewContext!.identities['ext-held'].held = false;
    review.plan.reviewContext!.identities['ext-held'].createPerson!.peopleType = 'local_visitor';
    (review as PeopleSyncReview & { operationKind: string }).operationKind = 'people_import';
    (review.plan as PeopleSyncPlan & { operationKind: string }).operationKind = 'people_import';
    const state = initializeSyncSelectionState(review);
    state.identityDecisions = {
      ...state.identityDecisions,
      'ext-match': { outcome: 'create' },
      'ext-held': { outcome: 'create' },
    };

    const { container } = render(<SyncPlanSections
      operationKind="people_import"
      review={review}
      state={state}
      archiveActions={[]}
      onStateChange={() => {}}
      onAcceptAllArchives={() => {}}
    />);

    expect(screen.getByLabelText('Planned import outcomes')).toBeInTheDocument();
    expect(screen.getByText('Add Source Match as a regular.')).toBeInTheDocument();
    expect(screen.getByText('Add Source Held as a local visitor.')).toBeInTheDocument();
    expect(screen.getByText('Add family Import Household.')).toBeInTheDocument();
    expect(screen.getByText('Link a provider household to an existing LMPG family.')).toBeInTheDocument();
    expect(screen.getByText('The household containing Source Match and Source Held needs review and will not be added or linked.')).toBeInTheDocument();
    expect(screen.getByText('Source Skipped will not be imported in this review.')).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/sync_archive|managed_fields|authority_requires_visitor/i);
    expect(screen.queryByText('Managed person updates')).not.toBeInTheDocument();
    expect(screen.queryByText('Gathering changes')).not.toBeInTheDocument();
    expect(screen.queryByText('Lifecycle review')).not.toBeInTheDocument();
    expect(screen.queryByText('Reactivations')).not.toBeInTheDocument();
    expect(container.querySelector('button, input, select, textarea')).toBeNull();
  });

  it('fails closed when an import outcome section receives mismatched operation markers', () => {
    const review = reviewFixture({
      addFamilies: [{
        id: 'addFamily:source-1', externalFamilyId: 'source-1', familyName: 'Private Household',
      }],
    });
    (review as PeopleSyncReview & { operationKind: string }).operationKind = 'people_import';
    (review.plan as PeopleSyncPlan & { operationKind: string }).operationKind = 'people_sync';

    const { container } = render(<SyncPlanSections
      operationKind="people_import"
      review={review}
      state={initializeSyncSelectionState(review)}
      archiveActions={[]}
      onStateChange={() => {}}
      onAcceptAllArchives={() => {}}
    />);

    expect(screen.queryByLabelText('Planned import outcomes')).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent('Private Household');
  });

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

  it('shows local-only people in lifecycle review without archive controls', () => {
    const review = reviewFixture();
    review.coverage = {
      unlinkedActiveLocalRegulars: 2,
    } as PeopleSyncReview['coverage'];

    render(<SectionsHarness review={review} />);

    expect(screen.getByText('Lifecycle review').closest('details')).toHaveAttribute('open');
    expect(screen.getByText('Local-only people')).toBeInTheDocument();
    expect(screen.getByText(/2 active LMPG regular people are not linked/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review Not linked people' })).toHaveAttribute(
      'href',
      '/app/people?externalSource=unlinked',
    );
    expect(screen.queryByRole('button', { name: 'Accept all proposed archives' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Archive/ })).not.toBeInTheDocument();
  });

  it('renders terminal archive proposals in lifecycle review and accepts all without selecting a local-only person', async () => {
    const user = userEvent.setup();
    const review = reviewFixture({
      archive: [
        {
          id: 'archive:8', externalPersonId: 'ext-archived', individualId: 8,
          reason: 'provider_state_archived',
        },
        {
          id: 'archive:9', externalPersonId: 'ext-deceased', individualId: 9,
          reason: 'provider_state_deceased',
        },
      ],
      renameFamily: [{ id: 'renameFamily:20', familyId: 20, familyName: 'Renamed household', reason: 'provider_household_changed' }],
      removeFromGathering: [{
        id: 'remove:8', batchId: 1, gatheringTypeId: 2, individualId: 8,
        reason: 'no_longer_eligible',
      }],
    });
    review.coverage = {
      unlinkedActiveLocalRegulars: 1,
    } as PeopleSyncReview['coverage'];

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

  it('does not surface legacy absence archive actions as lifecycle proposals', () => {
    const review = reviewFixture({
      archive: [{
        id: 'archive:legacy:8',
        externalPersonId: 'legacy-missing',
        individualId: 8,
        reason: 'confirmed_missing_full_sync',
      }],
    });

    render(<SectionsHarness review={review} />);

    expect(screen.queryByText('Lifecycle review')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Archive Local Archive' })).not.toBeInTheDocument();
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
            operationKind="people_sync"
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
            operationKind="people_sync"
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
