import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
    getPlanningCenterBatchPlan: vi.fn(),
    applyPlanningCenterBatch: vi.fn(),
  },
  settingsAPI: {
    getIntegrationSettings: vi.fn(),
    updateIntegrationSettings: vi.fn(),
  },
  peopleSyncAPI: {
    previewAuthority: vi.fn(),
    applyAuthority: vi.fn(),
    disableAuthority: vi.fn(),
    discardFilterDraft: vi.fn(),
  },
}));

vi.mock('../PCOCheckinImport', () => ({ default: () => null }));
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
  draftFilterUpdatedAt: null, needsFilterReview: false, initialFilterReviewPending: false,
  defaultPeopleType: 'regular',
  gatheringTypeId: null,
  gatheringAutoRemoveEnabled: false,
  scheduleEnabled: true,
  scheduleFrequency: 'weekly',
  scheduleDay: 1,
  lastSyncAt: null,
  lastSyncResult: null,
};

const draftBatch: PeopleSyncBatch = {
  ...batch, filterSchemaVersion: 2, filterConfig: { branches: [], exclusions: [] }, filterRevision: 2,
  draftFilterSchemaVersion: 2, draftFilterConfig: { branches: [{ groups: [{ dimensionId: 'membership', mode: 'any', values: ['Member'] }] }], exclusions: [] },
  draftFilterBaseRevision: 2, draftFilterUpdatedAt: '2026-07-29T00:00:00.000Z', needsFilterReview: true,
};
const promotedBatch: PeopleSyncBatch = {
  ...draftBatch, filterRevision: 3, filterConfig: draftBatch.draftFilterConfig!,
  draftFilterSchemaVersion: null, draftFilterConfig: null, draftFilterBaseRevision: null, draftFilterUpdatedAt: null, needsFilterReview: false,
};
const review = {
  success: true, runId: 7, reviewToken: 'pco-review',
  snapshot: { fetchedAt: '2026-07-29T00:00:00.000Z', mode: 'full' as const },
  plan: { provider: 'planning_center' as const, authoritative: false, snapshot: { fetchedAt: '2026-07-29T00:00:00.000Z', mode: 'full' as const },
    linkPeople: [], linkFamilies: [], addPeople: [], addFamilies: [], updateManagedFields: [], promoteToRegular: [], demoteToLocalVisitor: [], archive: [], reactivate: [], moveFamily: [], renameFamily: [], addToGathering: [], removeFromGathering: [], ambiguousPeople: [], familyConflicts: [], unmatchedLocalRegulars: [], skipped: [] },
  summary: { linkPeople: 0, linkFamilies: 0, addPeople: 0, addFamilies: 0, updateManagedFields: 0, promoteToRegular: 0, demoteToLocalVisitor: 0, archive: 0, reactivate: 0, moveFamily: 0, renameFamily: 0, addToGathering: 0, removeFromGathering: 0, ambiguousPeople: 0, familyConflicts: 0, unmatchedLocalRegulars: 0, skipped: 0 },
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
  return render(<MemoryRouter>{panel(overrides)}</MemoryRouter>);
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
    vi.mocked(integrationsAPI.getPlanningCenterBatchPlan).mockResolvedValue({ data: review });
    vi.mocked(integrationsAPI.applyPlanningCenterBatch).mockResolvedValue({ data: { success: true, runId: 7, status: 'applied', applied: {} as never, summary: review.summary } });
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

  it('uses the real review, then reloads the promoted active filter after apply', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches).mockReset();
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches)
      .mockResolvedValueOnce({ data: { batches: [draftBatch] } })
      .mockResolvedValueOnce({ data: { batches: [promotedBatch] } });
    renderPanel();

    expect(await screen.findByText(/Needs full review/)).toBeInTheDocument();
    expect(screen.getByText(/Draft criteria will not run until reviewed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review & sync' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply sync' }));

    await waitFor(() => expect(integrationsAPI.applyPlanningCenterBatch).toHaveBeenCalledWith(12, {
      reviewToken: 'pco-review', selections: expect.any(Object),
    }));
    await waitFor(() => expect(integrationsAPI.getPlanningCenterSyncBatches).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/Needs full review/)).not.toBeInTheDocument());
  });

  it('discards only a Planning Center draft and retains the active schedule', async () => {
    const discarded = { ...draftBatch, draftFilterSchemaVersion: null, draftFilterConfig: null, draftFilterBaseRevision: null, draftFilterUpdatedAt: null, needsFilterReview: false };
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches).mockReset();
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches)
      .mockResolvedValueOnce({ data: { batches: [draftBatch] } })
      .mockResolvedValueOnce({ data: { batches: [discarded] } });
    vi.mocked(peopleSyncAPI.discardFilterDraft).mockResolvedValue({ data: { success: true, batch: {} as never } });
    renderPanel();

    expect(await screen.findByText(/Needs full review/)).toBeInTheDocument();
    expect(screen.getByText('Runs weekly')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    await waitFor(() => expect(peopleSyncAPI.discardFilterDraft).toHaveBeenCalledWith('planning_center', 12));
    await waitFor(() => expect(integrationsAPI.getPlanningCenterSyncBatches).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Runs weekly')).toBeInTheDocument();
    expect(screen.queryByText(/Needs full review/)).not.toBeInTheDocument();
  });

  it('does not offer to discard the unpromoted initial Planning Center draft', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches).mockResolvedValue({
      data: { batches: [{ ...draftBatch, filterRevision: 1, initialFilterReviewPending: true }] },
    });
    renderPanel();

    expect(await screen.findByText(/Needs full review/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Discard draft' })).not.toBeInTheDocument();
  });

  it('explains the automatic-sync master switch and marks scheduled batches paused while off', async () => {
    vi.mocked(settingsAPI.getIntegrationSettings).mockResolvedValue({
      data: { planningCenterSyncEnabled: false, planningCenterTrackBackgroundChecks: false },
    });
    renderPanel();

    expect(await screen.findByText(/automatic scheduled sync/i)).toBeInTheDocument();
    expect(screen.getByText(/manual Review & sync remains available/i)).toBeInTheDocument();
    expect(screen.getByText(/Automatic sync paused/i)).toBeInTheDocument();
    expect(screen.queryByText('Runs weekly')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review & sync' })).toBeEnabled();
  });
});
