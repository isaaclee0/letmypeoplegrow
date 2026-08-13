import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OnboardingPage from './OnboardingPage';

const { createPlanningCenterSyncBatch, requestCode, verifyCode, saveChurchInfo, complete } = vi.hoisted(() => ({
  createPlanningCenterSyncBatch: vi.fn(),
  requestCode: vi.fn(),
  verifyCode: vi.fn(),
  saveChurchInfo: vi.fn(),
  complete: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ login: vi.fn(), refreshOnboardingStatus: vi.fn(), updateUser: vi.fn(), user: null }),
}));
vi.mock('../services/api', () => ({
  authAPI: { requestCode, verifyCode },
  onboardingAPI: { saveChurchInfo, complete },
  integrationsAPI: {
    createPlanningCenterSyncBatch,
    getCheckinAvailability: vi.fn().mockResolvedValue({
      data: { available: true, hasImported: false, peopleLinked: true },
    }),
  },
}));
vi.mock('../components/peopleImport/OnboardingPeopleImport', () => ({
  default: ({ provider, onComplete, onSkip }: {
    provider: string;
    onComplete: () => void;
    onSkip: () => void;
  }) => (
    <section aria-label={`${provider} one-time import`}>
      <p>One-time {provider} people import</p>
      <button type="button" onClick={onComplete}>Complete one-time import</button>
      <button type="button" onClick={onSkip}>Skip one-time import</button>
    </section>
  ),
}));
vi.mock('../components/planningCenter/PlanningCenterBatchEditor', () => ({
  default: () => <p>Old Planning Center batch editor</p>,
}));
vi.mock('../components/planningCenter/PlanningCenterSyncReview', () => ({
  default: () => <p>Old Planning Center sync review</p>,
}));
vi.mock('../components/elvanto/ElvantoOnboarding', () => ({ default: () => null }));

describe('OnboardingPage one-time Planning Center import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/app/onboarding?pco=connected');
  });

  it('renders the one-time import after OAuth and advances to check-ins after apply', async () => {
    render(<MemoryRouter><OnboardingPage /></MemoryRouter>);

    expect(await screen.findByText('One-time planning_center people import')).toBeInTheDocument();
    expect(screen.queryByText(/sync review/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/source of truth/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Complete one-time import' }));

    expect(await screen.findByText(/Create your gatherings from Planning Center events/)).toBeInTheDocument();
    expect(createPlanningCenterSyncBatch).not.toHaveBeenCalled();
  });

  it('keeps skip and advances to the existing check-in path without creating a batch', async () => {
    render(<MemoryRouter><OnboardingPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Skip one-time import' }));

    expect(await screen.findByText(/Create your gatherings from Planning Center events/)).toBeInTheDocument();
    expect(createPlanningCenterSyncBatch).not.toHaveBeenCalled();
  });

  it('does not send a browser timezone when a selected location supplies coordinates', async () => {
    window.history.replaceState({}, '', '/app/onboarding');
    requestCode.mockResolvedValue({});
    verifyCode.mockResolvedValue({ data: { token: 'token', user: {} } });
    saveChurchInfo.mockResolvedValue({});
    complete.mockResolvedValue({});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ results: [{
        name: 'Hobart', admin1: 'Tasmania', country: 'Australia', country_code: 'AU',
        latitude: -42.8821, longitude: 147.3272, timezone: 'Australia/Hobart',
      }] }),
    }));
    render(<MemoryRouter><OnboardingPage /></MemoryRouter>);

    fireEvent.change(screen.getByPlaceholderText('Search for your city...'), { target: { value: 'Hobart' } });
    await new Promise((resolve) => setTimeout(resolve, 350));
    fireEvent.click(await screen.findByRole('button', { name: /Hobart/ }));
    fireEvent.change(screen.getByPlaceholderText('e.g. Sunday Community Group'), { target: { value: 'Hobart Church' } });
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'admin@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and send code' }));
    await screen.findByPlaceholderText('000000');
    fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify & continue' }));

    await screen.findByText('Bring your people with you');
    expect(saveChurchInfo).toHaveBeenCalledWith(expect.objectContaining({
      locationName: 'Hobart, Tasmania, Australia', locationLat: -42.8821, locationLng: 147.3272,
    }));
    expect(saveChurchInfo).not.toHaveBeenCalledWith(expect.objectContaining({ timezone: 'Australia/Sydney' }));
  });
});
