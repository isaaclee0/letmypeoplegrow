import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { elvantoSyncAPI, gatheringsAPI, peopleSyncAPI } from '../../services/api';
import ElvantoIntegrationPanel from './ElvantoIntegrationPanel';
import type { PeopleSyncBatch, PeopleSyncSettings } from '../peopleSync/types';

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));

vi.mock('react-router-dom', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-router-dom')>(),
  useNavigate: () => mockNavigate,
}));

vi.mock('../../services/api', () => ({
  integrationsAPI: { connectElvanto: vi.fn(), disconnectElvanto: vi.fn() },
  elvantoSyncAPI: { listBatches: vi.fn(), deleteBatch: vi.fn(), getBatchPlan: vi.fn(), previewLinkCorrections: vi.fn(), applyBatch: vi.fn() },
  gatheringsAPI: { getAll: vi.fn(), create: vi.fn() },
  peopleSyncAPI: { getRuns: vi.fn(), discardSourceDraft: vi.fn(), updateSettings: vi.fn() },
}));
vi.mock('../elvanto/ElvantoBatchEditor', () => ({
  default: ({ onSaved }: { onSaved: (savedBatch: PeopleSyncBatch) => void }) => (
    <div>
      Batch editor
      <button type="button" onClick={() => onSaved({ id: 27 } as PeopleSyncBatch)}>Save mocked batch</button>
    </div>
  ),
}));
vi.mock('../elvanto/ElvantoGatheringImport', () => ({ default: () => null }));
vi.mock('../peopleSync/PeopleSourceControl', () => ({ default: () => <div>People source control</div> }));

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
  });

  it('opens the dedicated batch review without fetching or rendering a review inline for a manual-only batch', async () => {
    const user = userEvent.setup();
    renderPanel();
    const reviewButton = await screen.findByRole('button', { name: 'Review & sync Members' });
    expect(reviewButton).toHaveClass('rounded-md', 'bg-green-600', 'text-white');
    await user.click(reviewButton);

    expect(mockNavigate).toHaveBeenCalledWith('/app/settings/integrations/elvanto/batches/5/review');
    expect(elvantoSyncAPI.getBatchPlan).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Elvanto Members sync review' })).not.toBeInTheDocument();
  });

  it('opens review immediately after creating a batch', async () => {
    renderPanel();
    await screen.findByText('Members');

    fireEvent.click(screen.getByRole('button', { name: 'New batch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save mocked batch' }));

    expect(mockNavigate).toHaveBeenCalledWith('/app/settings/integrations/elvanto/batches/27/review');
  });

  it('keeps the existing reload behavior after editing a batch', async () => {
    renderPanel();
    await screen.findByText('Members');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save mocked batch' }));

    expect(mockNavigate).not.toHaveBeenCalled();
    await waitFor(() => expect(elvantoSyncAPI.listBatches).toHaveBeenCalledTimes(2));
  });

  it('retains batch edit and delete mutations beside dedicated review navigation', async () => {
    vi.mocked(elvantoSyncAPI.deleteBatch).mockResolvedValue({ data: { success: true } } as never);
    renderPanel();

    expect(await screen.findByText('Members')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByText('Batch editor')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(elvantoSyncAPI.deleteBatch).toHaveBeenCalledWith(5));
    await waitFor(() => expect(elvantoSyncAPI.listBatches).toHaveBeenCalledTimes(2));
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
