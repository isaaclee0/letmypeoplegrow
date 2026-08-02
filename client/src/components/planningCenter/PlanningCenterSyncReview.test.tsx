import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PlanningCenterSyncReview from './PlanningCenterSyncReview';
import { integrationsAPI } from '../../services/api';
import type { PeopleSyncPlan, PeopleSyncReview } from '../peopleSync/types';

vi.mock('../../services/api', () => ({
  integrationsAPI: {
    getPlanningCenterBatchPlan: vi.fn(),
    previewPlanningCenterLinkCorrections: vi.fn(),
    applyPlanningCenterBatch: vi.fn(),
  },
}));
vi.mock('../../utils/logger', () => ({ default: { error: vi.fn() } }));

const plan: PeopleSyncPlan = {
  provider: 'planning_center', authoritative: false,
  snapshot: { fetchedAt: '2026-07-27T00:00:00.000Z', mode: 'full' },
  people: {
    external: {
      'pco-1': { firstName: 'Alex', lastName: 'Smith', family: { state: 'none' } },
    },
    local: {
      '7': { firstName: 'Alex', lastName: 'Smith', matchEligible: true, family: { state: 'none' } },
      '8': { firstName: 'Alex', lastName: 'Jones', matchEligible: true, family: { state: 'none' } },
    },
  },
  reviewContext: {
    version: 2,
    manualCandidateIndividualIds: [7, 8],
    identities: {
      'pco-1': {
        suggestedIndividualId: 7, candidateIndividualIds: [7], excludedIndividualIds: [],
        held: false, canCreate: true,
        createPerson: { firstName: 'Alex', lastName: 'Smith', isChild: false, externalFamilyId: null, peopleType: 'regular' },
      },
    },
  },
  linkPeople: [{ id: 'link:pco-1', externalPersonId: 'pco-1', individualId: 7, reason: 'unique_name', reviewRequired: false }],
  linkFamilies: [], addPeople: [], addFamilies: [], updateManagedFields: [],
  promoteToRegular: [], demoteToLocalVisitor: [], archive: [], reactivate: [], moveFamily: [],
  renameFamily: [], addToGathering: [], removeFromGathering: [], ambiguousPeople: [],
  familyConflicts: [], unmatchedLocalRegulars: [], skipped: [],
};
const review: PeopleSyncReview = {
  runId: 7, reviewToken: 'pco-review-7', decisionContractVersion: 2, plan, snapshot: plan.snapshot,
  summary: {
    linkPeople: 1, linkFamilies: 0, addPeople: 0, addFamilies: 0, updateManagedFields: 0,
    promoteToRegular: 0, demoteToLocalVisitor: 0, archive: 0, reactivate: 0, moveFamily: 0,
    renameFamily: 0, addToGathering: 0, removeFromGathering: 0, ambiguousPeople: 0,
    familyConflicts: 0, unmatchedLocalRegulars: 0, skipped: 0,
  },
};

function establishedReview(reviewToken: string, replacementId = 40): PeopleSyncReview {
  return {
    ...review,
    reviewToken,
    plan: {
      ...review.plan,
      people: {
        external: {
          ...review.plan.people!.external,
          'pco-established': { firstName: 'Established', lastName: 'Source', family: { state: 'none' } },
        },
        local: {
          ...review.plan.people!.local,
          '30': { firstName: 'Replacement', lastName: 'Local', matchEligible: true, family: { state: 'none' } },
          '40': { firstName: 'Current', lastName: 'Link', matchEligible: true, family: { state: 'none' } },
        },
      },
      reviewContext: {
        ...review.plan.reviewContext!,
        correctionContractVersion: 1,
        manualCandidateIndividualIds: [7, 8, 30, 40],
        establishedLinks: { 'pco-established': { individualId: 40 } },
        projectedEstablishedLinks: { 'pco-established': { individualId: replacementId } },
        linkCorrections: replacementId === 40 ? [] : [{
          externalPersonId: 'pco-established', outcome: 'relink', fromIndividualId: 40, individualId: replacementId,
        }],
      },
    },
  };
}

describe('PlanningCenterSyncReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(integrationsAPI.getPlanningCenterBatchPlan).mockResolvedValue({ data: { success: true, ...review } });
    vi.mocked(integrationsAPI.applyPlanningCenterBatch).mockResolvedValue({
      data: { success: true, runId: 7, status: 'applied', applied: {} as never, summary: review.summary },
    });
  });

  it('renders onboarding batch context with one small refresh and one bottom apply action', async () => {
    render(<MemoryRouter><PlanningCenterSyncReview
      connected
      batchId={7}
      batchName="Members"
      sourceName="Selected members"
    /></MemoryRouter>);

    expect(await screen.findByText('Planning Center sync review')).toBeInTheDocument();
    expect(screen.getByText('Members')).toBeInTheDocument();
    expect(screen.getByText('Selected members')).toBeInTheDocument();
    const refresh = screen.getByRole('button', { name: 'Refresh plan' });
    expect(refresh).toHaveClass('px-3', 'py-1.5', 'text-xs');
    expect(screen.queryByRole('button', { name: 'Refresh from Planning Center' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Apply \d+ selected changes?$/ })).toHaveLength(1);
    expect(integrationsAPI.applyPlanningCenterBatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Change LMPG match for Alex Smith' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Alex Jones' }));
    fireEvent.click(screen.getByRole('button', { name: /^Apply \d+ selected changes?$/ }));

    await waitFor(() => expect(integrationsAPI.applyPlanningCenterBatch).toHaveBeenCalledWith(7, {
      reviewToken: 'pco-review-7',
      selections: {
        decisionContractVersion: 2,
        identityDecisions: { 'pco-1': { outcome: 'link', individualId: 8 } },
        acceptArchiveIndividualIds: [],
        acceptFamilyRenameIds: [],
      },
    }));
  });

  it('advances onboarding after apply without fetching an obsolete follow-up review', async () => {
    const onApplied = vi.fn();
    render(<MemoryRouter><PlanningCenterSyncReview connected batchId={7} onApplied={onApplied} /></MemoryRouter>);

    expect(await screen.findByText('Planning Center sync review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Apply \d+ selected changes?$/ }));

    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(integrationsAPI.getPlanningCenterBatchPlan).toHaveBeenCalledTimes(1);
  });

  it('previews established-link corrections through the real batch owner and applies the signed token', async () => {
    const base = establishedReview('pco-base-review');
    const preview = establishedReview('pco-correction-preview', 30);
    vi.mocked(integrationsAPI.getPlanningCenterBatchPlan).mockResolvedValue({ data: { success: true, ...base } });
    vi.mocked(integrationsAPI.previewPlanningCenterLinkCorrections).mockResolvedValue({
      data: { success: true, ...preview },
    });
    render(<MemoryRouter><PlanningCenterSyncReview connected batchId={7} /></MemoryRouter>);

    await screen.findByText('Planning Center sync review');
    fireEvent.click(screen.getByRole('tab', { name: 'Already linked 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Correct linked person for Established Source' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Change linked person' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Select Replacement Local' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Correct linked person for Established Source' })).toHaveTextContent('Replacement Local'));
    expect(integrationsAPI.previewPlanningCenterLinkCorrections).toHaveBeenCalledWith(7, {
      baseReviewToken: 'pco-base-review',
      linkCorrections: {
        'pco-established': { outcome: 'relink', fromIndividualId: 40, individualId: 30 },
      },
    });

    fireEvent.click(screen.getByRole('button', { name: /^Apply \d+ selected changes?$/ }));
    await waitFor(() => expect(integrationsAPI.applyPlanningCenterBatch).toHaveBeenCalledWith(7, expect.objectContaining({
      reviewToken: 'pco-correction-preview',
      selections: expect.objectContaining({
        linkCorrections: {
          'pco-established': { outcome: 'relink', fromIndividualId: 40, individualId: 30 },
        },
      }),
    })));
  });

  it('offers a plan refresh instead of a blind apply retry when the review is stale', async () => {
    vi.mocked(integrationsAPI.applyPlanningCenterBatch).mockRejectedValue({
      response: { data: { code: 'SYNC_PLAN_STALE', error: 'The review is stale.' } },
    });
    render(<MemoryRouter><PlanningCenterSyncReview connected batchId={7} /></MemoryRouter>);

    expect(await screen.findByText('Planning Center sync review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Apply \d+ selected changes?$/ }));

    expect(await screen.findByText('This review is out of date.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Refresh plan' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^Apply \d+ selected changes?$/ })).toBeDisabled();
  });

  it('disables the consumed review until a failed post-apply plan refresh succeeds', async () => {
    const refreshedReview = { ...review, reviewToken: 'pco-review-8' };
    vi.mocked(integrationsAPI.getPlanningCenterBatchPlan)
      .mockResolvedValueOnce({ data: { success: true, ...review } })
      .mockRejectedValueOnce({ response: { data: { error: 'Could not refresh the applied plan.' } } })
      .mockResolvedValueOnce({ data: { success: true, ...refreshedReview } });
    render(<MemoryRouter><PlanningCenterSyncReview connected batchId={7} /></MemoryRouter>);

    expect(await screen.findByText('Planning Center sync review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Apply \d+ selected changes?$/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not refresh the applied plan.');
    expect(screen.queryByRole('button', { name: /^Apply \d+ selected changes?$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry plan refresh' })).toBeInTheDocument();
    expect(integrationsAPI.applyPlanningCenterBatch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry plan refresh' }));
    await waitFor(() => expect(integrationsAPI.getPlanningCenterBatchPlan).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Apply \d+ selected changes?$/ })).toBeEnabled());
    expect(integrationsAPI.applyPlanningCenterBatch).toHaveBeenCalledTimes(1);
  });

  it('disables apply and refresh actions while an ordinary plan refresh is pending', async () => {
    let resolveRefresh!: (value: { data: { success: true } & PeopleSyncReview }) => void;
    vi.mocked(integrationsAPI.getPlanningCenterBatchPlan)
      .mockResolvedValueOnce({ data: { success: true, ...review } })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    render(<MemoryRouter><PlanningCenterSyncReview connected batchId={7} /></MemoryRouter>);

    expect(await screen.findByText('Planning Center sync review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));
    expect(screen.getByRole('button', { name: 'Applying…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh plan' })).toBeDisabled();

    await act(async () => resolveRefresh({ data: { success: true, ...review, reviewToken: 'refreshed-token' } }));
  });

  it('explains a retired batch when a stale page loads its review', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterBatchPlan).mockRejectedValue({
      response: { data: { code: 'PCO_LEGACY_BATCH_RETIRED', error: 'Batch retired.' } },
    });
    render(<MemoryRouter><PlanningCenterSyncReview connected batchId={7} /></MemoryRouter>);

    expect(await screen.findByText('This legacy batch has been retired. Reload the page to view or delete it.')).toBeInTheDocument();
  });

  it('explains a retired batch when a stale page applies a reviewed plan', async () => {
    vi.mocked(integrationsAPI.applyPlanningCenterBatch).mockRejectedValue({
      response: { data: { code: 'PCO_LEGACY_BATCH_RETIRED', error: 'Batch retired.' } },
    });
    render(<MemoryRouter><PlanningCenterSyncReview connected batchId={7} /></MemoryRouter>);

    expect(await screen.findByText('Planning Center sync review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Apply \d+ selected changes?$/ }));
    expect(await screen.findByText('This legacy batch has been retired. Reload the page to view or delete it.')).toBeInTheDocument();
  });

  it('explains a retired batch when a stale page refreshes an already loaded review', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterBatchPlan)
      .mockResolvedValueOnce({ data: { success: true, ...review } })
      .mockRejectedValueOnce({ response: { data: { code: 'PCO_LEGACY_BATCH_RETIRED', error: 'Batch retired.' } } });
    render(<MemoryRouter><PlanningCenterSyncReview connected batchId={7} /></MemoryRouter>);

    expect(await screen.findByText('Planning Center sync review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));
    expect(await screen.findByText('This legacy batch has been retired. Reload the page to view or delete it.')).toBeInTheDocument();
  });
});
