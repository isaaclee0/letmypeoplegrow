import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';

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
});
