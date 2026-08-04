import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OnboardingPage from './OnboardingPage';

const { createPlanningCenterSyncBatch } = vi.hoisted(() => ({
  createPlanningCenterSyncBatch: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ login: vi.fn(), refreshOnboardingStatus: vi.fn(), updateUser: vi.fn(), user: null }),
}));
vi.mock('../services/api', () => ({
  authAPI: {},
  onboardingAPI: {},
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
});
