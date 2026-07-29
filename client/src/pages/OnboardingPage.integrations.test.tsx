import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import OnboardingPage from './OnboardingPage';

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ login: vi.fn(), refreshOnboardingStatus: vi.fn(), updateUser: vi.fn(), user: null }),
}));
vi.mock('../services/api', () => ({ authAPI: {}, onboardingAPI: {}, integrationsAPI: {} }));
vi.mock('../components/planningCenter/PlanningCenterBatchEditor', () => ({
  default: ({ onSaved }: { onSaved: (batch: { id: number }) => void }) => (
    <button type="button" onClick={() => onSaved({ id: 91 })}>Create source batch</button>
  ),
}));
vi.mock('../components/planningCenter/PlanningCenterSyncReview', () => ({ default: () => <div>Planning Center sync review</div> }));
vi.mock('../components/elvanto/ElvantoOnboarding', () => ({ default: () => null }));

describe('OnboardingPage provider-owned source review', () => {
  it('describes the first Planning Center review as promoting the selected List source', async () => {
    window.history.replaceState({}, '', '/app/onboarding?pco=connected');
    render(<MemoryRouter><OnboardingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Create source batch' }));
    expect(await screen.findByText(/Review Planning Center's selected List/)).toBeInTheDocument();
    expect(screen.getByText(/promotes the proposed people source/)).toBeInTheDocument();
  });
});
