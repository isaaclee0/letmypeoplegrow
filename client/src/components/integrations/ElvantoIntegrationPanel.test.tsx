import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { elvantoSyncAPI, gatheringsAPI, peopleSyncAPI } from '../../services/api';
import ElvantoIntegrationPanel from './ElvantoIntegrationPanel';
import type { PeopleSyncBatch, PeopleSyncSettings } from '../peopleSync/types';

vi.mock('../../services/api', () => ({
  integrationsAPI: { connectElvanto: vi.fn(), disconnectElvanto: vi.fn() },
  elvantoSyncAPI: { listBatches: vi.fn(), deleteBatch: vi.fn(), getBatchPlan: vi.fn(), applyBatch: vi.fn() },
  gatheringsAPI: { getAll: vi.fn(), create: vi.fn() },
  peopleSyncAPI: { getRuns: vi.fn(), discardSourceDraft: vi.fn(), updateSettings: vi.fn() },
}));
vi.mock('../elvanto/ElvantoBatchEditor', () => ({ default: () => <div>Batch editor</div> }));
vi.mock('../elvanto/ElvantoGatheringImport', () => ({ default: () => null }));
vi.mock('../peopleSync/PeopleSourceControl', () => ({ default: () => <div>People source control</div> }));
const elvantoV2Selections = {
  decisionContractVersion: 2 as const,
  identityDecisions: { 'elvanto-person-1': { outcome: 'link' as const, individualId: 23 } },
  acceptArchiveIndividualIds: [],
  acceptFamilyRenameIds: [],
};
vi.mock('../peopleSync/SyncReview', () => ({
  default: ({ onApply }: { onApply: (reviewToken: string, selections: typeof elvantoV2Selections) => void }) => (
    <div>
      <p>Sync review</p>
      <button type="button" onClick={() => onApply('elvanto-review-5', elvantoV2Selections)}>Apply shared review</button>
    </div>
  ),
}));

const settings: PeopleSyncSettings = {
  authorityProvider: 'none', pendingAuthorityProvider: null, elvantoIncludeContacts: true,
  elvantoAlignPeopleType: true, fullReconciliationFrequency: 'weekly', fullReconciliationDay: 1,
};
const batch = {
  id: 5, provider: 'elvanto', name: 'Members', enabled: true,
  source: { kind: 'elvanto_category', externalId: 'category-1', name: 'Members', memberCount: 12, providerRefreshedAt: null },
  sourceRevision: 2,
  draftSource: { kind: 'elvanto_group', externalId: 'group-2', name: 'Youth', memberCount: null, providerRefreshedAt: null },
  draftSourceBaseRevision: 2, draftSourceUpdatedAt: '2026-07-29T00:00:00.000Z', needsSourceReview: true,
  initialSourceReviewPending: false, sourceStatus: 'available', sourceStatusCheckedAt: null, sourceStatusErrorCode: null,
  defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
  scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1, legacyProviderBatchId: null,
  lastExternalWatermark: null, lastSyncAt: null, lastSyncResult: null,
} as PeopleSyncBatch;

function renderPanel() {
  return render(<ElvantoIntegrationPanel
    status={{ connected: true, loading: false, elvantoAccount: 'Example church' }} refreshStatus={vi.fn()} onBack={vi.fn()}
    peopleSyncSettings={settings} peopleSyncStatus="known" providerConnections={{ planning_center: true, elvanto: true }}
    refreshPeopleSync={vi.fn()} retryPeopleSync={vi.fn()}
  />);
}

describe('ElvantoIntegrationPanel source drafts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(elvantoSyncAPI.listBatches).mockResolvedValue({ data: { batches: [batch] } });
    vi.mocked(gatheringsAPI.getAll).mockResolvedValue({ data: { gatherings: [] } });
    vi.mocked(peopleSyncAPI.getRuns).mockResolvedValue({ data: { runs: [] } });
    vi.mocked(elvantoSyncAPI.getBatchPlan).mockResolvedValue({ data: {
      runId: 5,
      reviewToken: 'elvanto-review-5',
      decisionContractVersion: 2,
      plan: { provider: 'elvanto' },
      summary: {},
      snapshot: { fetchedAt: '2026-07-29T00:00:00.000Z', mode: 'full' },
    } } as never);
    vi.mocked(elvantoSyncAPI.applyBatch).mockResolvedValue({ data: { success: true } } as never);
  });

  it('uses the same nested review surface and forwards external-to-local v2 decisions before reloading', async () => {
    const refreshPeopleSync = vi.fn();
    render(<ElvantoIntegrationPanel
      status={{ connected: true, loading: false, elvantoAccount: 'Example church' }} refreshStatus={vi.fn()} onBack={vi.fn()}
      peopleSyncSettings={settings} peopleSyncStatus="known" providerConnections={{ planning_center: true, elvanto: true }}
      refreshPeopleSync={refreshPeopleSync} retryPeopleSync={vi.fn()}
    />);

    const reviewButton = await screen.findByRole('button', { name: 'Review & sync Members' });
    expect(reviewButton).toHaveClass('rounded-md', 'bg-green-600', 'text-white');
    fireEvent.click(reviewButton);

    const reviewRegion = await screen.findByRole('region', { name: 'Elvanto Members sync review' });
    expect(reviewRegion).toHaveClass('rounded-lg', 'border', 'bg-gray-50/50', 'p-4', 'dark:bg-gray-900/20');
    expect(screen.getByRole('button', { name: 'Close review' })).toHaveClass('rounded-md', 'border', 'border-gray-300');
    fireEvent.click(screen.getByRole('button', { name: 'Apply shared review' }));

    await waitFor(() => expect(elvantoSyncAPI.applyBatch).toHaveBeenCalledWith(5, {
      reviewToken: 'elvanto-review-5', selections: elvantoV2Selections,
    }));
    await waitFor(() => expect(elvantoSyncAPI.listBatches).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(refreshPeopleSync).toHaveBeenCalledTimes(1));
  });

  it('keeps review loading and recoverable errors inside the nested review surface', async () => {
    let rejectReview!: (reason: unknown) => void;
    vi.mocked(elvantoSyncAPI.getBatchPlan).mockImplementationOnce(() => new Promise((_, reject) => {
      rejectReview = reject;
    }) as never);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Review & sync Members' }));
    const reviewRegion = screen.getByRole('region', { name: 'Elvanto Members sync review' });
    expect(reviewRegion).toHaveTextContent('Preparing sync review…');

    await act(async () => rejectReview({ response: { data: { error: 'Elvanto review unavailable.' } } }));
    expect(within(reviewRegion).getByRole('alert')).toHaveTextContent('Elvanto review unavailable.');
    expect(within(reviewRegion).getByRole('button', { name: 'Refresh plan' })).toBeInTheDocument();
  });

  it('shows a pending Category/Group change and lets the admin discard it', async () => {
    vi.mocked(peopleSyncAPI.discardSourceDraft).mockResolvedValue({ data: { batch } });
    renderPanel();
    expect(await screen.findByText('Members')).toBeInTheDocument();
    expect(screen.getByText(/Needs full review/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard source draft' }));
    await waitFor(() => expect(peopleSyncAPI.discardSourceDraft).toHaveBeenCalledWith('elvanto', 5));
    await waitFor(() => expect(elvantoSyncAPI.listBatches).toHaveBeenCalledTimes(2));
  });

  it('shows source check errors with their safe code instead of calling the source missing', async () => {
    vi.mocked(elvantoSyncAPI.listBatches).mockResolvedValue({
      data: { batches: [{ ...batch, sourceStatus: 'error', sourceStatusErrorCode: 'SYNC_SOURCE_RATE_LIMIT' }] },
    });
    renderPanel();

    expect(await screen.findByText('Source check failed · SYNC_SOURCE_RATE_LIMIT')).toBeInTheDocument();
    expect(screen.queryByText('Source missing')).not.toBeInTheDocument();
  });
});
