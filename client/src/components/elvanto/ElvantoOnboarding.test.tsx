import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { elvantoSyncAPI, gatheringsAPI, peopleSyncAPI } from '../../services/api';
import ElvantoOnboarding, { type ElvantoOnboardingStep } from './ElvantoOnboarding';
import type { PeopleSyncBatch, PeopleSyncReview } from '../peopleSync/types';

vi.mock('../../services/api', () => ({
  integrationsAPI: { connectElvanto: vi.fn() },
  elvantoSyncAPI: { createBatch: vi.fn(), getBatchPlan: vi.fn(), applyBatch: vi.fn(), listBatches: vi.fn() },
  gatheringsAPI: { getAll: vi.fn(), create: vi.fn() },
  peopleSyncAPI: { previewAuthority: vi.fn(), applyAuthority: vi.fn() },
}));

vi.mock('../peopleSync/BatchSourceControls', () => ({
  default: ({ onChange }: { onChange: (source: { sourceKind: 'elvanto_group'; sourceExternalId: string }) => void }) => (
    <button type="button" onClick={() => onChange({ sourceKind: 'elvanto_group', sourceExternalId: 'group-youth' })}>Choose Youth Group</button>
  ),
}));

vi.mock('../peopleSync/SyncReview', async () => {
  const ReactModule = await import('react');
  return {
    default: ({ onApply, onRefresh }: {
      onApply: (reviewToken: string, selections: Record<string, never>) => void | Promise<void>;
      onRefresh: () => void | Promise<void>;
    }) => {
      const [stale, setStale] = ReactModule.useState(false);
      return (
        <section aria-label="Elvanto source review">
          <p>Elvanto sync review</p>
          {!stale && <button type="button" onClick={async () => {
            try { await onApply('review-token', {}); } catch (cause) {
              if ((cause as { response?: { data?: { code?: string } } }).response?.data?.code === 'SYNC_PLAN_STALE') setStale(true);
            }
          }}>Apply reviewed source</button>}
          {stale && <button type="button" onClick={() => void onRefresh()}>Refresh plan</button>}
        </section>
      );
    },
  };
});

const draftBatch = {
  id: 42, provider: 'elvanto', name: 'Youth Group', enabled: true,
  source: null, sourceRevision: 0,
  draftSource: { kind: 'elvanto_group', externalId: 'group-youth', name: 'Youth Group', memberCount: null, providerRefreshedAt: null },
  draftSourceBaseRevision: 0, draftSourceUpdatedAt: '2026-07-29T00:00:00.000Z', needsSourceReview: true,
  initialSourceReviewPending: true, sourceStatus: 'unknown', sourceStatusCheckedAt: null, sourceStatusErrorCode: null,
  defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
  scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1,
  legacyProviderBatchId: null, lastExternalWatermark: null, lastSyncAt: null, lastSyncResult: null,
} as PeopleSyncBatch;

const review: PeopleSyncReview = {
  runId: 17, reviewToken: 'review-token', snapshot: { fetchedAt: '2026-07-29T00:00:00.000Z', mode: 'full' },
  plan: {
    provider: 'elvanto', authoritative: false, snapshot: { fetchedAt: '2026-07-29T00:00:00.000Z', mode: 'full' },
    linkPeople: [], linkFamilies: [], addPeople: [], addFamilies: [], updateManagedFields: [], promoteToRegular: [],
    demoteToLocalVisitor: [], archive: [], reactivate: [], moveFamily: [], renameFamily: [], addToGathering: [],
    removeFromGathering: [], ambiguousPeople: [], familyConflicts: [], unmatchedLocalRegulars: [], skipped: [],
  },
  summary: {
    linkPeople: 0, linkFamilies: 0, addPeople: 0, addFamilies: 0, updateManagedFields: 0, promoteToRegular: 0,
    demoteToLocalVisitor: 0, archive: 0, reactivate: 0, moveFamily: 0, renameFamily: 0, addToGathering: 0,
    removeFromGathering: 0, ambiguousPeople: 0, familyConflicts: 0, unmatchedLocalRegulars: 0, skipped: 0,
  },
};

const promotedBatch = {
  ...draftBatch,
  source: { kind: 'elvanto_group', externalId: 'group-youth', name: 'Youth Group', memberCount: null, providerRefreshedAt: null },
  sourceRevision: 1, draftSource: null, draftSourceBaseRevision: null, draftSourceUpdatedAt: null,
  needsSourceReview: false, initialSourceReviewPending: false, sourceStatus: 'available',
} as PeopleSyncBatch;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

function Harness() {
  const [step, setStep] = useState<ElvantoOnboardingStep>('elvanto-batch');
  return <ElvantoOnboarding step={step} onStepChange={setStep} onContinueToGatherings={vi.fn()} />;
}

describe('ElvantoOnboarding source review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(elvantoSyncAPI.createBatch).mockResolvedValue({ data: { batch: draftBatch } });
    vi.mocked(elvantoSyncAPI.getBatchPlan).mockResolvedValue({ data: review });
    vi.mocked(elvantoSyncAPI.applyBatch).mockResolvedValue({ data: { success: true, runId: 17, status: 'applied', applied: {}, summary: review.summary } });
    vi.mocked(elvantoSyncAPI.listBatches).mockResolvedValue({ data: { batches: [promotedBatch] } });
    vi.mocked(gatheringsAPI.getAll).mockResolvedValue({ data: { gatherings: [] } });
  });

  it('creates a pending Group source draft, then waits for its promoted state after reviewed apply', async () => {
    const refreshedBatches = deferred<{ data: { batches: PeopleSyncBatch[] } }>();
    vi.mocked(elvantoSyncAPI.listBatches).mockImplementationOnce(
      () => refreshedBatches.promise as ReturnType<typeof elvantoSyncAPI.listBatches>,
    );
    render(<Harness />);

    expect(screen.getByText(/Choose one Elvanto Category or Group/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose Youth Group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create batch' }));

    await waitFor(() => expect(elvantoSyncAPI.createBatch).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: 'elvanto_group', sourceExternalId: 'group-youth',
    })));
    await waitFor(() => expect(elvantoSyncAPI.getBatchPlan).toHaveBeenCalledWith(42));
    expect(await screen.findByText(/promotes the selected people source/)).toBeInTheDocument();
    expect(screen.queryByText('Keep LMPG aligned with Elvanto?')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Apply reviewed source' }));
    await waitFor(() => expect(elvantoSyncAPI.applyBatch).toHaveBeenCalledWith(42, {
      reviewToken: 'review-token', selections: {},
    }));
    expect(elvantoSyncAPI.listBatches).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Keep LMPG aligned with Elvanto?')).not.toBeInTheDocument();
    await act(async () => { refreshedBatches.resolve({ data: { batches: [promotedBatch] } }); });
    expect(await screen.findByText('Keep LMPG aligned with Elvanto?')).toBeInTheDocument();
  });

  it('requires batch creation to return a pending source draft before it can begin review', async () => {
    vi.mocked(elvantoSyncAPI.createBatch).mockResolvedValue({ data: {
      batch: { ...draftBatch, draftSource: null, needsSourceReview: false, initialSourceReviewPending: false },
    } });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose Youth Group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create batch' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('did not create a reviewable people source draft');
    expect(elvantoSyncAPI.getBatchPlan).not.toHaveBeenCalled();
    expect(screen.queryByText('Keep LMPG aligned with Elvanto?')).not.toBeInTheDocument();
  });

  it('propagates stale apply errors to the shared review so only plan refresh is offered', async () => {
    vi.mocked(elvantoSyncAPI.applyBatch).mockRejectedValue({
      response: { data: { code: 'SYNC_PLAN_STALE', error: 'The review is stale.' } },
    });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose Youth Group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create batch' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply reviewed source' }));

    expect(await screen.findByRole('button', { name: 'Refresh plan' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply reviewed source' })).not.toBeInTheDocument();
    expect(elvantoSyncAPI.applyBatch).toHaveBeenCalledTimes(1);
  });

  it('never reapplies after apply succeeds but promoted-batch refresh fails', async () => {
    vi.mocked(elvantoSyncAPI.listBatches).mockRejectedValueOnce(new Error('refresh unavailable'));
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose Youth Group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create batch' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply reviewed source' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/applied.*could not be confirmed/i);
    expect(screen.queryByRole('button', { name: 'Apply reviewed source' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry source refresh' })).toBeInTheDocument();
    expect(elvantoSyncAPI.applyBatch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry source refresh' }));
    expect(await screen.findByText('Keep LMPG aligned with Elvanto?')).toBeInTheDocument();
    expect(elvantoSyncAPI.applyBatch).toHaveBeenCalledTimes(1);
  });
});
