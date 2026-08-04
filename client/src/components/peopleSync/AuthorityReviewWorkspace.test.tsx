import React, { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { peopleSyncAPI } from '../../services/api';
import AuthorityReviewWorkspace from './AuthorityReviewWorkspace';
import type { PeopleSyncPlan, PeopleSyncReview, SyncProvider } from './types';

vi.mock('../../services/api', () => ({
  peopleSyncAPI: {
    previewAuthority: vi.fn(),
    cancelAuthorityPreview: vi.fn(),
    applyAuthority: vi.fn(),
  },
}));

const plan: PeopleSyncPlan = {
  provider: 'elvanto',
  authoritative: true,
  snapshot: { fetchedAt: '2026-07-25T09:00:00.000Z', mode: 'full' },
  people: {
    external: { 'e-1': { firstName: 'Alex', lastName: 'Smith', family: { state: 'none' } } },
    local: {
      '1': { firstName: 'Alex', lastName: 'Smith', matchEligible: true, family: { state: 'none' } },
      '2': { firstName: 'Alex', lastName: 'Jones', matchEligible: true, family: { state: 'none' } },
    },
  },
  reviewContext: {
    version: 2,
    manualCandidateIndividualIds: [1, 2],
    identities: {
      'e-1': {
        suggestedIndividualId: 1,
        candidateIndividualIds: [1],
        excludedIndividualIds: [],
        held: false,
        canCreate: true,
        createPerson: {
          firstName: 'Alex', lastName: 'Smith', isChild: false,
          externalFamilyId: null, peopleType: 'regular',
        },
      },
    },
  },
  linkPeople: [{ id: 'link:1', externalPersonId: 'e-1', individualId: 1, reason: 'Matched', reviewRequired: false }],
  linkFamilies: [],
  addPeople: [
    { id: 'add:2', externalPersonId: 'e-2', firstName: 'Ada', lastName: 'Lovelace', isChild: false, familyId: null, peopleType: 'regular', reason: 'New', reviewRequired: true },
    { id: 'add:3', externalPersonId: 'e-3', firstName: 'Grace', lastName: 'Hopper', isChild: false, familyId: null, peopleType: 'regular', reason: 'New', reviewRequired: true },
  ],
  addFamilies: [],
  updateManagedFields: [
    { id: 'update:4', externalPersonId: 'e-4', individualId: 4, changes: [{ field: 'firstName', localValue: 'A', externalValue: 'B' }], reason: 'Changed', reviewRequired: false },
  ],
  promoteToRegular: [],
  demoteToLocalVisitor: [],
  archive: [],
  reactivate: [],
  moveFamily: [],
  renameFamily: [],
  addToGathering: [],
  removeFromGathering: [],
  ambiguousPeople: [],
  familyConflicts: [],
  unmatchedLocalRegulars: [],
  skipped: [],
};

const review: PeopleSyncReview = {
  runId: 10,
  reviewToken: 'authority-review',
  decisionContractVersion: 2,
  plan,
  snapshot: plan.snapshot,
  summary: {
    linkPeople: 1, linkFamilies: 0, addPeople: 2, addFamilies: 0, updateManagedFields: 1,
    promoteToRegular: 0, demoteToLocalVisitor: 0, archive: 0, reactivate: 0,
    moveFamily: 0, renameFamily: 0, addToGathering: 0, removeFromGathering: 0,
    ambiguousPeople: 0, familyConflicts: 0, unmatchedLocalRegulars: 0, skipped: 0,
  },
  authority: { active: 'planning_center', pending: 'elvanto' },
  authorityPreviewId: 'authority-preview-1',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function renderWorkspace({
  provider = 'elvanto',
  autoStart = true,
  onApplied = vi.fn().mockResolvedValue(undefined),
  onCancel = vi.fn(),
}: {
  provider?: SyncProvider;
  autoStart?: boolean;
  onApplied?: () => void | Promise<void>;
  onCancel?: () => void;
} = {}) {
  return {
    onApplied,
    onCancel,
    ...render(
      <AuthorityReviewWorkspace
        provider={provider}
        autoStart={autoStart}
        onApplied={onApplied}
        onCancel={onCancel}
      />,
    ),
  };
}

describe('AuthorityReviewWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(peopleSyncAPI.cancelAuthorityPreview).mockResolvedValue({
      data: { success: true, authority: { active: 'none', pending: null } },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-starts one preview for a provider under Strict Mode', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });

    render(
      <StrictMode>
        <AuthorityReviewWorkspace provider="elvanto" autoStart onApplied={vi.fn()} onCancel={vi.fn()} />
      </StrictMode>,
    );

    expect(await screen.findByRole('region', { name: 'Elvanto authority review' })).toBeInTheDocument();
    expect(peopleSyncAPI.previewAuthority).toHaveBeenCalledTimes(1);
  });

  it('does not preview before autoStart is enabled', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    const callbacks = { onApplied: vi.fn(), onCancel: vi.fn() };
    const { rerender } = render(
      <AuthorityReviewWorkspace provider="elvanto" autoStart={false} {...callbacks} />,
    );

    expect(peopleSyncAPI.previewAuthority).not.toHaveBeenCalled();
    rerender(<AuthorityReviewWorkspace provider="elvanto" autoStart {...callbacks} />);

    await waitFor(() => expect(peopleSyncAPI.previewAuthority).toHaveBeenCalledWith('elvanto'));
  });

  it('retires the exact old-provider intent when a new provider generation fails', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority)
      .mockResolvedValueOnce({ data: { success: true, ...review } })
      .mockRejectedValueOnce(new Error('Planning Center preview failed'));
    const callbacks = { onApplied: vi.fn(), onCancel: vi.fn() };
    const { rerender } = render(
      <AuthorityReviewWorkspace provider="elvanto" autoStart {...callbacks} />,
    );
    await screen.findByRole('region', { name: 'Elvanto authority review' });

    rerender(<AuthorityReviewWorkspace provider="planning_center" autoStart {...callbacks} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Planning Center preview failed');
    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledWith(
      'elvanto',
      'authority-preview-1',
    ));
  });

  it('applies an accepted review through its immutable provider after the provider prop changes', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    vi.mocked(peopleSyncAPI.applyAuthority).mockResolvedValue({
      data: { success: true, runId: 10, status: 'applied', applied: {} as never, summary: review.summary },
    });
    const callbacks = { onApplied: vi.fn(), onCancel: vi.fn() };
    const { rerender } = render(
      <AuthorityReviewWorkspace provider="elvanto" autoStart {...callbacks} />,
    );
    const applyButton = await screen.findByRole('button', { name: /^Apply \d+ selected changes?$/ });

    rerender(<AuthorityReviewWorkspace provider="planning_center" autoStart={false} {...callbacks} />);
    fireEvent.click(applyButton);

    await waitFor(() => expect(peopleSyncAPI.applyAuthority).toHaveBeenCalledTimes(1));
    expect(peopleSyncAPI.applyAuthority).toHaveBeenCalledWith(
      'elvanto',
      'authority-review',
      expect.any(Object),
    );
    expect(peopleSyncAPI.applyAuthority).not.toHaveBeenCalledWith(
      'planning_center',
      expect.anything(),
      expect.anything(),
    );
  });

  it('cancels an accepted review through its immutable provider after the provider prop changes', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    const callbacks = { onApplied: vi.fn(), onCancel: vi.fn() };
    const { rerender } = render(
      <AuthorityReviewWorkspace provider="elvanto" autoStart {...callbacks} />,
    );
    await screen.findByRole('region', { name: 'Elvanto authority review' });

    rerender(<AuthorityReviewWorkspace provider="planning_center" autoStart={false} {...callbacks} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel authority change' }));

    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledWith(
      'elvanto',
      'authority-preview-1',
    ));
    expect(peopleSyncAPI.cancelAuthorityPreview).not.toHaveBeenCalledWith(
      'planning_center',
      'authority-preview-1',
    );
  });

  it('waits for an in-flight preview and exact-cancels its late intent before notifying onCancel', async () => {
    const pendingPreview = deferred<{ data: { success: true } & PeopleSyncReview }>();
    const pendingCancellation = deferred<{ data: { success: true; authority: { active: 'none'; pending: null } } }>();
    vi.mocked(peopleSyncAPI.previewAuthority).mockReturnValue(pendingPreview.promise);
    vi.mocked(peopleSyncAPI.cancelAuthorityPreview).mockReturnValue(pendingCancellation.promise);
    const { onCancel } = renderWorkspace();
    await screen.findByRole('status');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel authority change' }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(peopleSyncAPI.cancelAuthorityPreview).not.toHaveBeenCalled();

    await act(async () => pendingPreview.resolve({
      data: {
        ...review,
        success: true,
        authorityPreviewId: 'authority-preview-late-after-cancel',
      },
    }));

    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledWith(
      'elvanto',
      'authority-preview-late-after-cancel',
    ));
    expect(screen.queryByRole('region', { name: /authority review/i })).not.toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => pendingCancellation.resolve({
      data: { success: true, authority: { active: 'none', pending: null } },
    }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('region', { name: /authority review/i })).not.toBeInTheDocument();
  });

  it('exact-cancels the prior owned intent when a cancelled replacement preview rejects', async () => {
    const replacementPreview = deferred<{ data: { success: true } & PeopleSyncReview }>();
    const priorCancellation = deferred<{ data: { success: true; authority: { active: 'none'; pending: null } } }>();
    vi.mocked(peopleSyncAPI.previewAuthority)
      .mockResolvedValueOnce({ data: { success: true, ...review } })
      .mockReturnValueOnce(replacementPreview.promise);
    vi.mocked(peopleSyncAPI.cancelAuthorityPreview).mockReturnValue(priorCancellation.promise);
    const { onCancel } = renderWorkspace();
    await screen.findByRole('region', { name: 'Elvanto authority review' });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel authority change' }));
    await act(async () => replacementPreview.reject(new Error('replacement preview failed')));

    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledWith(
      'elvanto',
      'authority-preview-1',
    ));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: /authority review/i })).not.toBeInTheDocument();
    await act(async () => priorCancellation.resolve({
      data: { success: true, authority: { active: 'none', pending: null } },
    }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('replaces a preview and exact-cancels the previous owned intent', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority)
      .mockResolvedValueOnce({ data: { success: true, ...review } })
      .mockResolvedValueOnce({
        data: {
          success: true,
          ...review,
          reviewToken: 'authority-review-2',
          authorityPreviewId: 'authority-preview-2',
        },
      });
    renderWorkspace();
    await screen.findByRole('region', { name: 'Elvanto authority review' });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));

    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledWith(
      'elvanto',
      'authority-preview-1',
    ));
    expect(screen.getByRole('button', { name: /^Apply \d+ selected changes?$/ })).toBeEnabled();
  });

  it('keeps the newest review and exact-cancels an older preview response that arrives late', async () => {
    const older = deferred<{ data: { success: true } & PeopleSyncReview }>();
    const newest = deferred<{ data: { success: true } & PeopleSyncReview }>();
    vi.mocked(peopleSyncAPI.previewAuthority)
      .mockResolvedValueOnce({ data: { success: true, ...review } })
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newest.promise);
    renderWorkspace();
    await screen.findByRole('region', { name: 'Elvanto authority review' });

    const refreshButton = screen.getByRole('button', { name: 'Refresh plan' });
    act(() => {
      refreshButton.click();
      refreshButton.click();
    });
    const newestPlan = {
      ...plan,
      people: {
        ...plan.people!,
        external: {
          ...plan.people!.external,
          'e-1': { ...plan.people!.external['e-1'], firstName: 'Newest' },
        },
      },
    };
    await act(async () => newest.resolve({
      data: {
        ...review,
        success: true,
        reviewToken: 'newest-review',
        authorityPreviewId: 'authority-preview-newest',
        plan: newestPlan,
      },
    }));
    expect(screen.getAllByText('Newest Smith').length).toBeGreaterThan(0);

    await act(async () => older.resolve({
      data: {
        ...review,
        success: true,
        reviewToken: 'older-review',
        authorityPreviewId: 'authority-preview-older',
      },
    }));

    expect(screen.getAllByText('Newest Smith').length).toBeGreaterThan(0);
    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledWith(
      'elvanto',
      'authority-preview-older',
    ));
  });

  it('never re-enables a stale review when replacement preview fails', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority)
      .mockResolvedValueOnce({ data: { success: true, ...review } })
      .mockRejectedValueOnce(new Error('refresh failed'));
    renderWorkspace();
    await screen.findByRole('region', { name: 'Elvanto authority review' });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('refresh failed');
    expect(screen.queryByRole('button', { name: /^Apply \d+ selected changes?$/ })).not.toBeInTheDocument();
    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledWith(
      'elvanto',
      'authority-preview-1',
    ));
  });

  it('exact-cancels the accepted preview before notifying onCancel', async () => {
    const cancellation = deferred<{ data: { success: true; authority: { active: 'none'; pending: null } } }>();
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    vi.mocked(peopleSyncAPI.cancelAuthorityPreview).mockReturnValue(cancellation.promise);
    const { onCancel } = renderWorkspace();
    await screen.findByRole('region', { name: 'Elvanto authority review' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel authority change' }));

    expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledWith('elvanto', 'authority-preview-1');
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel authority change' })).toBeDisabled();
    await act(async () => cancellation.resolve({
      data: { success: true, authority: { active: 'none', pending: null } },
    }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('releases failed bounded cancellation ownership so an explicit retry can recover', async () => {
    vi.useFakeTimers();
    const error = new Error('temporary cancellation outage');
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    vi.mocked(peopleSyncAPI.cancelAuthorityPreview)
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ data: { success: true, authority: { active: 'none', pending: null } } });
    const { onCancel } = renderWorkspace();
    await act(async () => undefined);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel authority change' }));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(screen.getByRole('alert')).toHaveTextContent('temporary cancellation outage');
    expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledTimes(4);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel authority change' }));
    await act(async () => undefined);
    expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledTimes(5);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('preserves stale-review details and never double-applies its expired token', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    vi.mocked(peopleSyncAPI.applyAuthority).mockRejectedValue(Object.assign(
      new Error('Request failed with status code 409'),
      {
        response: {
          data: {
            code: 'SYNC_REVIEW_EXPIRED',
            message: 'This authority review expired on the server.',
          },
        },
      },
    ));
    renderWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: /^Apply \d+ selected changes?$/ }));

    const applyError = await screen.findByRole('alert');
    expect(applyError).toHaveTextContent('This review has expired.');
    expect(applyError).toHaveTextContent('This authority review expired on the server.');
    expect(within(applyError).getByRole('button', { name: 'Refresh plan' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Apply \d+ selected changes?$/ }));
    expect(peopleSyncAPI.applyAuthority).toHaveBeenCalledTimes(1);
  });

  it('prevents duplicate apply while the authority commit is pending', async () => {
    const apply = deferred<{ data: { success: true; runId: number; status: 'applied'; applied: never; summary: PeopleSyncReview['summary'] } }>();
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    vi.mocked(peopleSyncAPI.applyAuthority).mockReturnValue(apply.promise);
    renderWorkspace();
    const applyButton = await screen.findByRole('button', { name: /^Apply \d+ selected changes?$/ });

    fireEvent.click(applyButton);
    fireEvent.click(applyButton);

    expect(peopleSyncAPI.applyAuthority).toHaveBeenCalledTimes(1);
    await act(async () => apply.resolve({
      data: { success: true, runId: 10, status: 'applied', applied: {} as never, summary: review.summary },
    }));
  });

  it('does not expose the committed review again when post-commit refresh fails and retries refresh only', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    vi.mocked(peopleSyncAPI.applyAuthority).mockResolvedValue({
      data: { success: true, runId: 10, status: 'applied', applied: {} as never, summary: review.summary },
    });
    const onApplied = vi.fn()
      .mockRejectedValueOnce(new Error('Authority status could not be refreshed.'))
      .mockResolvedValueOnce(undefined);
    renderWorkspace({ onApplied });
    fireEvent.click(await screen.findByRole('button', { name: /^Apply \d+ selected changes?$/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The authority change was applied, but its status could not be refreshed: Authority status could not be refreshed.',
    );
    expect(screen.queryByRole('button', { name: /^Apply \d+ selected changes?$/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry status refresh' }));

    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(2));
    expect(peopleSyncAPI.applyAuthority).toHaveBeenCalledTimes(1);
  });

  it('exact-cancels an accepted authority preview when unmounted', async () => {
    vi.mocked(peopleSyncAPI.previewAuthority).mockResolvedValue({ data: { success: true, ...review } });
    const { unmount } = renderWorkspace();
    await screen.findByRole('region', { name: 'Elvanto authority review' });

    unmount();

    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledWith(
      'elvanto',
      'authority-preview-1',
    ));
  });

  it('exact-cancels a preview response that resolves after unmount', async () => {
    const preview = deferred<{ data: { success: true } & PeopleSyncReview }>();
    vi.mocked(peopleSyncAPI.previewAuthority).mockReturnValue(preview.promise);
    const { unmount } = renderWorkspace();
    await waitFor(() => expect(peopleSyncAPI.previewAuthority).toHaveBeenCalledWith('elvanto'));

    unmount();
    await act(async () => preview.resolve({
      data: { ...review, success: true, authorityPreviewId: 'authority-preview-after-unmount' },
    }));

    await waitFor(() => expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledWith(
      'elvanto',
      'authority-preview-after-unmount',
    ));
  });
});
