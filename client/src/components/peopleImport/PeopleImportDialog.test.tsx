import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PeopleImportDialog from './PeopleImportDialog';
import { peopleImportAPI } from '../../services/api';
import type { PeopleImportReview } from './types';

vi.mock('../../services/api', () => ({
  peopleImportAPI: { listSources: vi.fn(), preview: vi.fn(), apply: vi.fn() },
}));

const review: PeopleImportReview = {
  operationKind: 'people_import',
  runId: 1,
  reviewToken: 'import-review-token' as PeopleImportReview['reviewToken'],
  selection: { kind: 'all' },
  snapshot: { fetchedAt: '2026-08-04T00:00:00.000Z', mode: 'full' },
  summary: {
    linkPeople: 0, linkFamilies: 0, addPeople: 0, addFamilies: 0, updateManagedFields: 0,
    promoteToRegular: 0, demoteToLocalVisitor: 0, archive: 0, reactivate: 0, moveFamily: 0,
    renameFamily: 0, addToGathering: 0, removeFromGathering: 0, ambiguousPeople: 0,
    familyConflicts: 0, unmatchedLocalRegulars: 0, skipped: 0,
  },
  plan: {
    operationKind: 'people_import', provider: 'planning_center', authoritative: false,
    snapshot: { fetchedAt: '2026-08-04T00:00:00.000Z', mode: 'full' },
    linkPeople: [], linkFamilies: [], addPeople: [], addFamilies: [], updateManagedFields: [],
    promoteToRegular: [], demoteToLocalVisitor: [], archive: [], reactivate: [], moveFamily: [],
    renameFamily: [], addToGathering: [], removeFromGathering: [], ambiguousPeople: [],
    familyConflicts: [], unmatchedLocalRegulars: [], skipped: [],
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

async function openAllPlanningCenterReview() {
  fireEvent.click(screen.getByRole('button', { name: 'Planning Center' }));
  fireEvent.click(await screen.findByRole('radio', { name: 'Everyone' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review import' }));
  await screen.findByRole('button', { name: 'Apply import' });
}

describe('PeopleImportDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(peopleImportAPI.listSources).mockResolvedValue({
      data: {
        success: true,
        allOption: { kind: 'all', name: 'Everyone' },
        sources: [{ kind: 'planning_center_list', externalId: 'list-1', name: 'Members', memberCount: 12, providerRefreshedAt: null }],
      },
    });
    vi.mocked(peopleImportAPI.preview).mockResolvedValue({ data: review });
    vi.mocked(peopleImportAPI.apply).mockResolvedValue({
      data: { runId: 1, status: 'applied', applied: {} as never, summary: review.summary },
    });
  });

  it('chooses a provider and sends exactly the Everyone selection to preview', async () => {
    render(<PeopleImportDialog isOpen onClose={vi.fn()} onApplied={vi.fn()} />);

    await openAllPlanningCenterReview();

    expect(peopleImportAPI.preview).toHaveBeenCalledWith('planning_center', { kind: 'all' });
    expect(screen.getByText('People import review')).toBeInTheDocument();
  });

  it('shows a recoverable disconnected-source response', async () => {
    vi.mocked(peopleImportAPI.listSources).mockRejectedValue(new Error('Planning Center is disconnected'));
    render(<PeopleImportDialog isOpen onClose={vi.fn()} onApplied={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Planning Center' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Planning Center is disconnected');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows loading then List, Category, Group, and Everyone source choices', async () => {
    const pending = deferred<{ data: { success: true; sources: { kind: 'planning_center_list'; externalId: string; name: string; memberCount: number; providerRefreshedAt: null }[]; allOption: { kind: 'all'; name: 'Everyone' } } }>();
    vi.mocked(peopleImportAPI.listSources).mockReturnValueOnce(pending.promise as never);
    render(<PeopleImportDialog isOpen onClose={vi.fn()} onApplied={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Planning Center' }));
    expect(screen.getByText('Loading people sources…')).toBeInTheDocument();
    await act(async () => pending.resolve({ data: {
      success: true,
      allOption: { kind: 'all', name: 'Everyone' },
      sources: [{ kind: 'planning_center_list', externalId: 'list-members', name: 'Members', memberCount: 12, providerRefreshedAt: null }],
    } }));
    expect(await screen.findByRole('radio', { name: 'Everyone' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Members/ })).toBeInTheDocument();
    expect(screen.getByText(/List/)).toBeInTheDocument();

    vi.mocked(peopleImportAPI.listSources).mockResolvedValueOnce({
      data: {
        success: true, allOption: { kind: 'all', name: 'Everyone' },
        sources: [
          { kind: 'elvanto_category', externalId: 'category-1', name: 'Adults', memberCount: 9, providerRefreshedAt: null },
          { kind: 'elvanto_group', externalId: 'group-1', name: 'Youth', memberCount: 3, providerRefreshedAt: null },
        ],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Elvanto' }));
    expect(await screen.findByRole('radio', { name: /Adults/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Youth/ })).toBeInTheDocument();
    expect(screen.getByText(/Category/)).toBeInTheDocument();
    expect(screen.getByText(/Group/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Everyone' })).toBeInTheDocument();
  });

  it('does not let a closed dialog accept a late preview response', async () => {
    const pending = deferred<{ data: PeopleImportReview }>();
    vi.mocked(peopleImportAPI.preview).mockReturnValueOnce(pending.promise as never);
    const onClose = vi.fn();
    const { rerender } = render(<PeopleImportDialog isOpen onClose={onClose} onApplied={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Planning Center' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Everyone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review import' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    rerender(<PeopleImportDialog isOpen={false} onClose={onClose} onApplied={vi.fn()} />);
    await act(async () => pending.resolve({ data: review }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('People import review')).not.toBeInTheDocument();
  });

  it('shows preview progress until the review is ready', async () => {
    const pending = deferred<{ data: PeopleImportReview }>();
    vi.mocked(peopleImportAPI.preview).mockReturnValueOnce(pending.promise as never);
    render(<PeopleImportDialog isOpen onClose={vi.fn()} onApplied={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Planning Center' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Everyone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review import' }));

    expect(screen.getByRole('status')).toHaveTextContent('Preparing import review…');
    await act(async () => pending.resolve({ data: review }));
    expect(await screen.findByRole('button', { name: 'Apply import' })).toBeInTheDocument();
  });

  it('fences a late provider source response after a newer provider is selected', async () => {
    const planningCenter = deferred<{ data: { success: true; sources: never[]; allOption: { kind: 'all'; name: 'Everyone' } } }>();
    vi.mocked(peopleImportAPI.listSources)
      .mockReturnValueOnce(planningCenter.promise as never)
      .mockResolvedValueOnce({ data: { success: true, allOption: { kind: 'all', name: 'Everyone' }, sources: [] } });
    render(<PeopleImportDialog isOpen onClose={vi.fn()} onApplied={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Planning Center' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Elvanto' }));
    await screen.findByText('Choose who to import from Elvanto');
    await act(async () => planningCenter.resolve({
      data: { success: true, allOption: { kind: 'all', name: 'Everyone' }, sources: [] },
    }));

    expect(screen.getByText('Choose who to import from Elvanto')).toBeInTheDocument();
  });

  it('prevents a second apply while the first request is pending', async () => {
    const pending = deferred<{ data: { runId: number; status: 'applied'; applied: never; summary: PeopleImportReview['summary'] } }>();
    vi.mocked(peopleImportAPI.apply).mockReturnValueOnce(pending.promise as never);
    const onClose = vi.fn();
    render(<PeopleImportDialog isOpen onClose={onClose} onApplied={vi.fn()} />);
    await openAllPlanningCenterReview();

    const apply = screen.getByRole('button', { name: 'Apply import' });
    fireEvent.click(apply);
    fireEvent.click(apply);

    expect(peopleImportAPI.apply).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ data: { runId: 1, status: 'applied', applied: {} as never, summary: review.summary } }));
  });

  it('fences an apply response after an externally closed and reopened dialog', async () => {
    const pending = deferred<{ data: { runId: number; status: 'applied'; applied: never; summary: PeopleImportReview['summary'] } }>();
    vi.mocked(peopleImportAPI.apply).mockReturnValueOnce(pending.promise as never);
    const onApplied = vi.fn();
    const { rerender } = render(<PeopleImportDialog isOpen onClose={vi.fn()} onApplied={onApplied} />);
    await openAllPlanningCenterReview();

    fireEvent.click(screen.getByRole('button', { name: 'Apply import' }));
    rerender(<PeopleImportDialog isOpen={false} onClose={vi.fn()} onApplied={onApplied} />);
    await act(async () => undefined);
    rerender(<PeopleImportDialog isOpen onClose={vi.fn()} onApplied={onApplied} />);
    await act(async () => pending.resolve({ data: { runId: 1, status: 'applied', applied: {} as never, summary: review.summary } }));

    expect(onApplied).not.toHaveBeenCalled();
    expect(screen.getByText('Choose the provider to import people from.')).toBeInTheDocument();
    expect(screen.queryByText('Import applied.')).not.toBeInTheDocument();
  });

  it('allows closing after commit while the People-page refresh is unresolved', async () => {
    const refresh = deferred<void>();
    const onClose = vi.fn();
    render(<PeopleImportDialog isOpen onClose={onClose} onApplied={() => refresh.promise} />);
    await openAllPlanningCenterReview();

    fireEvent.click(screen.getByRole('button', { name: 'Apply import' }));
    expect(await screen.findByText('Import applied.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores a late People-page refresh failure after close and restart', async () => {
    const refresh = deferred<void>();
    const onApplied = vi.fn(() => refresh.promise);
    const { rerender } = render(<PeopleImportDialog isOpen onClose={vi.fn()} onApplied={onApplied} />);
    await openAllPlanningCenterReview();

    fireEvent.click(screen.getByRole('button', { name: 'Apply import' }));
    await screen.findByText('Import applied.');
    rerender(<PeopleImportDialog isOpen={false} onClose={vi.fn()} onApplied={onApplied} />);
    await act(async () => undefined);
    rerender(<PeopleImportDialog isOpen onClose={vi.fn()} onApplied={onApplied} />);
    await act(async () => refresh.reject(new Error('People refresh failed')));

    expect(screen.getByText('Choose the provider to import people from.')).toBeInTheDocument();
    expect(screen.queryByText('People refresh failed')).not.toBeInTheDocument();
  });

  it('keeps the committed result and hides Apply import when page refresh fails', async () => {
    const onApplied = vi.fn().mockRejectedValue(new Error('People refresh failed'));
    render(<PeopleImportDialog isOpen onClose={vi.fn()} onApplied={onApplied} />);
    await openAllPlanningCenterReview();

    fireEvent.click(screen.getByRole('button', { name: 'Apply import' }));

    expect(await screen.findByText('Import applied.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply import' })).not.toBeInTheDocument();
    expect(screen.getByText('People refresh failed')).toBeInTheDocument();
  });

  it('keeps the selected source and lets SyncReview refresh an expired review', async () => {
    const expired = { response: { data: { code: 'SYNC_REVIEW_EXPIRED', error: 'This import review expired.' } } };
    vi.mocked(peopleImportAPI.apply).mockRejectedValueOnce(expired);
    vi.mocked(peopleImportAPI.preview).mockResolvedValueOnce({ data: review }).mockResolvedValueOnce({
      data: { ...review, reviewToken: 'fresh-import-token' as PeopleImportReview['reviewToken'] },
    });
    render(<PeopleImportDialog isOpen onClose={vi.fn()} onApplied={vi.fn()} />);
    await openAllPlanningCenterReview();

    fireEvent.click(screen.getByRole('button', { name: 'Apply import' }));
    expect(await screen.findByRole('button', { name: 'Refresh plan' })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Refresh plan' })[1]);

    await waitFor(() => expect(peopleImportAPI.preview).toHaveBeenLastCalledWith('planning_center', { kind: 'all' }));
    expect(await screen.findByRole('button', { name: 'Apply import' })).toBeInTheDocument();
  });
});
