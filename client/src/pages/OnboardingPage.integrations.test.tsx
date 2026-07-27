import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authAPI, integrationsAPI, onboardingAPI } from '../services/api';
import OnboardingPage from './OnboardingPage';

const navigate = vi.fn();
const authState = {
  login: vi.fn(), refreshOnboardingStatus: vi.fn(), updateUser: vi.fn(),
  user: { id: 1, email: 'admin@example.com', isFirstLogin: true },
};

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

vi.mock('../contexts/AuthContext', () => ({ useAuth: () => authState }));
vi.mock('../services/api', () => ({
  authAPI: { requestCode: vi.fn(), verifyCode: vi.fn() },
  onboardingAPI: { saveChurchInfo: vi.fn(), complete: vi.fn() },
  integrationsAPI: { authorizePlanningCenter: vi.fn() },
  elvantoSyncAPI: {}, peopleSyncAPI: {}, gatheringsAPI: {},
}));

async function reachChoosePath() {
  render(<OnboardingPage />);
  fireEvent.change(screen.getByPlaceholderText('e.g. Sunday Community Group'), { target: { value: 'Example Church' } });
  fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'admin@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create and send code' }));
  fireEvent.change(await screen.findByPlaceholderText('000000'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify & continue' }));
  await screen.findByText('Bring your people with you');
}

describe('OnboardingPage integration choices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/app/onboarding');
    vi.mocked(authAPI.requestCode).mockResolvedValue({ data: {} } as never);
    vi.mocked(authAPI.verifyCode).mockResolvedValue({ data: { token: 'token', user: authState.user } } as never);
    vi.mocked(onboardingAPI.saveChurchInfo).mockResolvedValue({ data: {} } as never);
    vi.mocked(onboardingAPI.complete).mockResolvedValue({ data: {} } as never);
    vi.mocked(integrationsAPI.authorizePlanningCenter).mockResolvedValue({ data: { authUrl: '#pco-oauth' } } as never);
  });

  it('offers Planning Center, Elvanto, and Start fresh at choose-path', async () => {
    await reachChoosePath();
    expect(screen.getByRole('button', { name: /Planning Center/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Elvanto/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start fresh' })).toBeInTheDocument();
  });

  it('retains the Planning Center OAuth flow', async () => {
    await reachChoosePath();
    fireEvent.click(screen.getByRole('button', { name: /Planning Center/i }));
    await waitFor(() => expect(integrationsAPI.authorizePlanningCenter).toHaveBeenCalledWith('/app/onboarding'));
    expect(window.location.hash).toBe('#pco-oauth');
  });

  it('enters Elvanto connection without using a blind import path', async () => {
    await reachChoosePath();
    fireEvent.click(screen.getByRole('button', { name: /Elvanto/i }));
    expect(await screen.findByLabelText('Elvanto API key')).toBeInTheDocument();
    expect(screen.queryByText(/select people to import/i)).not.toBeInTheDocument();
  });

  it('keeps Start fresh completion unchanged', async () => {
    await reachChoosePath();
    fireEvent.click(screen.getByRole('button', { name: 'Start fresh' }));
    expect(navigate).toHaveBeenCalledWith('/app/gatherings');
  });
});
