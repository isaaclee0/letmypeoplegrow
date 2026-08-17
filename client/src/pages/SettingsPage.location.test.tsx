import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPage from './SettingsPage';
import { settingsAPI } from '../services/api';

const { updateUser } = vi.hoisted(() => ({ updateUser: vi.fn() }));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 1,
      role: 'admin',
      firstName: 'Admin',
      lastName: 'User',
      primaryContactMethod: 'email',
    },
    updateUser,
  }),
}));

vi.mock('../components/integrations/IntegrationsTab', () => ({ default: () => null }));
vi.mock('../components/WeeklyReviewGuidanceWizard', () => ({ default: () => null }));
vi.mock('../utils/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('../services/api', () => ({
  usersAPI: { updateMe: vi.fn() },
  settingsAPI: {
    getAll: vi.fn().mockResolvedValue({ data: { settings: {} } }),
    searchLocation: vi.fn(),
    updateLocation: vi.fn(),
    updateDefaultBadge: vi.fn(),
    getWeeklyReview: vi.fn(),
    updateWeeklyReview: vi.fn(),
    sendTestWeeklyReview: vi.fn(),
    sendTestCaregiverDigest: vi.fn(),
  },
  visitorConfigAPI: {
    getConfig: vi.fn().mockResolvedValue({
      data: { localVisitorServiceLimit: 6, travellerVisitorServiceLimit: 2 },
    }),
    updateConfig: vi.fn(),
  },
  takeoutAPI: { exportData: vi.fn(), deleteChurch: vi.fn() },
  aiAPI: { getWeeklyGuidance: vi.fn() },
}));

describe('SettingsPage location search', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(settingsAPI.getAll).mockResolvedValue({ data: { settings: {} } } as never);
  });

  it('waits for three characters before searching for a city', async () => {
    render(<SettingsPage />);

    fireEvent.change(screen.getByLabelText('Search for your city'), {
      target: { value: 'Ho' },
    });
    await act(async () => {
      vi.advanceTimersByTime(301);
    });

    expect(settingsAPI.searchLocation).not.toHaveBeenCalled();
  });

  it('keeps the newest city results when an older request finishes last', async () => {
    let resolveOlder!: (value: unknown) => void;
    let resolveNewer!: (value: unknown) => void;
    vi.mocked(settingsAPI.searchLocation)
      .mockReturnValueOnce(new Promise((resolve) => { resolveOlder = resolve; }) as never)
      .mockReturnValueOnce(new Promise((resolve) => { resolveNewer = resolve; }) as never);
    render(<SettingsPage />);
    const input = screen.getByLabelText('Search for your city');

    fireEvent.change(input, { target: { value: 'Hob' } });
    await act(async () => { vi.advanceTimersByTime(301); });
    fireEvent.change(input, { target: { value: 'Hobart' } });
    await act(async () => { vi.advanceTimersByTime(301); });

    await act(async () => {
      resolveNewer({
        data: {
          results: [{ name: 'Hobart', admin1: 'Tasmania', country: 'Australia' }],
        },
      });
    });
    expect(screen.getByText('Hobart')).toBeInTheDocument();

    await act(async () => {
      resolveOlder({
        data: {
          results: [{ name: 'Hoboken', admin1: 'New Jersey', country: 'United States' }],
        },
      });
    });

    expect(screen.getByText('Hobart')).toBeInTheDocument();
    expect(screen.queryByText('Hoboken')).not.toBeInTheDocument();
  });

  it('shows when the current search has no matching cities', async () => {
    vi.mocked(settingsAPI.searchLocation).mockResolvedValue({ data: { results: [] } } as never);
    render(<SettingsPage />);

    fireEvent.change(screen.getByLabelText('Search for your city'), {
      target: { value: 'Nowhere' },
    });
    await act(async () => { vi.advanceTimersByTime(301); });

    expect(screen.getByText('No cities found.')).toBeInTheDocument();
  });

  it('shows when the location service is unavailable', async () => {
    vi.mocked(settingsAPI.searchLocation).mockRejectedValue(new Error('upstream unavailable'));
    render(<SettingsPage />);

    fireEvent.change(screen.getByLabelText('Search for your city'), {
      target: { value: 'Hobart' },
    });
    await act(async () => { vi.advanceTimersByTime(301); });

    expect(screen.getByText('Location search is temporarily unavailable.')).toBeInTheDocument();
  });

  it('shows formatted population and Open-Meteo attribution when supplied', async () => {
    vi.mocked(settingsAPI.searchLocation).mockResolvedValue({ data: { results: [{
      name: 'Hobart', admin1: 'Tasmania', country: 'Australia', countryCode: 'AU',
      lat: -42.87936, lng: 147.3294, timezone: 'Australia/Hobart', population: 252639,
      source: 'open-meteo', displayName: 'Hobart, Tasmania, Australia',
    }] } } as never);
    render(<SettingsPage />);

    fireEvent.change(screen.getByLabelText('Search for your city'), { target: { value: 'Hobart' } });
    await act(async () => { vi.advanceTimersByTime(301); });

    expect(screen.getByText('Population 252,639')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open-Meteo' })).toHaveAttribute('href', 'https://open-meteo.com/');
  });

  it('shows Geoapify and OpenStreetMap attribution without an empty population label', async () => {
    vi.mocked(settingsAPI.searchLocation).mockResolvedValue({ data: { results: [{
      name: 'Hobart', admin1: 'Tasmania', country: 'Australia', countryCode: 'AU',
      lat: -42.8825088, lng: 147.3281233, timezone: null, population: null,
      source: 'geoapify', displayName: 'Hobart, Tasmania, Australia',
    }] } } as never);
    render(<SettingsPage />);

    fireEvent.change(screen.getByLabelText('Search for your city'), { target: { value: 'Hobart' } });
    await act(async () => { vi.advanceTimersByTime(301); });

    expect(screen.queryByText(/Population/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Powered by Geoapify' })).toHaveAttribute('href', 'https://www.geoapify.com/');
    expect(screen.getByRole('link', { name: '© OpenStreetMap contributors' })).toHaveAttribute(
      'href',
      'https://www.openstreetmap.org/copyright',
    );
  });

  it('persists a selected location and updates the active church timezone', async () => {
    vi.mocked(settingsAPI.searchLocation).mockResolvedValue({
      data: { results: [{
        name: 'Hobart', admin1: 'Tasmania', country: 'Australia', countryCode: 'AU',
        lat: -42.8821, lng: 147.3272, timezone: 'Australia/Hobart',
        displayName: 'Hobart, Tasmania, Australia',
      }] },
    } as never);
    vi.mocked(settingsAPI.updateLocation).mockResolvedValue({
      data: { location: {
        name: 'Hobart, Tasmania, Australia', lat: -42.8821, lng: 147.3272, timezone: 'Australia/Hobart',
      } },
    } as never);
    render(<SettingsPage />);

    fireEvent.change(screen.getByLabelText('Search for your city'), { target: { value: 'Hobart' } });
    await act(async () => {
      vi.advanceTimersByTime(301);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Hobart/ }));
      await Promise.resolve();
    });

    expect(settingsAPI.updateLocation).toHaveBeenCalledWith({
      name: 'Hobart, Tasmania, Australia', lat: -42.8821, lng: 147.3272,
    });
    expect(updateUser).toHaveBeenCalledWith({ timezone: 'Australia/Hobart' });
  });
});
