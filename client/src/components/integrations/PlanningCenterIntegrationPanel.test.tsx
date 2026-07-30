import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { integrationsAPI, peopleSyncAPI, settingsAPI } from '../../services/api';
import PlanningCenterIntegrationPanel from './PlanningCenterIntegrationPanel';
import type { PeopleSyncBatch, PeopleSyncSettings } from '../peopleSync/types';

vi.mock('../../services/api', () => ({
  integrationsAPI: {
    getPlanningCenterSyncBatches: vi.fn(), getPlanningCenterSyncStats: vi.fn(),
    getCheckinAvailability: vi.fn(), authorizePlanningCenter: vi.fn(),
    disconnectPlanningCenter: vi.fn(), deletePlanningCenterSyncBatch: vi.fn(),
  },
  peopleSyncAPI: { discardSourceDraft: vi.fn() },
  settingsAPI: { getIntegrationSettings: vi.fn(), updateIntegrationSettings: vi.fn() },
}));
vi.mock('../PCOCheckinImport', () => ({ default: () => null }));
vi.mock('../planningCenter/PlanningCenterBatchEditor', () => ({ default: () => <div>Batch editor</div> }));
vi.mock('../planningCenter/PlanningCenterSyncReview', () => ({ default: () => <div>Sync review</div> }));
vi.mock('../peopleSync/PeopleSourceControl', () => ({ default: () => <div>People source control</div> }));

const settings: PeopleSyncSettings = {
  authorityProvider: 'none', pendingAuthorityProvider: null, elvantoIncludeContacts: true,
  elvantoAlignPeopleType: true, fullReconciliationFrequency: 'weekly', fullReconciliationDay: 1,
};
const batch = {
  id: 12, provider: 'planning_center', name: 'Members', enabled: true,
  source: { kind: 'planning_center_list', externalId: 'list-1', name: 'Members', memberCount: 12, providerRefreshedAt: null },
  sourceRevision: 2,
  draftSource: { kind: 'planning_center_list', externalId: 'list-2', name: 'New members', memberCount: 8, providerRefreshedAt: null },
  draftSourceBaseRevision: 2, draftSourceUpdatedAt: '2026-07-29T00:00:00.000Z', needsSourceReview: true,
  initialSourceReviewPending: false, sourceStatus: 'available', sourceStatusCheckedAt: null, sourceStatusErrorCode: null,
  defaultPeopleType: 'regular', gatheringTypeId: null, gatheringAutoRemoveEnabled: false,
  scheduleEnabled: false, scheduleFrequency: 'weekly', scheduleDay: 1, legacyProviderBatchId: null,
  lastExternalWatermark: null, lastSyncAt: null, lastSyncResult: null,
} as PeopleSyncBatch;

function renderPanel({
  status = {},
  peopleSyncSettings = settings,
}: {
  status?: Record<string, unknown>;
  peopleSyncSettings?: PeopleSyncSettings;
} = {}) {
  return render(<PlanningCenterIntegrationPanel
    status={{ enabled: true, connected: true, loading: false, planningCenterAccount: 'Example church', ...status }}
    refreshStatus={vi.fn()} onBack={vi.fn()} peopleSyncSettings={peopleSyncSettings} peopleSyncStatus="known"
    providerConnections={{ planning_center: true, elvanto: true }} refreshPeopleSync={vi.fn()} retryPeopleSync={vi.fn()}
  />);
}

describe('PlanningCenterIntegrationPanel source drafts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches).mockResolvedValue({ data: { batches: [batch] } });
    vi.mocked(integrationsAPI.getPlanningCenterSyncStats).mockResolvedValue({ data: { totalPeople: 0, syncedPeople: 0 } });
    vi.mocked(integrationsAPI.getCheckinAvailability).mockResolvedValue({ data: { available: false, hasImported: false, peopleLinked: true } });
    vi.mocked(settingsAPI.getIntegrationSettings).mockResolvedValue({ data: { planningCenterSyncEnabled: true, planningCenterTrackBackgroundChecks: false } });
  });

  it('shows a pending List change and discards that draft without removing the batch', async () => {
    vi.mocked(peopleSyncAPI.discardSourceDraft).mockResolvedValue({ data: { batch } });
    renderPanel();
    expect(await screen.findByText('Members')).toBeInTheDocument();
    expect(screen.getByText(/Needs full review/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard source draft' }));
    await waitFor(() => expect(peopleSyncAPI.discardSourceDraft).toHaveBeenCalledWith('planning_center', 12));
    await waitFor(() => expect(integrationsAPI.getPlanningCenterSyncBatches).toHaveBeenCalledTimes(2));
  });

  it('shows source check errors with their safe code instead of calling the source missing', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches).mockResolvedValue({
      data: { batches: [{ ...batch, sourceStatus: 'error', sourceStatusErrorCode: 'SYNC_SOURCE_CHECK_FAILED' }] },
    });
    renderPanel();

    expect(await screen.findByText('Source check failed · SYNC_SOURCE_CHECK_FAILED')).toBeInTheDocument();
    expect(screen.queryByText('Source missing')).not.toBeInTheDocument();
  });

  it('explains a stale source-draft action when its batch has been retired', async () => {
    vi.mocked(peopleSyncAPI.discardSourceDraft).mockRejectedValue({
      response: { data: { code: 'PCO_LEGACY_BATCH_RETIRED', error: 'Batch retired.' } },
    });
    renderPanel();

    expect(await screen.findByText('Members')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard source draft' }));

    expect(await screen.findByText('This legacy batch has been retired. Reload the page to view or delete it.')).toBeInTheDocument();
  });

  it('renders a historical object sync result without crashing the integration page', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches).mockResolvedValue({
      data: {
        batches: [{
          ...batch,
          lastSyncAt: '2026-07-29T01:30:00.000Z',
          lastSyncResult: { addPeople: 2, updateManagedFields: 1 },
        }],
      },
    });

    renderPanel();

    expect(await screen.findByText('Members')).toBeInTheDocument();
    expect(screen.getByText(/2 people added · 1 person updated/)).toBeInTheDocument();
  });

  it('renders retired legacy batches as history and confirms deletion using the canonical batch id', async () => {
    const legacyBatch = {
      ...batch,
      id: 53,
      name: 'Old membership filters',
      gatheringTypeId: 8,
      scheduleEnabled: true,
      scheduleFrequency: 'daily' as const,
      legacyProviderBatchId: 41,
      lastSyncAt: '2026-07-28T01:30:00.000Z',
      lastSyncResult: { addPeople: 2 },
    } as PeopleSyncBatch;
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches).mockResolvedValue({ data: { batches: [batch, legacyBatch] } });
    vi.mocked(integrationsAPI.deletePlanningCenterSyncBatch).mockResolvedValue({ data: { success: true } });

    renderPanel();

    expect(await screen.findByText('Sync batches')).toBeInTheDocument();
    expect(screen.getByText('Retired legacy batches')).toBeInTheDocument();
    expect(screen.getByText('Old membership filters')).toBeInTheDocument();
    expect(screen.getByText(/no longer runs/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Review & sync' })).toHaveLength(1);

    const legacyCard = screen.getByText('Old membership filters').closest('li');
    expect(legacyCard).not.toBeNull();
    fireEvent.click(within(legacyCard!).getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Delete retired legacy batch?')).toBeInTheDocument();
    expect(screen.getByText(/People already imported and gathering assignments already created will remain/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete retired batch' }));
    await waitFor(() => expect(integrationsAPI.deletePlanningCenterSyncBatch).toHaveBeenCalledWith(53));
  });

  it('offers reconnect when stored Planning Center credentials need replacement', async () => {
    // Catches recovery state being rendered as an ordinary first-time connection.
    vi.mocked(integrationsAPI.authorizePlanningCenter).mockResolvedValue({ data: { authUrl: '#pco-oauth' } });
    renderPanel({ status: { connected: false, reconnectRequired: true, connectionErrorCode: 'SYNC_SOURCE_AUTH' } });

    expect(screen.getByRole('button', { name: 'Reconnect Planning Center' })).toBeEnabled();
    expect(screen.getByText(/Lists, batches, and linked people/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect Planning Center' }));
    await waitFor(() => expect(integrationsAPI.authorizePlanningCenter).toHaveBeenCalledTimes(1));
  });

  it('keeps the initial connect wording when no reconnect is required', () => {
    // Catches a missing connection being incorrectly presented as credential recovery.
    renderPanel({ status: { connected: false, reconnectRequired: false, connectionErrorCode: null } });

    expect(screen.getByRole('button', { name: 'Connect Planning Center' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect Planning Center' })).not.toBeInTheDocument();
  });

  it('does not block reconnect when Planning Center is authoritative', () => {
    // Catches the destructive Disconnect guard leaking into the non-destructive reconnect flow.
    renderPanel({
      status: { connected: false, reconnectRequired: true, connectionErrorCode: 'SYNC_SOURCE_AUTH' },
      peopleSyncSettings: { ...settings, authorityProvider: 'planning_center' },
    });

    expect(screen.getByRole('button', { name: 'Reconnect Planning Center' })).toBeEnabled();
  });

  it('keeps Disconnect guarded when a connected Planning Center is authoritative', async () => {
    // Catches a connected authoritative provider exposing a destructive confirmation action.
    renderPanel({ peopleSyncSettings: { ...settings, authorityProvider: 'planning_center' } });
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(await screen.findByText(/authoritative people source/i)).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: 'Disconnect' })).toHaveLength(1);
  });
});
