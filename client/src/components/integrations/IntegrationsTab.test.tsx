import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aiAPI, integrationsAPI, peopleSyncAPI } from '../../services/api';
import IntegrationsTab from './IntegrationsTab';

vi.mock('../../services/api', () => ({
  integrationsAPI: {
    getElvantoStatus: vi.fn(),
    getPlanningCenterStatus: vi.fn(),
  },
  aiAPI: { getStatus: vi.fn() },
  peopleSyncAPI: { getSettings: vi.fn() },
}));

vi.mock('../../utils/logger', () => ({
  default: { error: vi.fn() },
}));

vi.mock('./PlanningCenterIntegrationPanel', () => ({
  default: ({
    status,
    onBack,
    peopleSyncBatchRevision,
    refreshPeopleSync,
  }: {
    status: { connectionErrorCode?: string | null };
    onBack: () => void;
    peopleSyncBatchRevision: number;
    refreshPeopleSync: () => Promise<void>;
  }) => (
    <section aria-label="Planning Center integration panel">
      <div data-testid="planning-center-status-code">{status.connectionErrorCode ?? 'none'}</div>
      <div data-testid="planning-center-batch-revision">{peopleSyncBatchRevision}</div>
      <button type="button" onClick={() => void refreshPeopleSync()}>Refresh provider batches</button>
      <button type="button" onClick={onBack}>Back to integrations</button>
    </section>
  ),
}));

vi.mock('./ElvantoIntegrationPanel', () => ({
  default: ({
    onBack,
    peopleSyncBatchRevision,
    refreshPeopleSync,
  }: {
    onBack: () => void;
    peopleSyncBatchRevision: number;
    refreshPeopleSync: () => Promise<void>;
  }) => (
    <section aria-label="Elvanto integration panel">
      <div data-testid="elvanto-batch-revision">{peopleSyncBatchRevision}</div>
      <button type="button" onClick={() => void refreshPeopleSync()}>Refresh provider batches</button>
      <button type="button" onClick={onBack}>Back to integrations</button>
    </section>
  ),
}));

const settings = {
  authorityProvider: 'planning_center' as const,
  pendingAuthorityProvider: null,
  elvantoIncludeContacts: true,
  elvantoAlignPeopleType: true,
  fullReconciliationFrequency: 'weekly' as const,
  fullReconciliationDay: 1,
};

describe('IntegrationsTab authority status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/app/settings?tab=integrations');
    vi.mocked(integrationsAPI.getElvantoStatus).mockResolvedValue({ data: { connected: true, elvantoAccount: 'Elvanto church' } });
    vi.mocked(integrationsAPI.getPlanningCenterStatus).mockResolvedValue({ data: { enabled: true, connected: true, planningCenterAccount: 'PCO church' } });
    vi.mocked(aiAPI.getStatus).mockResolvedValue({ data: { configured: false, provider: null } });
    vi.mocked(peopleSyncAPI.getSettings).mockResolvedValue({ data: { success: true, settings } });
  });

  it.each([
    ['elvanto', 'Elvanto integration panel'],
    ['planning-center', 'Planning Center integration panel'],
  ])('restores the %s provider panel from the integration return query', async (provider, panelName) => {
    window.history.replaceState({}, '', `/app/settings?tab=integrations&integration=${provider}`);
    render(<IntegrationsTab />);

    expect(await screen.findByRole('region', { name: panelName })).toBeInTheDocument();
    await waitFor(() => expect(peopleSyncAPI.getSettings).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('heading', { name: 'External Integrations' })).not.toBeInTheDocument();
  });

  it('falls back to the integration card list for an unknown integration query', async () => {
    window.history.replaceState({}, '', '/app/settings?tab=integrations&integration=unknown');
    render(<IntegrationsTab />);

    expect(await screen.findByRole('heading', { name: 'External Integrations' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /integration panel/ })).not.toBeInTheDocument();
  });

  it.each(['elvanto', 'planning-center'])('removes the %s integration query when returning to the card list', async (provider) => {
    window.history.replaceState({}, '', `/app/settings?tab=integrations&integration=${provider}`);
    render(<IntegrationsTab />);

    fireEvent.click(await screen.findByRole('button', { name: 'Back to integrations' }));

    expect(window.location.pathname).toBe('/app/settings');
    expect(window.location.search).toBe('?tab=integrations');
    expect(screen.getByRole('heading', { name: 'External Integrations' })).toBeInTheDocument();
  });

  it('blocks both disconnect paths while authority is loading', async () => {
    vi.mocked(peopleSyncAPI.getSettings).mockReturnValue(new Promise(() => {}));
    render(<IntegrationsTab />);

    await screen.findByText('Elvanto church');
    expect(screen.getByText('Checking authoritative people source…')).toBeInTheDocument();
    screen.getAllByRole('button', { name: 'Disconnect' }).forEach((button) => expect(button).toBeDisabled());
  });

  it('shows a safe retry state after authority loading fails and enables guarded actions only after retry succeeds', async () => {
    vi.mocked(peopleSyncAPI.getSettings)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ data: { success: true, settings } });
    render(<IntegrationsTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the authoritative people source');
    screen.getAllByRole('button', { name: 'Disconnect' }).forEach((button) => expect(button).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Retry people source status' }));

    await waitFor(() => expect(screen.getByText('Authoritative people source')).toBeInTheDocument());
    screen.getAllByRole('button', { name: 'Disconnect' }).forEach((button) => expect(button).toBeEnabled());
  });

  it('invalidates both provider batch views after a people-source refresh', async () => {
    window.history.replaceState({}, '', '/app/settings?tab=integrations&integration=elvanto');
    vi.mocked(peopleSyncAPI.getSettings)
      .mockResolvedValueOnce({ data: { success: true, settings } })
      .mockResolvedValueOnce({ data: { success: true, settings: { ...settings, authorityProvider: 'elvanto' } } });
    render(<IntegrationsTab />);

    expect(await screen.findByTestId('elvanto-batch-revision')).toHaveTextContent('0');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh provider batches' }));
    await waitFor(() => expect(screen.getByTestId('elvanto-batch-revision')).toHaveTextContent('1'));

    fireEvent.click(screen.getByRole('button', { name: 'Back to integrations' }));
    const planningCenterCard = screen.getByText('Planning Center').closest('.border');
    expect(planningCenterCard).not.toBeNull();
    fireEvent.click(within(planningCenterCard!).getByRole('button', { name: 'Edit Planning Center settings' }));

    expect(await screen.findByTestId('planning-center-batch-revision')).toHaveTextContent('1');
  });

  it.each([
    ['SYNC_SOURCE_AUTH', 'SYNC_SOURCE_AUTH'],
    ['SYNC_SOURCE_RATE_LIMIT', 'SYNC_SOURCE_RATE_LIMIT'],
    ['SYNC_SOURCE_CHECK_FAILED', 'SYNC_SOURCE_CHECK_FAILED'],
    ['refresh_token=credential-value', 'none'],
  ])('preserves only the safe Planning Center status code %s', async (connectionErrorCode, expectedCode) => {
    vi.mocked(integrationsAPI.getPlanningCenterStatus).mockResolvedValue({
      data: {
        enabled: true,
        connected: false,
        planningCenterAccount: null,
        connectionErrorCode,
      },
    } as never);
    vi.mocked(peopleSyncAPI.getSettings).mockResolvedValue({ data: { success: true, settings } });
    render(<IntegrationsTab />);

    const planningCenterCard = (await screen.findByText('Planning Center')).closest('.border');
    expect(planningCenterCard).not.toBeNull();
    fireEvent.click(within(planningCenterCard!).getByRole('button', { name: 'Set up' }));

    expect(await screen.findByTestId('planning-center-status-code')).toHaveTextContent(expectedCode);
  });
});
