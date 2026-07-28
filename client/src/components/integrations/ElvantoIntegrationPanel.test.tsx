import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { elvantoSyncAPI, gatheringsAPI, integrationsAPI, peopleSyncAPI } from '../../services/api';
import ElvantoIntegrationPanel from './ElvantoIntegrationPanel';
import type { PeopleSyncBatch, PeopleSyncPlan, PeopleSyncReview, PeopleSyncRun, PeopleSyncSettings } from '../peopleSync/types';

vi.mock('../../services/api', () => ({
  integrationsAPI: {
    connectElvanto: vi.fn(), disconnectElvanto: vi.fn(),
    getElvantoGroups: vi.fn(), getElvantoServices: vi.fn(),
    checkGatheringDuplicates: vi.fn(), importGatheringsFromElvanto: vi.fn(),
  },
  peopleSyncAPI: {
    getSettings: vi.fn(), updateSettings: vi.fn(), previewAuthority: vi.fn(),
    applyAuthority: vi.fn(), disableAuthority: vi.fn(), getRuns: vi.fn(),
  },
  elvantoSyncAPI: {
    getMetadata: vi.fn(), refreshMetadata: vi.fn(), listBatches: vi.fn(),
    deleteBatch: vi.fn(), getBatchPlan: vi.fn(), applyBatch: vi.fn(), runBatchNow: vi.fn(),
  },
  gatheringsAPI: { getAll: vi.fn(), create: vi.fn() },
}));

const settings: PeopleSyncSettings = {
  authorityProvider: 'none', pendingAuthorityProvider: null,
  elvantoIncludeContacts: true, elvantoAlignPeopleType: true,
  fullReconciliationFrequency: 'weekly', fullReconciliationDay: 1,
};
const metadata = {
  fetchedAt: '2026-07-25T10:00:00.000Z', categories: [], groups: [],
  demographics: [], departments: [], serviceTypes: [], locations: [], customFields: [],
};
const batch: PeopleSyncBatch = {
  id: 5, provider: 'elvanto', name: 'Members', enabled: true, filterSchemaVersion: 1,
  filterConfig: {}, defaultPeopleType: 'regular', gatheringTypeId: null,
  gatheringAutoRemoveEnabled: false, scheduleEnabled: false, scheduleFrequency: 'weekly',
  scheduleDay: 1, legacyProviderBatchId: null, lastExternalWatermark: null,
  lastSyncAt: null, lastSyncResult: null,
};
const emptyPlan: PeopleSyncPlan = {
  provider: 'elvanto', authoritative: false, snapshot: { fetchedAt: '2026-07-25T10:00:00.000Z', mode: 'full' },
  linkPeople: [], linkFamilies: [], addPeople: [], addFamilies: [], updateManagedFields: [],
  promoteToRegular: [], demoteToLocalVisitor: [], archive: [], reactivate: [], moveFamily: [],
  renameFamily: [], addToGathering: [], removeFromGathering: [], ambiguousPeople: [],
  familyConflicts: [], unmatchedLocalRegulars: [], skipped: [],
};
const review: PeopleSyncReview = {
  runId: 8, reviewToken: 'batch-review', plan: emptyPlan, snapshot: emptyPlan.snapshot,
  summary: {
    linkPeople: 0, linkFamilies: 0, addPeople: 0, addFamilies: 0, updateManagedFields: 0,
    promoteToRegular: 0, demoteToLocalVisitor: 0, archive: 0, reactivate: 0,
    moveFamily: 0, renameFamily: 0, addToGathering: 0, removeFromGathering: 0,
    ambiguousPeople: 0, familyConflicts: 0, unmatchedLocalRegulars: 0, skipped: 0,
  },
};
const run: PeopleSyncRun = {
  id: 9, provider: 'elvanto', batchId: 5, trigger: 'scheduled', fetchMode: 'full',
  status: 'applied', counts: { addPeople: 2, updateManagedFields: 1 },
  reviewNotificationFingerprint: null, errorCode: null, errorMessage: null,
  externalWatermark: null, startedAt: '2026-07-25T11:00:00.000Z', completedAt: '2026-07-25T11:01:00.000Z',
};

function setupConnected(overrides: Partial<React.ComponentProps<typeof ElvantoIntegrationPanel>> = {}) {
  return render(
    <ElvantoIntegrationPanel
      status={{ connected: true, loading: false, elvantoAccount: 'Example church' }}
      refreshStatus={vi.fn()}
      onBack={vi.fn()}
      peopleSyncSettings={settings}
      peopleSyncStatus="known"
      providerConnections={{ planning_center: true, elvanto: true }}
      refreshPeopleSync={vi.fn()}
      retryPeopleSync={vi.fn()}
      {...overrides}
    />,
  );
}

describe('ElvantoIntegrationPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(elvantoSyncAPI.getMetadata).mockResolvedValue({ data: { success: true, metadata, stale: false, cached: true } });
    vi.mocked(elvantoSyncAPI.listBatches).mockResolvedValue({ data: { success: true, batches: [batch] } });
    vi.mocked(peopleSyncAPI.getRuns).mockResolvedValue({ data: { success: true, runs: [run] } });
    vi.mocked(gatheringsAPI.getAll).mockResolvedValue({ data: { gatherings: [] } });
    vi.mocked(integrationsAPI.getElvantoGroups).mockResolvedValue({ data: { groups: { group: [] } } });
    vi.mocked(integrationsAPI.getElvantoServices).mockResolvedValue({ data: { services: { service: [] } } });
  });

  it('keeps the key secret, clears it after connect, and loads sync data only once connected', async () => {
    const refreshStatus = vi.fn();
    vi.mocked(integrationsAPI.connectElvanto).mockResolvedValue({ data: { success: true, status: {} as never } });
    const { rerender } = render(
      <ElvantoIntegrationPanel
        status={{ connected: false, loading: false, elvantoAccount: null }}
        refreshStatus={refreshStatus} onBack={vi.fn()} peopleSyncSettings={settings}
        peopleSyncStatus="known" providerConnections={{ planning_center: true, elvanto: false }} refreshPeopleSync={vi.fn()} retryPeopleSync={vi.fn()}
      />,
    );
    const key = screen.getByLabelText('Elvanto API key');
    expect(key).toHaveAttribute('type', 'password');
    expect(screen.queryByDisplayValue(/saved|secret/i)).not.toBeInTheDocument();
    expect(elvantoSyncAPI.getMetadata).not.toHaveBeenCalled();
    expect(elvantoSyncAPI.listBatches).not.toHaveBeenCalled();

    fireEvent.change(key, { target: { value: 'new-secret-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Elvanto' }));
    await waitFor(() => expect(integrationsAPI.connectElvanto).toHaveBeenCalledWith('new-secret-key'));
    expect(key).toHaveValue('');

    rerender(
      <ElvantoIntegrationPanel
        status={{ connected: true, loading: false, elvantoAccount: 'Example church' }}
        refreshStatus={refreshStatus} onBack={vi.fn()} peopleSyncSettings={settings}
        peopleSyncStatus="known" providerConnections={{ planning_center: true, elvanto: true }} refreshPeopleSync={vi.fn()} retryPeopleSync={vi.fn()}
      />,
    );
    await waitFor(() => expect(elvantoSyncAPI.getMetadata).toHaveBeenCalled());
    expect(elvantoSyncAPI.listBatches).toHaveBeenCalled();
    expect(screen.queryByText('new-secret-key')).not.toBeInTheDocument();
  });

  it('retains connected state and explains an invalid replacement key', async () => {
    vi.mocked(integrationsAPI.connectElvanto).mockRejectedValue({ response: { data: { error: 'Invalid API key' } } });
    setupConnected();

    fireEvent.change(screen.getByLabelText('Elvanto API key'), { target: { value: 'bad-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace API key' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Elvanto is still connected');
    expect(screen.getByText('Connected to Example church')).toBeInTheDocument();
  });

  it('clears and reloads all connection-scoped sync data after a valid connected key replacement', async () => {
    const refreshStatus = vi.fn();
    vi.mocked(integrationsAPI.connectElvanto).mockResolvedValue({ data: { success: true, status: {} as never } });
    vi.mocked(integrationsAPI.getElvantoGroups)
      .mockResolvedValueOnce({ data: { groups: { group: [{ id: 'old-group', name: 'Old remote group' }] } } })
      .mockResolvedValue({ data: { groups: { group: [{ id: 'new-group', name: 'New remote group' }] } } });
    vi.mocked(integrationsAPI.getElvantoServices)
      .mockResolvedValueOnce({ data: { services: { service: [{ id: 'old-service', service_type: { id: 'old-type', name: 'Old service type' } }] } } })
      .mockResolvedValue({ data: { services: { service: [{ id: 'new-service', service_type: { id: 'new-type', name: 'New service type' } }] } } });
    setupConnected({ refreshStatus });
    await screen.findByText(/2 added/);
    expect(await screen.findByRole('checkbox', { name: 'Old remote group' })).toBeInTheDocument();
    expect(elvantoSyncAPI.getMetadata).toHaveBeenCalledTimes(1);
    expect(elvantoSyncAPI.listBatches).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('Elvanto API key'), { target: { value: 'valid-replacement' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace API key' }));

    await waitFor(() => expect(refreshStatus).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(elvantoSyncAPI.getMetadata).toHaveBeenCalledTimes(2));
    expect(elvantoSyncAPI.listBatches).toHaveBeenCalledTimes(2);
    expect(peopleSyncAPI.getRuns).toHaveBeenCalledTimes(2);
    expect(gatheringsAPI.getAll).toHaveBeenCalledTimes(2);
    expect(integrationsAPI.getElvantoGroups).toHaveBeenCalledTimes(2);
    expect(integrationsAPI.getElvantoServices).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('checkbox', { name: 'New remote group' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'New service type (1)' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Old remote group' })).not.toBeInTheDocument();
  });

  it('ignores an older connected-data response after a replacement-key reload completes', async () => {
    let resolveStaleBatches!: (value: { data: { success: true; batches: PeopleSyncBatch[] } }) => void;
    const staleBatchesResponse = new Promise<{ data: { success: true; batches: PeopleSyncBatch[] } }>((resolve) => {
      resolveStaleBatches = resolve;
    });
    const staleBatch = { ...batch, id: 6, name: 'Stale Members' };
    const currentBatch = { ...batch, id: 7, name: 'Current Members' };
    const staleRun = { ...run, id: 10, counts: { addPeople: 1 } };
    const currentRun = { ...run, id: 11, counts: { addPeople: 7 } };

    vi.mocked(elvantoSyncAPI.listBatches)
      .mockImplementationOnce(() => staleBatchesResponse as ReturnType<typeof elvantoSyncAPI.listBatches>)
      .mockResolvedValueOnce({ data: { success: true, batches: [currentBatch] } });
    vi.mocked(peopleSyncAPI.getRuns)
      .mockResolvedValueOnce({ data: { success: true, runs: [staleRun] } })
      .mockResolvedValueOnce({ data: { success: true, runs: [currentRun] } });
    vi.mocked(integrationsAPI.connectElvanto).mockResolvedValue({ data: { success: true, status: {} as never } });
    setupConnected({ refreshStatus: vi.fn() });

    fireEvent.change(screen.getByLabelText('Elvanto API key'), { target: { value: 'replacement-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace API key' }));

    expect(await screen.findByText('Current Members')).toBeInTheDocument();
    expect(screen.getByText(/7 added/)).toBeInTheDocument();

    await act(async () => {
      resolveStaleBatches({ data: { success: true, batches: [staleBatch] } });
    });

    await waitFor(() => expect(screen.queryByText('Stale Members')).not.toBeInTheDocument());
    expect(screen.getByText('Current Members')).toBeInTheDocument();
    expect(screen.getByText(/7 added/)).toBeInTheDocument();
  });

  it('enables the provider-local source switch after an enabled batch loads', async () => {
    setupConnected();

    const sourceSwitch = screen.getByRole('switch', { name: 'Use Elvanto as source of truth' });
    expect(sourceSwitch).toBeDisabled();
    await waitFor(() => expect(sourceSwitch).toBeEnabled());
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('disables the provider-local source switch when no batches exist', async () => {
    vi.mocked(elvantoSyncAPI.listBatches).mockResolvedValue({ data: { success: true, batches: [] } });
    setupConnected();

    expect(await screen.findByText('Create and enable an Elvanto sync batch first.')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' })).toBeDisabled();
  });

  it('disables the provider-local source switch when all batches are disabled', async () => {
    vi.mocked(elvantoSyncAPI.listBatches).mockResolvedValue({
      data: { success: true, batches: [{ ...batch, enabled: false }] },
    });
    setupConnected();

    await screen.findByText('Members');
    expect(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' })).toBeDisabled();
    expect(screen.getByText('Create and enable an Elvanto sync batch first.')).toBeInTheDocument();
  });

  it('disables authority while deleting the last enabled batch reloads', async () => {
    let resolveReloadedBatches!: (value: { data: { success: true; batches: PeopleSyncBatch[] } }) => void;
    const reloadedBatchesResponse = new Promise<{ data: { success: true; batches: PeopleSyncBatch[] } }>((resolve) => {
      resolveReloadedBatches = resolve;
    });
    vi.mocked(elvantoSyncAPI.listBatches)
      .mockResolvedValueOnce({ data: { success: true, batches: [batch] } })
      .mockImplementationOnce(() => reloadedBatchesResponse as ReturnType<typeof elvantoSyncAPI.listBatches>);
    vi.mocked(elvantoSyncAPI.deleteBatch).mockResolvedValue({ data: { success: true } });
    setupConnected();

    await screen.findByText('Members');
    const sourceSwitch = screen.getByRole('switch', { name: 'Use Elvanto as source of truth' });
    expect(sourceSwitch).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(elvantoSyncAPI.listBatches).toHaveBeenCalledTimes(2));
    expect(sourceSwitch).toBeDisabled();
    fireEvent.click(sourceSwitch);
    expect(peopleSyncAPI.previewAuthority).not.toHaveBeenCalled();

    await act(async () => {
      resolveReloadedBatches({ data: { success: true, batches: [] } });
    });
    expect(await screen.findByText('Create and enable an Elvanto sync batch first.')).toBeInTheDocument();
  });

  it('keeps authority disabled when the post-delete batch reload fails', async () => {
    vi.mocked(elvantoSyncAPI.listBatches)
      .mockResolvedValueOnce({ data: { success: true, batches: [batch] } })
      .mockRejectedValueOnce({ response: { data: { error: 'Elvanto batches could not be reloaded.' } } });
    vi.mocked(elvantoSyncAPI.deleteBatch).mockResolvedValue({ data: { success: true } });
    setupConnected();

    await screen.findByText('Members');
    const sourceSwitch = screen.getByRole('switch', { name: 'Use Elvanto as source of truth' });
    expect(sourceSwitch).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Elvanto batches could not be reloaded.')).toBeInTheDocument();
    expect(sourceSwitch).toBeDisabled();
    fireEvent.click(sourceSwitch);
    expect(peopleSyncAPI.previewAuthority).not.toHaveBeenCalled();
  });

  it('reviews and applies a batch through the shared SyncReview', async () => {
    vi.mocked(elvantoSyncAPI.getBatchPlan).mockResolvedValue({ data: { success: true, ...review } });
    vi.mocked(elvantoSyncAPI.applyBatch).mockResolvedValue({
      data: { success: true, runId: 8, status: 'applied', applied: {} as never, summary: review.summary },
    });
    setupConnected();

    fireEvent.click(await screen.findByRole('button', { name: 'Review & sync Members' }));
    expect(await screen.findByText('Elvanto sync review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply sync' }));

    await waitFor(() => expect(elvantoSyncAPI.applyBatch).toHaveBeenCalledWith(5, {
      reviewToken: 'batch-review', selections: expect.any(Object),
    }));
  });

  it('opens Run now as a shared review and only applies after explicit approval', async () => {
    vi.mocked(elvantoSyncAPI.runBatchNow).mockResolvedValue({
      data: { success: true, ...review },
    });
    vi.mocked(elvantoSyncAPI.applyBatch).mockResolvedValue({
      data: { success: true, runId: 8, status: 'applied', applied: {} as never, summary: review.summary },
    });
    setupConnected();

    const recentRuns = (await screen.findByText('Recent Elvanto runs')).closest('section')!;
    expect(within(recentRuns).getByText(/2 added/)).toBeInTheDocument();
    expect(screen.getByText(/1 updated/)).toBeInTheDocument();
    expect(within(recentRuns).queryByText(/raw|api.?key|watermark/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run Members now' }));

    expect(await screen.findByText('Elvanto sync review')).toBeInTheDocument();
    expect(elvantoSyncAPI.applyBatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply sync' }));
    await waitFor(() => expect(elvantoSyncAPI.applyBatch).toHaveBeenCalledWith(5, {
      reviewToken: 'batch-review', selections: expect.any(Object),
    }));
  });

  it('warns before disconnecting while Elvanto is authoritative', async () => {
    setupConnected({ peopleSyncSettings: { ...settings, authorityProvider: 'elvanto' } });
    await screen.findByText(/2 added/);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Elvanto' }));

    expect(screen.getByText(/Elvanto is your authoritative people source/)).toBeInTheDocument();
    expect(integrationsAPI.disconnectElvanto).not.toHaveBeenCalled();
  });

  it('allows an authoritative Elvanto source to be turned off while disconnected', async () => {
    vi.mocked(peopleSyncAPI.disableAuthority).mockResolvedValue({
      data: { success: true, authority: { active: 'none', pending: null } },
    });
    render(
      <ElvantoIntegrationPanel
        status={{ connected: false, loading: false, elvantoAccount: null }}
        refreshStatus={vi.fn()}
        onBack={vi.fn()}
        peopleSyncSettings={{ ...settings, authorityProvider: 'elvanto' }}
        peopleSyncStatus="known"
        providerConnections={{ planning_center: true, elvanto: false }}
        refreshPeopleSync={vi.fn()}
        retryPeopleSync={vi.fn()}
      />,
    );

    const sourceSwitch = screen.getByRole('switch', { name: 'Use Elvanto as source of truth' });
    expect(sourceSwitch).toBeChecked();
    expect(sourceSwitch).toBeEnabled();
    fireEvent.click(sourceSwitch);
    fireEvent.click(screen.getByRole('button', { name: 'Use no people source' }));

    await waitFor(() => expect(peopleSyncAPI.disableAuthority).toHaveBeenCalledTimes(1));
  });

  it('does not render a disconnect confirmation action while authority is unknown', async () => {
    setupConnected({ peopleSyncStatus: 'loading', initialAction: 'disconnect' });
    await screen.findByText(/2 added/);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/authoritative people source is not known/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Confirm disconnect' })).not.toBeInTheDocument();
    expect(integrationsAPI.disconnectElvanto).not.toHaveBeenCalled();
  });

  it('defaults both church-level options on, saves explicit keys, and explains lifecycle effects', async () => {
    vi.mocked(peopleSyncAPI.updateSettings)
      .mockResolvedValueOnce({ data: { success: true, settings: { ...settings, elvantoIncludeContacts: false } } })
      .mockResolvedValueOnce({ data: { success: true, settings: { ...settings, elvantoAlignPeopleType: false } } });
    setupConnected();

    await screen.findByText(/2 added/);
    const includeContacts = await screen.findByRole('checkbox', { name: /Include Contacts/ });
    const alignPeopleType = screen.getByRole('checkbox', { name: /Keep people type aligned/ });
    expect(includeContacts).toBeChecked();
    expect(alignPeopleType).toBeChecked();
    fireEvent.click(includeContacts);
    await waitFor(() => expect(peopleSyncAPI.updateSettings).toHaveBeenCalledWith({ elvantoIncludeContacts: false }));
    expect(screen.getByText(/next review may propose people type or lifecycle changes/i)).toBeInTheDocument();
    fireEvent.click(alignPeopleType);
    await waitFor(() => expect(peopleSyncAPI.updateSettings).toHaveBeenCalledWith({ elvantoAlignPeopleType: false }));
  });
});
