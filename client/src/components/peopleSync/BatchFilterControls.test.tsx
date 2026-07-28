import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BatchFilterControls from './BatchFilterControls';
import { peopleSyncAPI } from '../../services/api';

vi.mock('../../services/api', () => ({ peopleSyncAPI: {
  getFilterMetadata: vi.fn(), refreshFilterSnapshot: vi.fn(), discardFilterDraft: vi.fn(), previewFilter: vi.fn(),
} }));

const empty = { branches: [], exclusions: [] };

describe('BatchFilterControls cold cache', () => {
  beforeEach(() => vi.clearAllMocks());

  for (const provider of ['planning_center', 'elvanto'] as const) {
    it(`offers an explicit provider refresh when ${provider} metadata GET is unavailable`, async () => {
      vi.mocked(peopleSyncAPI.getFilterMetadata).mockRejectedValue({ response: { data: { error: 'A complete filter snapshot is required.' } } });
      vi.mocked(peopleSyncAPI.refreshFilterSnapshot).mockResolvedValue({ data: {
        success: true,
        metadata: { dimensions: [{ id: 'status', label: 'Status', cardinality: 'single', category: 'People', values: [{ id: 'active', label: 'Active', count: 1 }] }] },
        snapshot: { id: 'snap', capturedAt: '2026-07-29T00:00:00.000Z', fresh: true, expiresAt: null, coveredDimensionIds: ['status'] },
      } });
      render(<BatchFilterControls provider={provider} batch={null} value={empty} onChange={vi.fn()} enabled defaultPeopleType="regular" gatheringTypeId={null} broadAcknowledged={false} onBroadAcknowledgedChange={vi.fn()} onBroadWarningChange={vi.fn()} onDiscarded={vi.fn()} />);
      expect(await screen.findByRole('button', { name: 'Refresh people data' })).toBeEnabled();
      await act(async () => screen.getByRole('button', { name: 'Refresh people data' }).click());
      expect(peopleSyncAPI.refreshFilterSnapshot).toHaveBeenCalledWith(provider, { batchId: null, filterConfig: empty });
      expect(await screen.findByText('Who qualifies?')).toBeInTheDocument();
    });
  }

  it('threads the persisted batch identity through cold-cache recovery', async () => {
    vi.mocked(peopleSyncAPI.getFilterMetadata).mockRejectedValue({ response: { data: { error: 'A complete filter snapshot is required.' } } });
    vi.mocked(peopleSyncAPI.refreshFilterSnapshot).mockResolvedValue({ data: {
      success: true, metadata: { dimensions: [] },
      snapshot: { id: 'snap', capturedAt: '2026-07-29T00:00:00.000Z', fresh: true, expiresAt: null, coveredDimensionIds: [] },
    } });
    const batch = { id: 41, provider: 'elvanto' as const, name: 'Saved', enabled: true, filterSchemaVersion: 2,
      filterConfig: empty, filterRevision: 2, draftFilterSchemaVersion: 2, draftFilterConfig: empty,
      draftFilterBaseRevision: 2, draftFilterUpdatedAt: '2026-07-29T00:00:00.000Z', needsFilterReview: true,
      initialFilterReviewPending: false, defaultPeopleType: 'regular' as const, gatheringTypeId: null,
      gatheringAutoRemoveEnabled: false, scheduleEnabled: true, scheduleFrequency: 'weekly' as const,
      scheduleDay: 1, legacyProviderBatchId: null, lastExternalWatermark: null, lastSyncAt: null, lastSyncResult: null };
    render(<BatchFilterControls provider="elvanto" batch={batch} value={empty} onChange={vi.fn()} enabled defaultPeopleType="regular" gatheringTypeId={null} broadAcknowledged={false} onBroadAcknowledgedChange={vi.fn()} onBroadWarningChange={vi.fn()} onDiscarded={vi.fn()} />);

    const refresh = await screen.findByRole('button', { name: 'Refresh people data' });
    await act(async () => refresh.click());
    expect(peopleSyncAPI.refreshFilterSnapshot).toHaveBeenCalledWith('elvanto', { batchId: 41, filterConfig: empty });
  });

  it('does not offer to discard the unpromoted initial draft', async () => {
    vi.mocked(peopleSyncAPI.getFilterMetadata).mockResolvedValue({ data: { success: true, metadata: { dimensions: [] }, snapshot: { id: 'snap', capturedAt: '2026-07-29T00:00:00.000Z', fresh: true, expiresAt: null, coveredDimensionIds: [] } } });
    const batch = { id: 1, provider: 'elvanto' as const, name: 'Initial', enabled: true, filterSchemaVersion: 2,
      filterConfig: empty, filterRevision: 1, draftFilterSchemaVersion: 2, draftFilterConfig: empty,
      draftFilterBaseRevision: 1, draftFilterUpdatedAt: '2026-07-29T00:00:00.000Z', needsFilterReview: true,
      initialFilterReviewPending: true, defaultPeopleType: 'regular' as const, gatheringTypeId: null,
      gatheringAutoRemoveEnabled: false, scheduleEnabled: true, scheduleFrequency: 'weekly' as const,
      scheduleDay: 1, legacyProviderBatchId: null, lastExternalWatermark: null, lastSyncAt: null, lastSyncResult: null };
    render(<BatchFilterControls provider="elvanto" batch={batch} value={empty} onChange={vi.fn()} enabled defaultPeopleType="regular" gatheringTypeId={null} broadAcknowledged={false} onBroadAcknowledgedChange={vi.fn()} onBroadWarningChange={vi.fn()} onDiscarded={vi.fn()} />);
    expect(await screen.findByText('Who qualifies?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Discard draft' })).not.toBeInTheDocument();
  });
});
