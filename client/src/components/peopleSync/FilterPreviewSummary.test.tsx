import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FilterPreviewSummary from './FilterPreviewSummary';
import { peopleSyncAPI } from '../../services/api';
import type { BooleanFilterConfigV2, FilterMetadata, FilterPreviewResult } from './types';

vi.mock('../../services/api', () => ({ peopleSyncAPI: { previewFilter: vi.fn(), refreshFilterSnapshot: vi.fn(), getFilterMetadata: vi.fn() } }));

const filter: BooleanFilterConfigV2 = { branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['active'] }] }], exclusions: [] };
const preview = (patch: Partial<FilterPreviewResult> = {}): FilterPreviewResult => ({
  matchCount: 12, snapshot: { id: 'snapshot-1', capturedAt: '2026-07-28T10:00:00.000Z', fresh: true, expiresAt: '2026-07-28T10:10:00.000Z', coveredDimensionIds: ['status'] },
  overlaps: [{ batchId: 2, batchName: 'Youth', count: 3 }], uniqueEnabledPopulationCount: 20, missingDimensionIds: [], warnings: [], ...patch,
});

const response = (data: FilterPreviewResult) => Promise.resolve({ data: { success: true, ...data } });

describe('FilterPreviewSummary', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
  afterEach(() => { vi.useRealTimers(); });

  it('debounces cache-only previews and renders the current snapshot details', async () => {
    vi.mocked(peopleSyncAPI.previewFilter).mockReturnValue(response(preview()));
    render(<FilterPreviewSummary provider="elvanto" batchId={1} value={filter} enabled defaultPeopleType="regular" gatheringTypeId={null} onMetadata={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(peopleSyncAPI.previewFilter).toHaveBeenCalledTimes(1);
    expect(peopleSyncAPI.refreshFilterSnapshot).not.toHaveBeenCalled();
    expect(screen.getByText('12 people match')).toBeInTheDocument();
    expect(screen.getByText(/Data updated/)).toHaveAttribute('title', '2026-07-28T10:00:00.000Z');
    expect(screen.getByText('3 also match Youth')).toBeInTheDocument();
    expect(screen.getByText('20 people across enabled batches')).toBeInTheDocument();
  });

  it('does not allow an older preview response to replace a newer one and cancels pending work on unmount', async () => {
    let resolveFirst: ((value: { data: { success: true } & FilterPreviewResult }) => void) | undefined;
    const first = new Promise<{ data: { success: true } & FilterPreviewResult }>((resolve) => { resolveFirst = resolve; });
    vi.mocked(peopleSyncAPI.previewFilter).mockReturnValueOnce(first).mockReturnValueOnce(response(preview({ matchCount: 20 })));
    const { rerender, unmount } = render(<FilterPreviewSummary provider="elvanto" batchId={1} value={filter} enabled defaultPeopleType="regular" gatheringTypeId={null} onMetadata={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    rerender(<FilterPreviewSummary provider="elvanto" batchId={1} value={{ ...filter, exclusions: [{ dimensionId: 'status', values: ['inactive'] }] }} enabled defaultPeopleType="regular" gatheringTypeId={null} onMetadata={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(screen.getByText('20 people match')).toBeInTheDocument();
    await act(async () => { resolveFirst?.({ data: { success: true, ...preview({ matchCount: 1 }) } }); });
    expect(screen.queryByText('1 person matches')).not.toBeInTheDocument();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(peopleSyncAPI.previewFilter).toHaveBeenCalledTimes(2);
  });

  it('renders stale, unavailable, and all preview warning states', async () => {
    vi.mocked(peopleSyncAPI.previewFilter).mockReturnValue(response(preview({ matchCount: null, overlaps: [], snapshot: { ...preview().snapshot!, fresh: false }, missingDimensionIds: ['groups'], warnings: ['BROAD_FILTER', 'OVERLAP_GATHERING_TYPE', 'OVERLAP_DEFAULT_PEOPLE_TYPE'] })));
    render(<FilterPreviewSummary provider="planning_center" batchId={null} value={filter} enabled defaultPeopleType="regular" gatheringTypeId={1} onMetadata={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(screen.getByText('Count unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Data is stale/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Groups');
    expect(screen.getByRole('alert')).toHaveTextContent('matches the whole available population');
    expect(screen.getByRole('alert')).toHaveTextContent('different gathering');
    expect(screen.getByRole('alert')).toHaveTextContent('different default people type');
    expect(screen.getByText('20 people across enabled batches')).toBeInTheDocument();
  });

  it('refreshes explicitly, then updates metadata before requesting a fresh preview', async () => {
    const metadata: FilterMetadata = { dimensions: [] };
    vi.mocked(peopleSyncAPI.refreshFilterSnapshot).mockResolvedValue({ data: { success: true, metadata, snapshot: preview().snapshot! } });
    vi.mocked(peopleSyncAPI.previewFilter).mockReturnValue(response(preview()));
    vi.mocked(peopleSyncAPI.getFilterMetadata).mockResolvedValue({ data: { success: true, metadata, snapshot: preview().snapshot! } });
    const onMetadata = vi.fn();
    render(<FilterPreviewSummary provider="elvanto" batchId={1} value={filter} enabled defaultPeopleType="regular" gatheringTypeId={null} onMetadata={onMetadata} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    await act(async () => { screen.getByRole('button', { name: 'Refresh people data' }).click(); });
    expect(peopleSyncAPI.refreshFilterSnapshot).toHaveBeenCalledWith('elvanto', { filterConfig: filter });
    expect(peopleSyncAPI.getFilterMetadata).toHaveBeenCalledWith('elvanto');
    expect(onMetadata).toHaveBeenCalledWith(metadata);
  });

  it('cancels a not-yet-due debounce when refresh starts and re-enables when its preview finishes', async () => {
    const metadata: FilterMetadata = { dimensions: [] };
    vi.mocked(peopleSyncAPI.refreshFilterSnapshot).mockResolvedValue({ data: { success: true, metadata, snapshot: preview().snapshot! } });
    vi.mocked(peopleSyncAPI.getFilterMetadata).mockResolvedValue({ data: { success: true, metadata, snapshot: preview().snapshot! } });
    vi.mocked(peopleSyncAPI.previewFilter).mockReturnValue(response(preview()));
    render(<FilterPreviewSummary provider="elvanto" batchId={1} value={filter} enabled defaultPeopleType="regular" gatheringTypeId={null} onMetadata={vi.fn()} />);
    await act(async () => { screen.getByRole('button', { name: 'Refresh people data' }).click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(peopleSyncAPI.previewFilter).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Refresh people data' })).toBeEnabled();
  });

  it('ignores a delayed refresh after identity changes or unmount', async () => {
    let resolveRefresh: (() => void) | undefined;
    const delayedRefresh = new Promise<{ data: { success: true; metadata: FilterMetadata; snapshot: NonNullable<FilterPreviewResult['snapshot']> } }>((resolve) => {
      resolveRefresh = () => resolve({ data: { success: true, metadata: { dimensions: [] }, snapshot: preview().snapshot! } });
    });
    vi.mocked(peopleSyncAPI.previewFilter).mockReturnValue(response(preview()));
    vi.mocked(peopleSyncAPI.refreshFilterSnapshot).mockReturnValue(delayedRefresh);
    const onMetadata = vi.fn();
    const { rerender, unmount } = render(<FilterPreviewSummary provider="elvanto" batchId={1} value={filter} enabled defaultPeopleType="regular" gatheringTypeId={null} onMetadata={onMetadata} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    await act(async () => { screen.getByRole('button', { name: 'Refresh people data' }).click(); });
    rerender(<FilterPreviewSummary provider="planning_center" batchId={2} value={filter} enabled defaultPeopleType="regular" gatheringTypeId={null} onMetadata={onMetadata} />);
    await act(async () => { resolveRefresh?.(); });
    expect(peopleSyncAPI.getFilterMetadata).not.toHaveBeenCalled();
    expect(onMetadata).not.toHaveBeenCalled();
    unmount();
  });

  it('reports an explicit refresh failure without replacing newer preview data', async () => {
    vi.mocked(peopleSyncAPI.previewFilter).mockReturnValue(response(preview()));
    vi.mocked(peopleSyncAPI.refreshFilterSnapshot).mockRejectedValue(new Error('offline'));
    render(<FilterPreviewSummary provider="elvanto" batchId={1} value={filter} enabled defaultPeopleType="regular" gatheringTypeId={null} onMetadata={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    await act(async () => { screen.getByRole('button', { name: 'Refresh people data' }).click(); });
    expect(screen.getByRole('alert')).toHaveTextContent('Count unavailable');
  });
});
