import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function renderPanel() {
  return render(<PlanningCenterIntegrationPanel
    status={{ enabled: true, connected: true, loading: false, planningCenterAccount: 'Example church' }}
    refreshStatus={vi.fn()} onBack={vi.fn()} peopleSyncSettings={settings} peopleSyncStatus="known"
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
});
