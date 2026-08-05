import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import PlanningCenterMedicalNotesSettings from './PlanningCenterMedicalNotesSettings';
import { gatheringsAPI, settingsAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  gatheringsAPI: { getAll: vi.fn() },
  settingsAPI: {
    getIntegrationSettings: vi.fn(),
    getMedicalBadgeAppearances: vi.fn(),
    updateIntegrationSettings: vi.fn(),
    refreshMedicalNoteStatuses: vi.fn(),
  },
}));

const loadSettings = () => {
  vi.mocked(settingsAPI.getIntegrationSettings).mockResolvedValue({ data: { planningCenterMedicalNotes: {
    enabled: false, minimumRole: 'admin', gatheringTypeIds: [], badgeIcon: null, badgeColor: null,
    lastRefreshedAt: null, lastRefreshResult: null,
  } } } as any);
  vi.mocked(settingsAPI.getMedicalBadgeAppearances).mockResolvedValue({ data: { appearances: [{ icon: 'heart', color: '#facc15', count: 2 }] } } as any);
  vi.mocked(gatheringsAPI.getAll).mockResolvedValue({ data: { gatheringTypes: [{ id: 1, name: 'Sunday', attendanceType: 'standard', isActive: true }] } } as any);
  vi.mocked(settingsAPI.updateIntegrationSettings).mockResolvedValue({ data: { adoptedCount: 2 } } as any);
};

test('starts collapsed, expands when enabled, and remains manually collapsible', async () => {
  loadSettings();

  render(<PlanningCenterMedicalNotesSettings />);

  const enabled = await screen.findByRole('switch', { name: 'Enable medical-note indicators' });
  expect(screen.queryByLabelText('Minimum access level')).not.toBeInTheDocument();

  fireEvent.click(enabled);
  expect(screen.getByLabelText('Minimum access level')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Collapse medical-note indicator settings' }));
  expect(screen.queryByLabelText('Minimum access level')).not.toBeInTheDocument();
  expect(enabled).toHaveAttribute('aria-checked', 'true');
});

test('uses icon tiles and matching colour controls for a new appearance', async () => {
  loadSettings();

  render(<PlanningCenterMedicalNotesSettings />);
  await screen.findByRole('switch', { name: 'Enable medical-note indicators' });
  fireEvent.click(screen.getByRole('button', { name: 'Expand medical-note indicator settings' }));

  fireEvent.click(screen.getByRole('button', { name: 'Use Heart icon' }));
  fireEvent.change(screen.getByLabelText('Indicator colour hex'), { target: { value: '#123456' } });

  expect(screen.getByRole('button', { name: 'Use Heart icon' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByLabelText('Indicator colour picker')).toHaveValue('#123456');
});

test('warns before adopting an existing badge and confirms authoritative cleanup', async () => {
  loadSettings();

  render(<PlanningCenterMedicalNotesSettings />);
  await screen.findByRole('switch', { name: 'Enable medical-note indicators' });
  fireEvent.click(screen.getByRole('button', { name: 'Expand medical-note indicator settings' }));
  expect(screen.queryByText(/2 people/i)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Adopt existing' }));
  await screen.findByText(/2 people/i);
  fireEvent.click(screen.getByLabelText(/use existing heart/i));
  fireEvent.click(screen.getByLabelText(/Sunday/));
  fireEvent.click(screen.getByRole('switch', { name: /enable medical-note indicators/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Save medical-note settings' }));
  expect(await screen.findByText(/remove this manually assigned badge/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Confirm and save/i }));
  await waitFor(() => expect(settingsAPI.updateIntegrationSettings).toHaveBeenCalledWith(expect.objectContaining({
    planningCenterMedicalNotes: expect.objectContaining({ adoptExistingAppearance: true, badgeIcon: 'heart', badgeColor: '#facc15' }),
  })));
});
