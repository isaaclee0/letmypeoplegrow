import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';
import { onboardingAPI } from '../services/api';

const { getCurrentUser, getMyChurches } = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getMyChurches: vi.fn(),
}));

vi.mock('../services/api', () => ({
  authAPI: { getCurrentUser, getMyChurches, logout: vi.fn(), refreshToken: vi.fn(), switchChurch: vi.fn() },
  onboardingAPI: { getStatus: vi.fn() },
}));

function TimeZoneConsumer() {
  const { user } = useAuth();
  return <output>{user?.timezone || 'loading'}</output>;
}

describe('AuthContext', () => {
  beforeEach(() => {
    localStorage.clear();
    getCurrentUser.mockResolvedValue({
      data: {
        user: {
          id: 1,
          primaryContactMethod: 'email',
          role: 'coordinator',
          firstName: 'Time',
          lastName: 'Zone',
          timezone: 'Australia/Hobart',
          gatheringAssignments: [],
        },
      },
    });
    getMyChurches.mockResolvedValue({ data: { churches: [] } });
  });

  it('exposes the server-provided church timezone after authentication refresh', async () => {
    render(<AuthProvider><TimeZoneConsumer /></AuthProvider>);

    await waitFor(() => expect(screen.getByText('Australia/Hobart')).toBeInTheDocument());
  });

  it('allows strict refresh callers to handle network failures', async () => {
    const admin = { id: 2, role: 'admin', timezone: 'Australia/Hobart', isChurchApproved: true };
    getCurrentUser.mockResolvedValue({ data: { user: admin } });
    vi.mocked(onboardingAPI.getStatus).mockResolvedValue({ data: { guided: { required: false } } } as never);
    let context: ReturnType<typeof useAuth> | undefined;
    function Consumer() {
      context = useAuth();
      return <output>{context.isLoading ? 'loading' : 'ready'}</output>;
    }
    render(<AuthProvider><Consumer /></AuthProvider>);
    await screen.findByText('ready');
    const outage = new Error('Temporarily offline');
    getCurrentUser.mockRejectedValueOnce(outage);
    vi.mocked(onboardingAPI.getStatus).mockRejectedValueOnce(outage);
    await act(async () => {
      await expect(context?.refreshUserData(true)).rejects.toThrow(outage);
      await expect(context?.refreshOnboardingStatus(true)).rejects.toThrow(outage);
    });
  });
});
