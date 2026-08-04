import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { integrationsAPI, peopleSyncAPI, settingsAPI } from '../../services/api';
import PlanningCenterIntegrationPanel from './PlanningCenterIntegrationPanel';
import PeopleSourceControl from '../peopleSync/PeopleSourceControl';
import type { PeopleSyncBatch, PeopleSyncSettings } from '../peopleSync/types';

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));

vi.mock('react-router-dom', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-router-dom')>(),
  useNavigate: () => mockNavigate,
}));

vi.mock('../../services/api', () => ({
  integrationsAPI: {
    getPlanningCenterSyncBatches: vi.fn(), getPlanningCenterSyncStats: vi.fn(),
    getCheckinAvailability: vi.fn(), authorizePlanningCenter: vi.fn(),
    disconnectPlanningCenter: vi.fn(), deletePlanningCenterSyncBatch: vi.fn(),
    getPlanningCenterBatchPlan: vi.fn(), previewPlanningCenterLinkCorrections: vi.fn(),
    applyPlanningCenterBatch: vi.fn(),
  },
  peopleSyncAPI: {
    discardSourceDraft: vi.fn(), disableAuthority: vi.fn(), previewAuthority: vi.fn(),
    cancelAuthorityPreview: vi.fn(), applyAuthority: vi.fn(),
  },
  settingsAPI: { getIntegrationSettings: vi.fn(), updateIntegrationSettings: vi.fn() },
}));
vi.mock('../PCOCheckinImport', () => ({ default: () => null }));
vi.mock('../planningCenter/PlanningCenterBatchEditor', () => ({
  default: ({ onSaved }: { onSaved: (savedBatch: PeopleSyncBatch) => void }) => (
    <div>
      Batch editor
      <button type="button" onClick={() => onSaved({ id: 48 } as PeopleSyncBatch)}>Save mocked batch</button>
    </div>
  ),
}));
vi.mock('../peopleSync/AuthorityReviewWorkspace', () => ({
  default: ({ onApplied }: { onApplied: () => void | Promise<void> }) => (
    <button type="button" onClick={() => void onApplied()}>Complete authority review</button>
  ),
}));

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
  operationalState: 'source_review_required', reviewable: true, runnable: false,
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
    providerConnections={{ planning_center: true, elvanto: true }} peopleSyncBatchRevision={0} refreshPeopleSync={vi.fn()} retryPeopleSync={vi.fn()}
  />);
}

describe('PlanningCenterIntegrationPanel source drafts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches).mockResolvedValue({ data: { batches: [batch] } });
    vi.mocked(integrationsAPI.getPlanningCenterSyncStats).mockResolvedValue({ data: { totalPeople: 0, syncedPeople: 0 } });
    vi.mocked(integrationsAPI.getCheckinAvailability).mockResolvedValue({ data: { available: false, hasImported: false, peopleLinked: true } });
    vi.mocked(settingsAPI.getIntegrationSettings).mockResolvedValue({ data: { planningCenterSyncEnabled: true, planningCenterTrackBackgroundChecks: false } });
    vi.mocked(integrationsAPI.getPlanningCenterBatchPlan).mockReturnValue(new Promise(() => {}));
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

  it('opens the dedicated batch review without fetching or rendering a review inline when automatic sync is off', async () => {
    const user = userEvent.setup();
    vi.mocked(settingsAPI.getIntegrationSettings).mockResolvedValue({
      data: { planningCenterSyncEnabled: false, planningCenterTrackBackgroundChecks: false },
    });
    renderPanel();
    const reviewButton = await screen.findByRole('button', { name: 'Review source & sync Members' });
    expect(reviewButton).toHaveClass('rounded-md', 'bg-green-600', 'text-white');

    await user.click(reviewButton);

    expect(mockNavigate).toHaveBeenCalledWith('/app/settings/integrations/planning-center/batches/12/review');
    expect(integrationsAPI.getPlanningCenterBatchPlan).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Planning Center batch sync review' })).not.toBeInTheDocument();
  });

  it('keeps active batches reviewable using the server-provided controls', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches).mockResolvedValue({
      data: { batches: [{ ...batch, draftSource: null, draftSourceBaseRevision: null, draftSourceUpdatedAt: null, needsSourceReview: false, operationalState: 'active', reviewable: true, runnable: true }] },
    });
    renderPanel();

    expect(await screen.findByText('Active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review & sync Members' })).toBeInTheDocument();
  });

  it('keeps prepared batches editable while waiting for an authority switch', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches).mockResolvedValue({
      data: { batches: [{ ...batch, operationalState: 'prepared', reviewable: false, runnable: false }] },
    });
    renderPanel();

    expect(await screen.findByText('Prepared for source switch')).toBeInTheDocument();
    expect(screen.getByText('Switch source of truth to activate this batch.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard source draft' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review & sync Members' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run now' })).not.toBeInTheDocument();
  });

  it('refreshes the current batch to its server-derived prepared state after the real source-control disable completes', async () => {
    vi.mocked(peopleSyncAPI.disableAuthority).mockResolvedValue({
      data: { success: true, authority: { active: 'none', pending: null } },
    });
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches)
      .mockResolvedValueOnce({ data: { batches: [{ ...batch, draftSource: null, needsSourceReview: false, operationalState: 'active' }] } })
      .mockResolvedValueOnce({ data: { batches: [{ ...batch, draftSource: null, needsSourceReview: false, operationalState: 'prepared' }] } });
    function Harness() {
      const [peopleSyncSettings, setPeopleSyncSettings] = useState<PeopleSyncSettings>({ ...settings, authorityProvider: 'planning_center' });
      const [peopleSyncBatchRevision, setPeopleSyncBatchRevision] = useState(0);
      return <PlanningCenterIntegrationPanel
        status={{ enabled: true, connected: true, loading: false, planningCenterAccount: 'Example church' }}
        refreshStatus={vi.fn()} onBack={vi.fn()} peopleSyncSettings={peopleSyncSettings} peopleSyncStatus="known"
        providerConnections={{ planning_center: true, elvanto: true }} peopleSyncBatchRevision={peopleSyncBatchRevision}
        refreshPeopleSync={async () => {
          setPeopleSyncSettings((current) => ({ ...current, authorityProvider: 'none' }));
          setPeopleSyncBatchRevision((revision) => revision + 1);
        }}
        retryPeopleSync={vi.fn()}
      />;
    }
    render(<Harness />);

    expect(await screen.findByText('Active')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Use Planning Center as source of truth' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use no people source' }));

    await waitFor(() => expect(peopleSyncAPI.disableAuthority).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(integrationsAPI.getPlanningCenterSyncBatches).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Prepared for source switch')).toBeInTheDocument();
  });

  it('refreshes the former provider batch to the server-derived prepared state after the real source-control switch', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches)
      .mockResolvedValueOnce({ data: { batches: [{ ...batch, draftSource: null, needsSourceReview: false, operationalState: 'active' }] } })
      .mockResolvedValueOnce({ data: { batches: [{ ...batch, draftSource: null, needsSourceReview: false, operationalState: 'prepared' }] } });
    function Harness() {
      const [peopleSyncSettings, setPeopleSyncSettings] = useState<PeopleSyncSettings>({ ...settings, authorityProvider: 'planning_center' });
      const [peopleSyncBatchRevision, setPeopleSyncBatchRevision] = useState(0);
      const refreshPeopleSync = async () => {
        setPeopleSyncSettings((current) => ({ ...current, authorityProvider: 'elvanto' }));
        setPeopleSyncBatchRevision((revision) => revision + 1);
      };
      return <>
        <PeopleSourceControl
          provider="elvanto"
          batches={[{ ...batch, id: 13, provider: 'elvanto', source: { ...batch.source!, kind: 'elvanto_category' } }]}
          settings={peopleSyncSettings}
          connections={{ planning_center: true, elvanto: true }}
          onRefresh={refreshPeopleSync}
        />
        <PlanningCenterIntegrationPanel
          status={{ enabled: true, connected: true, loading: false, planningCenterAccount: 'Example church' }}
          refreshStatus={vi.fn()} onBack={vi.fn()} peopleSyncSettings={peopleSyncSettings} peopleSyncStatus="known"
          providerConnections={{ planning_center: true, elvanto: true }} peopleSyncBatchRevision={peopleSyncBatchRevision}
          refreshPeopleSync={refreshPeopleSync} retryPeopleSync={vi.fn()}
        />
      </>;
    }
    render(<Harness />);

    expect(await screen.findByText('Active')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Use Elvanto as source of truth' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue to review' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Complete authority review' }));

    await waitFor(() => expect(integrationsAPI.getPlanningCenterSyncBatches).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Prepared for source switch')).toBeInTheDocument();
  });

  it('uses the server reviewability flag for source review batches', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches).mockResolvedValue({
      data: { batches: [{ ...batch, operationalState: 'source_review_required', reviewable: true, runnable: false }] },
    });
    renderPanel();

    expect(await screen.findByText('Source review required')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review source & sync Members' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run now' })).not.toBeInTheDocument();
  });

  it('shows the server-provided disabled state without review controls', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches).mockResolvedValue({
      data: { batches: [{ ...batch, enabled: false, operationalState: 'disabled', reviewable: false, runnable: false }] },
    });
    renderPanel();

    expect(await screen.findByText('Disabled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review & sync Members' })).not.toBeInTheDocument();
  });

  it('keeps a disabled batch draft actionable without presenting it as a source review', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches).mockResolvedValue({
      data: { batches: [{ ...batch, enabled: false, operationalState: 'disabled', reviewable: false, runnable: false }] },
    });
    renderPanel();

    expect(await screen.findByText('Disabled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard source draft' })).toBeInTheDocument();
    expect(screen.queryByText(/Needs full review/)).not.toBeInTheDocument();
  });

  it('opens one combined authority review after creating the first batch with no source of truth', async () => {
    renderPanel();
    await screen.findByText('Members');

    fireEvent.click(screen.getByRole('button', { name: 'New batch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save mocked batch' }));

    expect(mockNavigate).toHaveBeenCalledWith('/app/settings/integrations/planning-center/authority-review?reason=first-batch');
    expect(integrationsAPI.getPlanningCenterBatchPlan).not.toHaveBeenCalled();
  });

  it('opens ordinary batch review after creating another batch for the active authority', async () => {
    renderPanel({ peopleSyncSettings: { ...settings, authorityProvider: 'planning_center' } });
    await screen.findByText('Members');

    fireEvent.click(screen.getByRole('button', { name: 'New batch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save mocked batch' }));

    expect(mockNavigate).toHaveBeenCalledWith('/app/settings/integrations/planning-center/batches/48/review');
  });

  it('keeps a new batch prepared with switch guidance when another provider is authoritative', async () => {
    renderPanel({ peopleSyncSettings: { ...settings, authorityProvider: 'elvanto' } });
    await screen.findByText('Members');

    fireEvent.click(screen.getByRole('button', { name: 'New batch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save mocked batch' }));

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(await screen.findByText('Batch prepared. Switch source of truth to review and activate it.')).toBeInTheDocument();
    expect(integrationsAPI.getPlanningCenterBatchPlan).not.toHaveBeenCalled();
    await waitFor(() => expect(integrationsAPI.getPlanningCenterSyncBatches).toHaveBeenCalledTimes(2));
  });

  it('keeps the existing reload behavior after editing a batch', async () => {
    renderPanel();
    await screen.findByText('Members');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save mocked batch' }));

    expect(mockNavigate).not.toHaveBeenCalled();
    await waitFor(() => expect(integrationsAPI.getPlanningCenterSyncBatches).toHaveBeenCalledTimes(2));
  });

  it('retains modern batch edit and delete mutations beside dedicated review navigation', async () => {
    vi.mocked(integrationsAPI.deletePlanningCenterSyncBatch).mockResolvedValue({ data: { success: true } });
    renderPanel();

    expect(await screen.findByText('Members')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByText('Batch editor')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(integrationsAPI.deletePlanningCenterSyncBatch).toHaveBeenCalledWith(12));
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
      priorScheduleEnabled: true,
      priorScheduleFrequency: 'monthly' as const,
      priorScheduleDay: 15,
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
    expect(screen.getByText(/Prior settings: scheduled monthly \(day 15\)/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Review source & sync Members' })).toHaveLength(1);

    const legacyCard = screen.getByText('Old membership filters').closest('li');
    expect(legacyCard).not.toBeNull();
    fireEvent.click(within(legacyCard!).getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Delete retired legacy batch?')).toBeInTheDocument();
    expect(screen.getByText(/People already imported and gathering assignments already created will remain/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete retired batch' }));
    await waitFor(() => expect(integrationsAPI.deletePlanningCenterSyncBatch).toHaveBeenCalledWith(53));
  });

  it('shows Never run in legacy history when a retired batch has no last run', async () => {
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches).mockResolvedValue({
      data: { batches: [{ ...batch, id: 53, name: 'Old membership filters', legacyProviderBatchId: 41, lastSyncAt: null }] },
    });
    renderPanel();

    expect(await screen.findByText('Old membership filters')).toBeInTheDocument();
    expect(screen.getByText('Last run Never run.')).toBeInTheDocument();
  });

  it('keeps a rejected retired-batch delete visible and disables repeat confirmation while it is pending', async () => {
    let rejectDelete: (reason: unknown) => void = () => {};
    vi.mocked(integrationsAPI.getPlanningCenterSyncBatches).mockResolvedValue({
      data: { batches: [{ ...batch, id: 53, name: 'Old membership filters', legacyProviderBatchId: 41 }] },
    });
    vi.mocked(integrationsAPI.deletePlanningCenterSyncBatch).mockImplementation(() => new Promise((_, reject) => {
      rejectDelete = reject;
    }) as never);
    renderPanel();

    expect(await screen.findByText('Old membership filters')).toBeInTheDocument();
    fireEvent.click(within(screen.getByText('Old membership filters').closest('li')!).getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete retired batch' }));
    expect(screen.getByRole('button', { name: 'Deleting retired batch…' })).toBeDisabled();

    rejectDelete({ response: { data: { error: 'Could not delete this old batch.' } } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not delete this old batch.');
    expect(screen.getByRole('button', { name: 'Delete retired batch' })).toBeEnabled();
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

  it('does not offer Planning Center as a people source before it is connected', () => {
    // Catches the authority control leaking into the pre-connection setup view.
    renderPanel({ status: { connected: false } });

    expect(screen.queryByText('People source control')).not.toBeInTheDocument();
  });

  it("shows What you'll get before connection and hides it after connection", async () => {
    // Catches introductory benefits continuing to occupy the connected management view.
    const disconnected = renderPanel({ status: { connected: false } });
    expect(screen.getByRole('heading', { name: "What you'll get" })).toBeInTheDocument();

    disconnected.unmount();
    renderPanel();
    await screen.findByText('Members');
    expect(screen.queryByRole('heading', { name: "What you'll get" })).not.toBeInTheDocument();
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
