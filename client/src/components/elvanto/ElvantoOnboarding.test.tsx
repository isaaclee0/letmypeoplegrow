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
  peopleSyncAPI: { previewAuthority: vi.fn(), cancelAuthorityPreview: vi.fn(), applyAuthority: vi.fn() },
}));

vi.mock('../peopleSync/BatchSourceControls', () => ({
  default: ({ onChange }: { onChange: (source: { sourceKind: 'elvanto_group'; sourceExternalId: string }) => void }) => (
    <button type="button" onClick={() => onChange({ sourceKind: 'elvanto_group', sourceExternalId: 'group-youth' })}>Choose Youth Group</button>
  ),
}));

vi.mock('../peopleSync/SyncReview', async () => {
  const ReactModule = await import('react');
  return {
    default: ({ review: renderedReview, onApply, onRefresh, applying, interactionDisabled }: {
      review: PeopleSyncReview;
      onApply: (reviewToken: string, selections: Record<string, never>) => void | Promise<void>;
      onRefresh: () => void | Promise<void>;
      applying?: boolean;
      interactionDisabled?: boolean;
    }) => {
      const [stale, setStale] = ReactModule.useState(false);
      const disabled = Boolean(applying || interactionDisabled);
      return (
        <section aria-label="Elvanto source review">
          <p>Elvanto sync review</p>
          {!stale && <button type="button" disabled={disabled} onClick={async () => {
            try { await onApply(renderedReview.reviewToken, {}); } catch (cause) {
              if ((cause as { response?: { data?: { code?: string } } }).response?.data?.code === 'SYNC_PLAN_STALE') setStale(true);
            }
          }}>Apply reviewed source</button>}
          <button type="button" disabled={disabled} onClick={() => void onRefresh()}>Refresh plan</button>
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

const authorityReview: PeopleSyncReview = {
  ...review,
  reviewToken: 'authority-review-token',
  authorityPreviewId: 'authority-preview-1',
  authority: { active: 'none', pending: 'elvanto' },
  plan: { ...review.plan, authoritative: true },
};

const promotedBatch = {
  ...draftBatch,
  source: { kind: 'elvanto_group', externalId: 'group-youth', name: 'Youth Group', memberCount: null, providerRefreshedAt: null },
  sourceRevision: 1, draftSource: null, draftSourceBaseRevision: null, draftSourceUpdatedAt: null,
  needsSourceReview: false, initialSourceReviewPending: false, sourceStatus: 'available',
} as PeopleSyncBatch;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function Harness() {
  const [step, setStep] = useState<ElvantoOnboardingStep>('elvanto-batch');
  return <ElvantoOnboarding step={step} onStepChange={setStep} onContinueToGatherings={vi.fn()} />;
}

function AuthorityHarness({ onContinue = vi.fn() }: { onContinue?: () => void }) {
  return (
    <ElvantoOnboarding
      step="elvanto-authority"
      onStepChange={vi.fn()}
      onContinueToGatherings={onContinue}
    />
  );
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

describe('ElvantoOnboarding authority review lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(peopleSyncAPI.cancelAuthorityPreview).mockResolvedValue({
      data: { success: true, authority: { active: 'none', pending: null } },
    });
    vi.mocked(peopleSyncAPI.applyAuthority).mockResolvedValue({
      data: { success: true, runId: 17, status: 'applied', applied: {} as never, summary: review.summary },
    });
  });

  it('exact-cancels the owned preview when the reviewer cancels onboarding authority', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...authorityReview } });
    render(<AuthorityHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'Use Elvanto as source of truth' }));
    expect(await screen.findByRole('region', { name: 'Elvanto onboarding authority review' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel authority change' }));

    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledWith(
      'elvanto',
      'authority-preview-1',
    ));
    expect(screen.queryByRole('region', { name: 'Elvanto onboarding authority review' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use Elvanto as source of truth' })).toBeInTheDocument();
  });

  it('keeps failed exact cancellation recoverable in the onboarding review', async () => {
    const terminalFailure = {
      response: { status: 403, data: { error: 'The onboarding cancellation could not be confirmed.' } },
    };
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...authorityReview } });
    vi.mocked(peopleSyncAPI.cancelAuthorityPreview)
      .mockRejectedValueOnce(terminalFailure)
      .mockResolvedValueOnce({ data: { success: true, authority: { active: 'none', pending: null } } });
    render(<AuthorityHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'Use Elvanto as source of truth' }));
    expect(await screen.findByRole('region', { name: 'Elvanto onboarding authority review' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel authority change' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The onboarding cancellation could not be confirmed.');
    expect(screen.getByRole('button', { name: 'Cancel authority change' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel authority change' }));
    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('region', { name: 'Elvanto onboarding authority review' })).not.toBeInTheDocument();
  });

  it('exact-cancels an accepted authority preview when onboarding unmounts', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...authorityReview } });
    const { unmount } = render(<AuthorityHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'Use Elvanto as source of truth' }));
    expect(await screen.findByRole('region', { name: 'Elvanto onboarding authority review' })).toBeInTheDocument();
    unmount();

    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledWith(
      'elvanto',
      'authority-preview-1',
    ));
  });

  it('retries the same exact owned preview after onboarding unmount cancellation fails', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...authorityReview } });
    vi.mocked(peopleSyncAPI.cancelAuthorityPreview).mockReset();
    vi.mocked(peopleSyncAPI.cancelAuthorityPreview)
      .mockRejectedValueOnce(new Error('temporary cancellation outage'))
      .mockResolvedValueOnce({ data: { success: true, authority: { active: 'none', pending: null } } });
    const { unmount } = render(<AuthorityHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'Use Elvanto as source of truth' }));
    expect(await screen.findByRole('region', { name: 'Elvanto onboarding authority review' })).toBeInTheDocument();
    unmount();

    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledTimes(2));
    expect(vi.mocked(peopleSyncAPI.cancelAuthorityPreview).mock.calls).toEqual([
      ['elvanto', 'authority-preview-1'],
      ['elvanto', 'authority-preview-1'],
    ]);
  });

  it('keeps retrying an explicit onboarding cancel after unmount', async () => {
    const firstCancel = deferred<never>();
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...authorityReview } });
    vi.mocked(peopleSyncAPI.cancelAuthorityPreview).mockReset();
    vi.mocked(peopleSyncAPI.cancelAuthorityPreview)
      .mockImplementationOnce(() => firstCancel.promise as ReturnType<typeof peopleSyncAPI.cancelAuthorityPreview>)
      .mockResolvedValueOnce({ data: { success: true, authority: { active: 'none', pending: null } } });
    const { unmount } = render(<AuthorityHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'Use Elvanto as source of truth' }));
    expect(await screen.findByRole('region', { name: 'Elvanto onboarding authority review' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel authority change' }));
    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => firstCancel.reject(new Error('temporary cancellation outage')));

    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledTimes(2));
    expect(vi.mocked(peopleSyncAPI.cancelAuthorityPreview).mock.calls).toEqual([
      ['elvanto', 'authority-preview-1'],
      ['elvanto', 'authority-preview-1'],
    ]);
  });

  it('exact-cancels a preview that resolves after onboarding unmounts', async () => {
    const pending = deferred<{ data: { success: true } & PeopleSyncReview }>();
    vi.mocked(peopleSyncAPI.previewAuthority).mockImplementation(
      () => pending.promise as ReturnType<typeof peopleSyncAPI.previewAuthority>,
    );
    const { unmount } = render(<AuthorityHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'Use Elvanto as source of truth' }));
    await waitFor(() => expect(peopleSyncAPI.previewAuthority).toHaveBeenCalledWith('elvanto'));
    unmount();
    await act(async () => pending.resolve({
      data: { ...authorityReview, success: true, authorityPreviewId: 'authority-preview-after-unmount' },
    }));

    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledWith(
      'elvanto',
      'authority-preview-after-unmount',
    ));
  });

  it('retires the old exact intent and removes its actionable review after refresh fails', async () => {
    const refresh = deferred<{ data: { success: true } & PeopleSyncReview }>();
    vi.mocked(peopleSyncAPI.previewAuthority)
      .mockResolvedValueOnce({ data: { success: true, ...authorityReview } })
      .mockImplementationOnce(() => refresh.promise as ReturnType<typeof peopleSyncAPI.previewAuthority>);
    render(<AuthorityHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'Use Elvanto as source of truth' }));
    expect(await screen.findByRole('region', { name: 'Elvanto onboarding authority review' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));
    expect(screen.getByRole('button', { name: 'Apply reviewed source' })).toBeDisabled();

    await act(async () => refresh.reject(new Error('refresh failed')));

    expect(await screen.findByRole('alert')).toHaveTextContent('refresh failed');
    expect(screen.queryByRole('region', { name: 'Elvanto onboarding authority review' })).not.toBeInTheDocument();
    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledWith(
      'elvanto',
      'authority-preview-1',
    ));
  });

  it('keeps review actions disabled when a superseded preview finishes before the newest preview', async () => {
    const older = deferred<{ data: { success: true } & PeopleSyncReview }>();
    const newest = deferred<{ data: { success: true } & PeopleSyncReview }>();
    vi.mocked(peopleSyncAPI.previewAuthority)
      .mockResolvedValueOnce({ data: { success: true, ...authorityReview } })
      .mockImplementationOnce(() => older.promise as ReturnType<typeof peopleSyncAPI.previewAuthority>)
      .mockImplementationOnce(() => newest.promise as ReturnType<typeof peopleSyncAPI.previewAuthority>);
    render(<AuthorityHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'Use Elvanto as source of truth' }));
    expect(await screen.findByRole('region', { name: 'Elvanto onboarding authority review' })).toBeInTheDocument();
    const refreshButton = screen.getByRole('button', { name: 'Refresh plan' });
    act(() => {
      refreshButton.click();
      refreshButton.click();
    });
    expect(peopleSyncAPI.previewAuthority).toHaveBeenCalledTimes(3);

    await act(async () => older.resolve({
      data: { ...authorityReview, success: true, reviewToken: 'older-token', authorityPreviewId: 'older-preview' },
    }));
    expect(screen.getByRole('button', { name: 'Apply reviewed source' })).toBeDisabled();

    await act(async () => newest.resolve({
      data: { ...authorityReview, success: true, reviewToken: 'newest-token', authorityPreviewId: 'newest-preview' },
    }));
    expect(screen.getByRole('button', { name: 'Apply reviewed source' })).toBeEnabled();
    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledWith(
      'elvanto',
      'authority-preview-1',
    ));
  });

  it('cancels an older late response and applies only the newest active review token', async () => {
    const older = deferred<{ data: { success: true } & PeopleSyncReview }>();
    const newest = deferred<{ data: { success: true } & PeopleSyncReview }>();
    vi.mocked(peopleSyncAPI.previewAuthority)
      .mockResolvedValueOnce({ data: { success: true, ...authorityReview } })
      .mockImplementationOnce(() => older.promise as ReturnType<typeof peopleSyncAPI.previewAuthority>)
      .mockImplementationOnce(() => newest.promise as ReturnType<typeof peopleSyncAPI.previewAuthority>);
    render(<AuthorityHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'Use Elvanto as source of truth' }));
    expect(await screen.findByRole('region', { name: 'Elvanto onboarding authority review' })).toBeInTheDocument();
    const refreshButton = screen.getByRole('button', { name: 'Refresh plan' });
    act(() => {
      refreshButton.click();
      refreshButton.click();
    });

    await act(async () => newest.resolve({
      data: { ...authorityReview, success: true, reviewToken: 'newest-token', authorityPreviewId: 'newest-preview' },
    }));
    await act(async () => older.resolve({
      data: { ...authorityReview, success: true, reviewToken: 'older-token', authorityPreviewId: 'older-preview' },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply reviewed source' }));

    await waitFor(() => expect(peopleSyncAPI.applyAuthority).toHaveBeenCalledWith('elvanto', 'newest-token', {}));
    expect(peopleSyncAPI.applyAuthority).not.toHaveBeenCalledWith('elvanto', 'older-token', {});
    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledWith(
      'elvanto',
      'older-preview',
    ));
  });
});
