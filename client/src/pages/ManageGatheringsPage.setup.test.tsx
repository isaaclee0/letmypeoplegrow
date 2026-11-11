import React from 'react';
import { AxiosHeaders, type AxiosResponse } from 'axios';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gatheringsAPI } from '../services/api';
import ManageGatheringsPage from './ManageGatheringsPage';

function response<T>(data: T): AxiosResponse<T> {
  return { data, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
}

const auth = vi.hoisted(() => ({ role: 'admin', isChurchApproved: true }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: auth, refreshUserData: vi.fn() }),
}));
vi.mock('../services/api', () => ({
  gatheringsAPI: { getAll: vi.fn(), update: vi.fn(), create: vi.fn() },
  onboardingAPI: { loadSampleData: vi.fn() },
  kioskAPI: { getStatus: vi.fn().mockResolvedValue({ data: { enabled: true } }) },
  settingsAPI: { getIntegrationSettings: vi.fn().mockResolvedValue(response({})) },
}));

function renderGatheringsPage() {
  render(<MemoryRouter><ManageGatheringsPage /></MemoryRouter>);
}

describe('Gathering setup and self check-in visibility', () => {
  beforeEach(() => {
    auth.role = 'admin';
    auth.isChurchApproved = true;
    vi.mocked(gatheringsAPI.getAll).mockResolvedValue(response({ gatherings: [] }));
    vi.mocked(gatheringsAPI.create).mockResolvedValue(response({ id: 1 }));
    vi.mocked(gatheringsAPI.update).mockResolvedValue(response({}));
  });

  it('offers explicit setup to an approved admin without opening the normal form', async () => {
    renderGatheringsPage();
    expect(await screen.findByRole('link', { name: 'Start setup' })).toHaveAttribute('href', '/app/onboarding?start=1');
    expect(screen.queryByRole('heading', { name: 'Gathering Details' })).not.toBeInTheDocument();
  });

  it.each([
    { role: 'coordinator', isChurchApproved: true },
    { role: 'admin', isChurchApproved: false },
  ])('withholds setup for $role with approval $isChurchApproved', async ({ role, isChurchApproved }) => {
    Object.assign(auth, { role, isChurchApproved });
    renderGatheringsPage();
    await screen.findByRole('heading', { name: 'No gatherings' });
    expect(screen.queryByRole('link', { name: 'Start setup' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Gathering Details' })).not.toBeInTheDocument();
  });

  it('creates with kiosk disabled even when the feature flag is enabled', async () => {
    const user = userEvent.setup();
    renderGatheringsPage();
    await screen.findByRole('heading', { name: 'No gatherings' });
    await user.click(screen.getByRole('button', { name: 'Add Gathering' }));
    expect(screen.getByRole('checkbox', { name: 'Leader Check-in' })).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: 'Self Check-in' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create Gathering' }));
    expect(gatheringsAPI.create).toHaveBeenCalledWith(expect.objectContaining({ kioskEnabled: false }));
  });

  it('preserves an enabled kiosk while editing without exposing the control', async () => {
    const user = userEvent.setup();
    vi.mocked(gatheringsAPI.getAll).mockResolvedValue(response({ gatherings: [{
        id: 19, name: 'Sunday Service', description: '', dayOfWeek: 'Sunday',
        startTime: '10:00', endTime: '11:00', frequency: 'weekly',
        attendanceType: 'standard', kioskEnabled: true, kioskMessage: 'Welcome!', isActive: true, memberCount: 4,
      }] }));
    renderGatheringsPage();
    await user.click(await screen.findByText('Sunday Service'));
    await user.click(screen.getByTitle('Edit Gathering'));
    expect(screen.getByRole('checkbox', { name: 'Leader Check-in' })).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: 'Self Check-in' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Update Gathering' }));
    await waitFor(() => expect(gatheringsAPI.update).toHaveBeenCalledWith(19, expect.objectContaining({ kioskEnabled: true, kioskMessage: 'Welcome!' })));
  });

  it('can edit details for a standard gathering with an existing recurring custom schedule', async () => {
    const user = userEvent.setup();
    const customSchedule = {
      type: 'recurring', startDate: '2027-03-01', endDate: '2027-05-01',
      pattern: { frequency: 'monthly', interval: 1, dayOfMonth: 15 },
    };
    vi.mocked(gatheringsAPI.getAll).mockResolvedValue(response({ gatherings: [{
        id: 22, name: 'Kids club', description: '', attendanceType: 'standard',
        customSchedule, isActive: true, memberCount: 4,
      }] }));
    renderGatheringsPage();
    await user.click(await screen.findByText('Kids club'));
    await user.click(screen.getByTitle('Edit Gathering'));
    const name = screen.getByRole('textbox', { name: /gathering name/i });
    await user.clear(name);
    await user.type(name, 'Holiday club');
    await user.click(screen.getByRole('button', { name: 'Update Gathering' }));
    await waitFor(() => expect(gatheringsAPI.update).toHaveBeenCalledWith(22, expect.objectContaining({
      name: 'Holiday club', attendanceType: 'standard', customSchedule,
    })));
  });
});
