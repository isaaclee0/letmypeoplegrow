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

test('warns before adopting an existing badge and confirms authoritative cleanup', async () => {
  vi.mocked(settingsAPI.getIntegrationSettings).mockResolvedValue({ data: { planningCenterMedicalNotes: {
    enabled: false, minimumRole: 'admin', gatheringTypeIds: [], badgeIcon: null, badgeColor: null,
    lastRefreshedAt: null, lastRefreshResult: null,
  } } } as any);
  vi.mocked(settingsAPI.getMedicalBadgeAppearances).mockResolvedValue({ data: { appearances: [{ icon: 'heart', color: '#facc15', count: 2 }] } } as any);
  vi.mocked(gatheringsAPI.getAll).mockResolvedValue({ data: { gatheringTypes: [{ id: 1, name: 'Sunday', attendanceType: 'standard', isActive: true }] } } as any);
  vi.mocked(settingsAPI.updateIntegrationSettings).mockResolvedValue({ data: { adoptedCount: 2 } } as any);

  render(<PlanningCenterMedicalNotesSettings />);
  await screen.findByText(/2 people/i);
  fireEvent.click(screen.getByLabelText(/use existing heart/i));
  fireEvent.click(screen.getByLabelText(/Sunday/));
  fireEvent.click(screen.getByRole('checkbox', { name: /enable medical-note indicators/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Save medical-note settings' }));
  expect(await screen.findByText(/remove this manually assigned badge/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Confirm and save/i }));
  await waitFor(() => expect(settingsAPI.updateIntegrationSettings).toHaveBeenCalledWith(expect.objectContaining({
    planningCenterMedicalNotes: expect.objectContaining({ adoptExistingAppearance: true, badgeIcon: 'heart', badgeColor: '#facc15' }),
  })));
});
