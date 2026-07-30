import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PlanningCenterSyncReview from './PlanningCenterSyncReview';
import { integrationsAPI } from '../../services/api';
import type { PeopleSyncPlan, PeopleSyncReview } from '../peopleSync/types';

vi.mock('../../services/api', () => ({
  integrationsAPI: {
    getPlanningCenterBatchPlan: vi.fn(),
    applyPlanningCenterBatch: vi.fn(),
  },
}));
vi.mock('../../utils/logger', () => ({ default: { error: vi.fn() } }));

const plan: PeopleSyncPlan = {
  provider: 'planning_center', authoritative: false,
  snapshot: { fetchedAt: '2026-07-27T00:00:00.000Z', mode: 'full' },
  linkPeople: [], linkFamilies: [], addPeople: [], addFamilies: [], updateManagedFields: [],
  promoteToRegular: [], demoteToLocalVisitor: [], archive: [], reactivate: [], moveFamily: [],
  renameFamily: [], addToGathering: [], removeFromGathering: [], ambiguousPeople: [],
  familyConflicts: [], unmatchedLocalRegulars: [], skipped: [],
};
const review: PeopleSyncReview = {
  runId: 7, reviewToken: 'pco-review-7', plan, snapshot: plan.snapshot,
  summary: {
    linkPeople: 0, linkFamilies: 0, addPeople: 0, addFamilies: 0, updateManagedFields: 0,
    promoteToRegular: 0, demoteToLocalVisitor: 0, archive: 0, reactivate: 0, moveFamily: 0,
    renameFamily: 0, addToGathering: 0, removeFromGathering: 0, ambiguousPeople: 0,
    familyConflicts: 0, unmatchedLocalRegulars: 0, skipped: 0,
  },
};

describe('PlanningCenterSyncReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(integrationsAPI.getPlanningCenterBatchPlan).mockResolvedValue({ data: { success: true, ...review } });
    vi.mocked(integrationsAPI.applyPlanningCenterBatch).mockResolvedValue({
      data: { success: true, runId: 7, status: 'applied', applied: {} as never, summary: review.summary },
    });
  });

  it('loads the shared review without applying and submits its exact token only after approval', async () => {
    render(<MemoryRouter><PlanningCenterSyncReview connected batchId={7} /></MemoryRouter>);

    expect(await screen.findByText('Planning Center sync review')).toBeInTheDocument();
    expect(integrationsAPI.applyPlanningCenterBatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Apply sync' })[0]);

    await waitFor(() => expect(integrationsAPI.applyPlanningCenterBatch).toHaveBeenCalledWith(7, {
      reviewToken: 'pco-review-7', selections: expect.any(Object),
    }));
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
    fireEvent.click(screen.getAllByRole('button', { name: 'Apply sync' })[0]);
    expect(await screen.findByText('This legacy batch has been retired. Reload the page to view or delete it.')).toBeInTheDocument();
  });

  it('explains a retired batch when a stale page refreshes an already loaded review', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterBatchPlan)
      .mockResolvedValueOnce({ data: { success: true, ...review } })
      .mockRejectedValueOnce({ response: { data: { code: 'PCO_LEGACY_BATCH_RETIRED', error: 'Batch retired.' } } });
    render(<MemoryRouter><PlanningCenterSyncReview connected batchId={7} /></MemoryRouter>);

    expect(await screen.findByText('Planning Center sync review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh from Planning Center' }));
    expect(await screen.findByText('This legacy batch has been retired. Reload the page to view or delete it.')).toBeInTheDocument();
  });
});
