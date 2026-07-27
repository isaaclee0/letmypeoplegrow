import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    vi.mocked(integrationsAPI.getElvantoStatus).mockResolvedValue({ data: { connected: true, elvantoAccount: 'Elvanto church' } });
    vi.mocked(integrationsAPI.getPlanningCenterStatus).mockResolvedValue({ data: { enabled: true, connected: true, planningCenterAccount: 'PCO church' } });
    vi.mocked(aiAPI.getStatus).mockResolvedValue({ data: { configured: false, provider: null } });
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
});
