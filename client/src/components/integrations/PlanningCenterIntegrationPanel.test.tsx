import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { integrationsAPI, peopleSyncAPI, settingsAPI } from '../../services/api';
import type { PeopleSyncBatch, PeopleSyncSettings } from '../peopleSync/types';
import PlanningCenterIntegrationPanel from './PlanningCenterIntegrationPanel';

vi.mock('../../services/api', () => ({
  integrationsAPI: {
    getPlanningCenterSyncBatches: vi.fn(),
    getPlanningCenterSyncStats: vi.fn(),
    getCheckinAvailability: vi.fn(),
    authorizePlanningCenter: vi.fn(),
    disconnectPlanningCenter: vi.fn(),
    deletePlanningCenterSyncBatch: vi.fn(),
  },
  settingsAPI: {
    getIntegrationSettings: vi.fn(),
    updateIntegrationSettings: vi.fn(),
  },
  peopleSyncAPI: {
    previewAuthority: vi.fn(),
    applyAuthority: vi.fn(),
    disableAuthority: vi.fn(),
  },
}));

vi.mock('../PCOCheckinImport', () => ({ default: () => null }));
vi.mock('../planningCenter/PlanningCenterSyncReview', () => ({ default: () => null }));
vi.mock('../planningCenter/PlanningCenterBatchEditor', () => ({
  default: ({ onSaved }: { onSaved: (batch: unknown) => void }) => (
    <button type="button" onClick={() => onSaved({})}>Complete batch save</button>
  ),
}));

const settings: PeopleSyncSettings = {
  authorityProvider: 'none',
  pendingAuthorityProvider: null,
  elvantoIncludeContacts: true,
  elvantoAlignPeopleType: true,
  fullReconciliationFrequency: 'weekly',
  fullReconciliationDay: 1,
};

const batch: PeopleSyncBatch = {
  id: 12, provider: 'planning_center', name: 'Members', enabled: true,
  filterSchemaVersion: 1, filterConfig: {}, filterRevision: 1,
  draftFilterSchemaVersion: null, draftFilterConfig: null, draftFilterBaseRevision: null,
  draftFilterUpdatedAt: null, needsFilterReview: false,
  defaultPeopleType: 'regular',
  gatheringTypeId: null,
  gatheringAutoRemoveEnabled: false,
  scheduleEnabled: true,
  scheduleFrequency: 'weekly',
  scheduleDay: 1,
  lastSyncAt: null,
  lastSyncResult: null,
};

type PanelProps = React.ComponentProps<typeof PlanningCenterIntegrationPanel>;

function panel(overrides: Partial<PanelProps> = {}) {
  return (
    <PlanningCenterIntegrationPanel
      status={{ enabled: true, connected: true, loading: false, planningCenterAccount: 'Example church' }}
      refreshStatus={vi.fn()}
      onBack={vi.fn()}
      peopleSyncSettings={settings}
      peopleSyncStatus="known"
      providerConnections={{ planning_center: true, elvanto: true }}
      refreshPeopleSync={vi.fn()}
      retryPeopleSync={vi.fn()}
      {...overrides}
    />
  );
}

function renderPanel(overrides: Partial<PanelProps> = {}) {
  return render(panel(overrides));
}

describe('PlanningCenterIntegrationPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches).mockResolvedValue({
      data: { batches: [batch] },
    });
    vi.mocked(integrationsAPI.getPlanningCenterSyncStats).mockResolvedValue({
      data: { totalPeople: 0, syncedPeople: 0 },
    });
    vi.mocked(integrationsAPI.getCheckinAvailability).mockResolvedValue({
      data: { available: false, hasImported: false, peopleLinked: true },
    });
    vi.mocked(settingsAPI.getIntegrationSettings).mockResolvedValue({
      data: { planningCenterSyncEnabled: true, planningCenterTrackBackgroundChecks: false },
    });
  });

  it('enables authority for an actual-shaped legacy sync batch', async () => {
    renderPanel();

    const sourceSwitch = screen.getByRole('switch', { name: 'Use Planning Center as source of truth' });
    await waitFor(() => expect(sourceSwitch).toBeEnabled());
  });

  it('disables authority while deleting the last batch reloads', async () => {
    let resolveReloadedBatches!: (value: { data: { batches: PeopleSyncBatch[] } }) => void;
    const reloadedBatchesResponse = new Promise<{ data: { batches: PeopleSyncBatch[] } }>((resolve) => {
      resolveReloadedBatches = resolve;
    });
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches)
      .mockResolvedValueOnce({ data: { batches: [batch] } })
      .mockImplementationOnce(
        () => reloadedBatchesResponse as ReturnType<typeof integrationsAPI.getPlanningCenterSyncBatches>,
      );
    vi.mocked(integrationsAPI.deletePlanningCenterSyncBatch).mockResolvedValue({ data: { success: true } });
    renderPanel();

    await screen.findAllByText('Members');
    const sourceSwitch = screen.getByRole('switch', { name: 'Use Planning Center as source of truth' });
    expect(sourceSwitch).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(integrationsAPI.getPlanningCenterSyncBatches).toHaveBeenCalledTimes(2));
    expect(sourceSwitch).toBeDisabled();
    fireEvent.click(sourceSwitch);
    expect(peopleSyncAPI.previewAuthority).not.toHaveBeenCalled();

    await act(async () => {
      resolveReloadedBatches({ data: { batches: [] } });
    });
    expect(await screen.findByText('Create a Planning Center sync batch first.')).toBeInTheDocument();
  });

  it('keeps authority disabled when the post-delete batch reload fails', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches)
      .mockResolvedValueOnce({ data: { batches: [batch] } })
      .mockRejectedValueOnce({ response: { data: { error: 'Planning Center batches could not be reloaded.' } } });
    vi.mocked(integrationsAPI.deletePlanningCenterSyncBatch).mockResolvedValue({ data: { success: true } });
    renderPanel();

    await screen.findAllByText('Members');
    const sourceSwitch = screen.getByRole('switch', { name: 'Use Planning Center as source of truth' });
    expect(sourceSwitch).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Planning Center batches could not be reloaded.')).toBeInTheDocument();
    expect(sourceSwitch).toBeDisabled();
    fireEvent.click(sourceSwitch);
    expect(peopleSyncAPI.previewAuthority).not.toHaveBeenCalled();
  });

  it('ignores an older initial response after a post-save reload completes', async () => {
    let resolveInitialBatches!: (value: { data: { batches: PeopleSyncBatch[] } }) => void;
    const initialBatchesResponse = new Promise<{ data: { batches: PeopleSyncBatch[] } }>((resolve) => {
      resolveInitialBatches = resolve;
    });
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches)
      .mockImplementationOnce(
        () => initialBatchesResponse as ReturnType<typeof integrationsAPI.getPlanningCenterSyncBatches>,
      )
      .mockResolvedValueOnce({ data: { batches: [] } });
    renderPanel();

    const sourceSwitch = screen.getByRole('switch', { name: 'Use Planning Center as source of truth' });
    expect(sourceSwitch).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'New batch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete batch save' }));

    await waitFor(() => expect(integrationsAPI.getPlanningCenterSyncBatches).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Create a Planning Center sync batch first.')).toBeInTheDocument();

    await act(async () => {
      resolveInitialBatches({ data: { batches: [batch] } });
    });

    await waitFor(() => expect(screen.queryByText('Members')).not.toBeInTheDocument());
    expect(sourceSwitch).toBeDisabled();
    fireEvent.click(sourceSwitch);
    expect(peopleSyncAPI.previewAuthority).not.toHaveBeenCalled();
  });

  it('allows an authoritative Planning Center source to be turned off while disconnected', async () => {
    vi.mocked(peopleSyncAPI.disableAuthority).mockResolvedValue({
      data: { success: true, authority: { active: 'none', pending: null } },
    });
    renderPanel({
      status: { enabled: true, connected: false, loading: false, planningCenterAccount: null },
      peopleSyncSettings: { ...settings, authorityProvider: 'planning_center' },
      providerConnections: { planning_center: false, elvanto: true },
    });

    const sourceSwitch = screen.getByRole('switch', { name: 'Use Planning Center as source of truth' });
    expect(sourceSwitch).toBeChecked();
    expect(sourceSwitch).toBeEnabled();
    fireEvent.click(sourceSwitch);
    fireEvent.click(screen.getByRole('button', { name: 'Use no people source' }));

    await waitFor(() => expect(peopleSyncAPI.disableAuthority).toHaveBeenCalledTimes(1));
  });

  it('clears stale batches when a reconnect load fails', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches)
      .mockResolvedValueOnce({ data: { batches: [batch] } })
      .mockRejectedValueOnce({ response: { data: { error: 'Reconnect batch load failed.' } } });
    const { rerender } = renderPanel();

    await screen.findAllByText('Members');
    rerender(panel({
      status: { enabled: true, connected: false, loading: false, planningCenterAccount: null },
      providerConnections: { planning_center: false, elvanto: true },
    }));
    rerender(panel({
      status: { enabled: true, connected: true, loading: false, planningCenterAccount: 'Example church' },
    }));

    expect(await screen.findByText('Reconnect batch load failed.')).toBeInTheDocument();
    expect(screen.queryByText('Members')).not.toBeInTheDocument();
    const sourceSwitch = screen.getByRole('switch', { name: 'Use Planning Center as source of truth' });
    expect(sourceSwitch).toBeDisabled();
    fireEvent.click(sourceSwitch);
    expect(peopleSyncAPI.previewAuthority).not.toHaveBeenCalled();
  });
});
