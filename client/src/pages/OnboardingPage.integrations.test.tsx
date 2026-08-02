import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OnboardingPage from './OnboardingPage';

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ login: vi.fn(), refreshOnboardingStatus: vi.fn(), updateUser: vi.fn(), user: null }),
}));
vi.mock('../services/api', () => ({
  authAPI: {},
  onboardingAPI: {},
  integrationsAPI: {
    getCheckinAvailability: vi.fn().mockResolvedValue({
      data: { available: true, hasImported: false, peopleLinked: true },
    }),
  },
}));
vi.mock('../components/planningCenter/PlanningCenterBatchEditor', () => ({
  default: ({ onSaved }: { onSaved: (batch: { id: number; name: string; draftSource: { name: string } }) => void }) => (
    <button type="button" onClick={() => onSaved({
      id: 91,
      name: 'Members',
      draftSource: { name: 'Selected members' },
    })}>Create source batch</button>
  ),
}));
vi.mock('../components/planningCenter/PlanningCenterSyncReview', () => ({
  default: ({ batchName, sourceName, onApplied }: {
    batchName?: string;
    sourceName?: string;
    onApplied?: () => void | Promise<void>;
  }) => (
    <div>
      <p>Planning Center sync review</p>
      <p>{batchName} · {sourceName}</p>
      <button type="button" onClick={() => void onApplied?.()}>Apply onboarding sync</button>
    </div>
  ),
}));
vi.mock('../components/elvanto/ElvantoOnboarding', () => ({ default: () => null }));

describe('OnboardingPage provider-owned source review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/app/onboarding?pco=connected');
  });

  it('describes the first Planning Center review as promoting the selected List source', async () => {
    render(<MemoryRouter><OnboardingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Create source batch' }));
    expect(await screen.findByText(/Review Planning Center's selected List/)).toBeInTheDocument();
    expect(screen.getByText(/promotes the proposed people source/)).toBeInTheDocument();
    expect(screen.getByText('Members · Selected members')).toBeInTheDocument();
  });

  it('keeps the compatibility review solely in onboarding and advances after its bottom apply', async () => {
    render(<MemoryRouter><OnboardingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Create source batch' }));

    expect(await screen.findByText('Planning Center sync review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply onboarding sync' }));

    expect(await screen.findByText(/Create your gatherings from Planning Center events/)).toBeInTheDocument();
  });
});
