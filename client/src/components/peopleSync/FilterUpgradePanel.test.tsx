import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { peopleSyncAPI } from '../../services/api';
import FilterUpgradePanel from './FilterUpgradePanel';
import type { PeopleSyncBatch } from './types';

vi.mock('../../services/api', () => ({
  peopleSyncAPI: {
    previewFilterUpgrade: vi.fn(),
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
});
