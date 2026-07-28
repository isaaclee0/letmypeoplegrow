import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { peopleSyncAPI } from '../../services/api';
import FilterUpgradePanel from './FilterUpgradePanel';
import type { PeopleSyncBatch } from './types';

vi.mock('../../services/api', () => ({
  peopleSyncAPI: {
    previewFilterUpgrade: vi.fn(),
    refreshFilterSnapshot: vi.fn(),
    applyFilterUpgrade: vi.fn(),
    applyCompatibleFilterUpgrades: vi.fn(),
    saveFilterDraft: vi.fn(),
  },
}));

const legacy = (id: number, name: string): PeopleSyncBatch => ({
  id, provider: 'elvanto', name, enabled: true, filterSchemaVersion: 1, filterConfig: {}, filterRevision: 3,
  draftFilterSchemaVersion: null, draftFilterConfig: null, draftFilterBaseRevision: null, draftFilterUpdatedAt: null,
  needsFilterReview: false, defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
  scheduleEnabled: true, scheduleFrequency: 'weekly', scheduleDay: 1, legacyProviderBatchId: null,
  lastExternalWatermark: null, lastSyncAt: null, lastSyncResult: null,
});

describe('FilterUpgradePanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a transient exact comparison and upgrades only batches with valid compatible tokens', async () => {
    vi.mocked(peopleSyncAPI.previewFilterUpgrade)
      .mockResolvedValueOnce({ data: { success: true, compatible: true, oldCount: 8, newCount: 8, upgradeToken: 'valid-1', convertedFilterConfig: { branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['active'] }] }], exclusions: [] }, snapshot: { id: 'snap', capturedAt: '2026-07-28T08:00:00.000Z', fresh: true, expiresAt: null, coveredDimensionIds: ['status'] } } })
      .mockResolvedValueOnce({ data: { success: true, compatible: false, oldCount: 5, newCount: 6, upgradeToken: 'mismatch', convertedFilterConfig: { branches: [], exclusions: [] }, snapshot: { id: 'snap', capturedAt: '2026-07-28T08:00:00.000Z', fresh: true, expiresAt: null, coveredDimensionIds: [] } } });
    vi.mocked(peopleSyncAPI.applyCompatibleFilterUpgrades).mockResolvedValue({ data: { success: true, batches: [] } });
    const onChanged = vi.fn();
    render(<FilterUpgradePanel provider="elvanto" batches={[legacy(1, 'Members'), legacy(2, 'Visitors')]} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Upgrade filter Members' }));
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade filter Visitors' }));

    expect(await screen.findByText('status is active')).toBeInTheDocument();
    expect(screen.getByText('8 legacy matches → 8 converted matches')).toBeInTheDocument();
    expect(screen.getByText('Exact-compatible')).toBeInTheDocument();
    expect(screen.getAllByText(/Snapshot captured/)).toHaveLength(2);
    expect(screen.getByText('5 legacy matches → 6 converted matches')).toBeInTheDocument();
    expect(screen.getByText('Overlap impact: 1 person changes')).toBeInTheDocument();
    expect(screen.getByText('Needs full review')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Upgrade all compatible batches' }));
    await waitFor(() => expect(peopleSyncAPI.applyCompatibleFilterUpgrades).toHaveBeenCalledWith('elvanto', [{ batchId: 1, upgradeToken: 'valid-1' }]));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('never direct-upgrades a mismatch and saves the converted criteria as a review draft', async () => {
    const converted = { branches: [{ groups: [{ dimensionId: 'status', mode: 'any' as const, values: ['active'] }] }], exclusions: [] };
    vi.mocked(peopleSyncAPI.previewFilterUpgrade).mockResolvedValue({ data: { success: true, compatible: false, oldCount: 5, newCount: 6, upgradeToken: 'mismatch', convertedFilterConfig: converted, snapshot: { id: 'snap', capturedAt: '2026-07-28T08:00:00.000Z', fresh: false, expiresAt: null, coveredDimensionIds: ['status'] } } });
    vi.mocked(peopleSyncAPI.saveFilterDraft).mockResolvedValue({ data: { success: true, batch: {} as never } });
    const onChanged = vi.fn();
    render(<FilterUpgradePanel provider="elvanto" batches={[legacy(2, 'Visitors')]} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Upgrade filter Visitors' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review converted filter Visitors' }));

    await waitFor(() => expect(peopleSyncAPI.saveFilterDraft).toHaveBeenCalledWith('elvanto', 2, { filterConfig: converted, broadMatchAcknowledged: true }));
    expect(peopleSyncAPI.applyCompatibleFilterUpgrades).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('applies an exact-compatible upgrade directly with only its current signed token', async () => {
    vi.mocked(peopleSyncAPI.previewFilterUpgrade).mockResolvedValue({ data: {
      success: true, compatible: true, oldCount: 8, newCount: 8, upgradeToken: 'current-token',
      convertedFilterConfig: { branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['active'] }] }], exclusions: [] },
      snapshot: { id: 'snap', capturedAt: '2026-07-28T08:00:00.000Z', fresh: true, expiresAt: null, coveredDimensionIds: ['status'] },
    } });
    vi.mocked(peopleSyncAPI.applyFilterUpgrade).mockResolvedValue({ data: { success: true, batches: [{ id: 1, filterSchemaVersion: 2, filterRevision: 4 }] } });
    const onChanged = vi.fn();
    render(<FilterUpgradePanel provider="elvanto" batches={[legacy(1, 'Members')]} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Upgrade filter Members' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply upgrade Members' }));

    await waitFor(() => expect(peopleSyncAPI.applyFilterUpgrade).toHaveBeenCalledWith('elvanto', 1, 'current-token'));
    expect(peopleSyncAPI.saveFilterDraft).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('keeps the comparison available and reports a stale direct-upgrade token', async () => {
    vi.mocked(peopleSyncAPI.previewFilterUpgrade).mockResolvedValue({ data: {
      success: true, compatible: true, oldCount: 8, newCount: 8, upgradeToken: 'expired-token',
      convertedFilterConfig: { branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['active'] }] }], exclusions: [] },
      snapshot: { id: 'snap', capturedAt: '2026-07-28T08:00:00.000Z', fresh: true, expiresAt: null, coveredDimensionIds: ['status'] },
    } });
    vi.mocked(peopleSyncAPI.applyFilterUpgrade).mockRejectedValue({ response: { data: { error: 'The filter upgrade is no longer current.' } } });
    render(<FilterUpgradePanel provider="elvanto" batches={[legacy(1, 'Members')]} onChanged={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Upgrade filter Members' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply upgrade Members' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The filter upgrade is no longer current.');
    expect(screen.getByRole('button', { name: 'Apply upgrade Members' })).toBeEnabled();
  });

  it('disables direct and bulk upgrades for a retained stale snapshot and refreshes before re-comparing', async () => {
    const stale = { success: true, compatible: true, oldCount: 8, newCount: 8, upgradeToken: 'stale-token',
      convertedFilterConfig: { branches: [{ groups: [{ dimensionId: 'status', mode: 'any' as const, values: ['active'] }] }], exclusions: [] },
      snapshot: { id: 'snap', capturedAt: '2026-07-28T08:00:00.000Z', fresh: false, expiresAt: null, coveredDimensionIds: ['status'] } };
    const fresh = { ...stale, upgradeToken: 'fresh-token', snapshot: { ...stale.snapshot, fresh: true } };
    vi.mocked(peopleSyncAPI.previewFilterUpgrade).mockResolvedValueOnce({ data: stale }).mockResolvedValueOnce({ data: fresh });
    vi.mocked(peopleSyncAPI.refreshFilterSnapshot).mockResolvedValue({ data: { success: true, metadata: { dimensions: [] }, snapshot: fresh.snapshot } });
    render(<FilterUpgradePanel provider="elvanto" batches={[legacy(1, 'Members')]} onChanged={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Upgrade filter Members' }));
    expect(await screen.findByText(/Snapshot is stale/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply upgrade Members' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upgrade all compatible batches' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh people data and compare Members' }));

    await waitFor(() => expect(peopleSyncAPI.refreshFilterSnapshot).toHaveBeenCalledWith('elvanto'));
    expect(await screen.findByRole('button', { name: 'Apply upgrade Members' })).toBeEnabled();
  });

  it('keeps the newest same-batch preview when an older request resolves afterwards', async () => {
    let resolveFirst!: (value: { data: FilterUpgradePreviewResponse }) => void;
    let resolveSecond!: (value: { data: FilterUpgradePreviewResponse }) => void;
    type FilterUpgradePreviewResponse = Awaited<ReturnType<typeof peopleSyncAPI.previewFilterUpgrade>>['data'];
    const first = new Promise<{ data: FilterUpgradePreviewResponse }>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<{ data: FilterUpgradePreviewResponse }>((resolve) => { resolveSecond = resolve; });
    vi.mocked(peopleSyncAPI.previewFilterUpgrade).mockReturnValueOnce(first).mockReturnValueOnce(second);
    const { rerender } = render(<FilterUpgradePanel provider="elvanto" batches={[legacy(1, 'Members')]} onChanged={vi.fn()} />);

    const compare = screen.getByRole('button', { name: 'Upgrade filter Members' });
    fireEvent.click(compare);
    // A batch refresh can remove and restore the same legacy row while its
    // earlier preview is still in flight. The restored row must own a newer
    // request and cannot inherit the old token/result.
    rerender(<FilterUpgradePanel provider="elvanto" batches={[]} onChanged={vi.fn()} />);
    rerender(<FilterUpgradePanel provider="elvanto" batches={[legacy(1, 'Members')]} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade filter Members' }));
    const response = (token: string): FilterUpgradePreviewResponse => ({
      success: true, compatible: true, oldCount: 1, newCount: 1, upgradeToken: token,
      convertedFilterConfig: { branches: [], exclusions: [] },
      snapshot: { id: 'snap', capturedAt: '2026-07-28T08:00:00.000Z', fresh: true, expiresAt: null, coveredDimensionIds: [] },
    });

    await act(async () => { resolveSecond({ data: response('new-token') }); });
    expect(await screen.findByRole('button', { name: 'Apply upgrade Members' })).toBeInTheDocument();
    await act(async () => { resolveFirst({ data: response('old-token') }); });

    fireEvent.click(screen.getByRole('button', { name: 'Apply upgrade Members' }));
    await waitFor(() => expect(peopleSyncAPI.applyFilterUpgrade).toHaveBeenCalledWith('elvanto', 1, 'new-token'));
  });
});
